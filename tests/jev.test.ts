import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { createJevClassifier } from "../src/classify/jev.ts";
import { ClassifierError } from "../src/types.ts";
import type { Answers, JevBackendConfig, Questions } from "../src/types.ts";

const TOKEN_VAR = "CLASS_ROUTER_TEST_JEV_TOKEN";
const TOKEN = "s3cret-test-token";
const MISSING_VAR = "CLASS_ROUTER_TEST_JEV_MISSING";
delete process.env[MISSING_VAR];

const QUESTIONS: Questions = {
  primary: {
    type: "choice",
    instructions: "Which model should answer?",
    criteria: { fast: "a cheap model", deep: "the slowest, smartest model" },
  },
};

const ANSWERS: Answers = {
  primary: { type: "choice", choice: "fast", probabilities: { fast: 0.91, deep: 0.09 }, confidence: 0.91 },
};

interface Captured {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const captured: Captured[] = [];
const sockets = new Set<Socket>();

const server = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    captured.push({ url: request.url ?? "", headers: request.headers, body });

    switch (request.url) {
      case "/ok": {
        response.writeHead(200, { "Content-Type": "application/json" });
        // `extra` proves unknown fields are dropped rather than passed through.
        response.end(
          JSON.stringify({
            model: "jev-stub",
            answers: ANSWERS,
            usage: { input_tokens: 7, output_tokens: 3 },
            extra: true,
          }),
        );
        return;
      }
      case "/unauthorized":
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "bad token" }));
        return;
      case "/forbidden":
        response.writeHead(403);
        response.end("nope");
        return;
      case "/boom":
        response.writeHead(500);
        response.end("upstream exploded");
        return;
      case "/garbage":
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("this is not json");
        return;
      case "/no-answers":
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ model: "jev-stub", answers: [] }));
        return;
      case "/slow":
        // Deliberately never responds; the client must abort on its own timer.
        return;
      default:
        response.writeHead(404);
        response.end();
    }
  });
});

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

let endpoint = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function config(path: string, timeoutMs = 2000): JevBackendConfig {
  return { endpoint: `${endpoint}${path}`, model: "jev-test-model", apiKeyEnvVar: TOKEN_VAR, timeoutMs };
}

function classifier(path: string, timeoutMs = 2000) {
  return createJevClassifier(config(path, timeoutMs), { env: { [TOKEN_VAR]: TOKEN } });
}

async function rejection(promise: Promise<unknown>, code: string): Promise<ClassifierError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ClassifierError, `expected ClassifierError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.backend, "jev");
    return error;
  }
  throw new assert.AssertionError({ message: `expected rejection with code ${code}` });
}

test("posts the configured model and questions verbatim, with bearer auth", async () => {
  const jev = classifier("/ok");
  assert.equal(jev.name, "jev");

  const result = await jev.classify("hello world", QUESTIONS);
  await jev.dispose();

  const sent = captured.at(-1);
  assert.ok(sent, "server captured no request");
  assert.equal(sent.headers["authorization"], `Bearer ${TOKEN}`);
  assert.match(String(sent.headers["content-type"]), /application\/json/);
  assert.deepEqual(JSON.parse(sent.body), { state: "hello world", model: "jev-test-model", questions: QUESTIONS });

  assert.deepEqual(result.answers, ANSWERS);
  assert.equal(result.model, "jev-stub");
  assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 3 });
  assert.equal("extra" in result, false);
});

test("accepts structured state documents", async () => {
  const jev = classifier("/ok");
  const state = { prompt: "hello", history: ["a", "b"] };
  const result = await jev.classify(state, QUESTIONS);
  await jev.dispose();

  assert.deepEqual(JSON.parse(captured.at(-1)!.body).state, state);
  assert.deepEqual(result.answers, ANSWERS);
});

test("warmup and dispose never touch the network", async () => {
  const jev = classifier("/ok");
  const before = captured.length;
  await jev.warmup?.();
  await jev.dispose();
  await jev.dispose();
  assert.equal(captured.length, before);
});

test("maps 401 and 403 to auth", async () => {
  const unauthorized = await rejection(classifier("/unauthorized").classify("x", QUESTIONS), "auth");
  assert.match(unauthorized.message, /401/);
  await rejection(classifier("/forbidden").classify("x", QUESTIONS), "auth");
});

test("maps 500 to unavailable and reports the status", async () => {
  const error = await rejection(classifier("/boom").classify("x", QUESTIONS), "unavailable");
  assert.match(error.message, /500/);
});

test("maps a non-JSON body to protocol", async () => {
  await rejection(classifier("/garbage").classify("x", QUESTIONS), "protocol");
});

test("maps a non-object answers field to protocol", async () => {
  await rejection(classifier("/no-answers").classify("x", QUESTIONS), "protocol");
});

test("aborts a slow endpoint with timeout", async () => {
  const error = await rejection(classifier("/slow", 120).classify("x", QUESTIONS), "timeout");
  assert.match(error.message, /120ms/);
});

test("a caller abort wins over the timeout budget", async () => {
  const controller = new AbortController();
  const pending = classifier("/slow", 5000).classify("x", QUESTIONS, { signal: controller.signal });
  controller.abort();
  await rejection(pending, "aborted");
});

test("an unset token variable makes jev unavailable without a request", async () => {
  const jev = createJevClassifier(
    { endpoint: `${endpoint}/ok`, model: "jev-test-model", apiKeyEnvVar: MISSING_VAR, timeoutMs: 2000 },
    { env: {} },
  );
  const before = captured.length;
  const error = await rejection(jev.classify("x", QUESTIONS), "unavailable");
  assert.match(error.message, new RegExp(MISSING_VAR));
  assert.equal(captured.length, before);
});
