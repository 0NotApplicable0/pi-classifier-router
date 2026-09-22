/**
 * Tests for the shared System-One HTTP client and the Laya http transport.
 *
 * A `node:http` stub server on port 0 stands in for a remote GPU host: no real
 * network, no real key. Every server and socket is torn down so the file is
 * suite-safe.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { createClassifier, type LayaSpawn } from "../src/classify/index.ts";
import { createHttpClassifier } from "../src/classify/http.ts";
import { createLayaHttpClassifier } from "../src/classify/laya-http.ts";
import { defaultConfig } from "../src/config.ts";
import { ClassifierError } from "../src/types.ts";
import type { Answers, LayaBackendConfig, Questions, RouterConfig } from "../src/types.ts";

const TOKEN_VAR = "CLASS_ROUTER_TEST_LAYAA_HTTP_TOKEN";
const TOKEN = "s3cret-laya-token";
const MISSING_VAR = "CLASS_ROUTER_TEST_LAYAA_HTTP_MISSING";
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
  method: string | undefined;
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
    captured.push({ method: request.method, url: request.url ?? "", headers: request.headers, body });

    switch (request.url) {
      case "/ok": {
        response.writeHead(200, { "Content-Type": "application/json" });
        // `extra` proves unknown fields are dropped rather than passed through.
        response.end(
          JSON.stringify({
            model: "laya-stub",
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
      case "/throttled":
        response.writeHead(429);
        response.end("slow down");
        return;
      case "/garbage":
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("this is not json");
        return;
      case "/no-answers":
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ model: "laya-stub", answers: [] }));
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

function layaConfig(path: string, apiKeyEnvVar = "", timeoutMs = 2000): LayaBackendConfig {
  return {
    transport: "http",
    endpoint: `${endpoint}${path}`,
    apiKeyEnvVar,
    pythonBin: "python3",
    workerScript: "python/laya_worker.py",
    repo: "convaiinnovations/laya",
    subfolder: null,
    device: null,
    router: true,
    preload: true,
    timeoutMs,
    warmupTimeoutMs: 3000,
    hfTokenEnvVar: "HF_TOKEN",
  };
}

async function rejection(promise: Promise<unknown>, code: string, backend = "laya"): Promise<ClassifierError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ClassifierError, `expected ClassifierError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.backend, backend);
    return error;
  }
  throw new assert.AssertionError({ message: `expected rejection with code ${code}` });
}

test("classifies through the http transport, passing questions through unchanged", async () => {
  const laya = createLayaHttpClassifier(layaConfig("/ok"), { env: {} });
  assert.equal(laya.name, "laya");

  const result = await laya.classify("hello world", QUESTIONS);
  await laya.dispose();

  const sent = captured.at(-1);
  assert.ok(sent, "server captured no request");
  assert.equal(sent.method, "POST");
  assert.equal(sent.url, "/ok");
  assert.match(String(sent.headers["content-type"]), /application\/json/);
  const body = JSON.parse(sent.body) as Record<string, unknown>;
  assert.equal(body["state"], "hello world");
  assert.deepEqual(body["questions"], QUESTIONS);
  // The remote host owns checkpoint selection, so laya sends no `model`.
  assert.equal("model" in body, false);

  assert.deepEqual(result.answers, ANSWERS);
  assert.equal(result.model, "laya-stub");
  assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 3 });
  assert.equal("extra" in result, false);
});

test("includes the model field only when one is configured", async () => {
  const withoutModel = createHttpClassifier(
    { name: "laya", endpoint: `${endpoint}/ok`, model: null, apiKeyEnvVar: "", timeoutMs: 2000 },
    { env: {} },
  );
  await withoutModel.classify("x", QUESTIONS);
  const omitted = JSON.parse(captured.at(-1)!.body) as Record<string, unknown>;
  assert.equal("model" in omitted, false);

  const withModel = createHttpClassifier(
    { name: "laya", endpoint: `${endpoint}/ok`, model: "laya-model-x", apiKeyEnvVar: "", timeoutMs: 2000 },
    { env: {} },
  );
  await withModel.classify("x", QUESTIONS);
  const present = JSON.parse(captured.at(-1)!.body) as Record<string, unknown>;
  assert.equal(present["model"], "laya-model-x");
});

test("sends no Authorization header when apiKeyEnvVar is unset or blank", async () => {
  const unset = createHttpClassifier(
    { name: "laya", endpoint: `${endpoint}/ok`, model: null, apiKeyEnvVar: "", timeoutMs: 2000 },
    { env: {} },
  );
  await unset.classify("x", QUESTIONS);
  assert.equal("authorization" in captured.at(-1)!.headers, false);

  const blank = createHttpClassifier(
    { name: "laya", endpoint: `${endpoint}/ok`, model: null, apiKeyEnvVar: "   ", timeoutMs: 2000 },
    { env: {} },
  );
  await blank.classify("x", QUESTIONS);
  assert.equal("authorization" in captured.at(-1)!.headers, false);
});

test("sends a bearer header when a token is configured", async () => {
  const laya = createLayaHttpClassifier(layaConfig("/ok", TOKEN_VAR), { env: { [TOKEN_VAR]: TOKEN } });
  await laya.classify("x", QUESTIONS);
  assert.equal(captured.at(-1)!.headers["authorization"], `Bearer ${TOKEN}`);
});

test("a configured but missing token variable is unavailable without a request", async () => {
  const laya = createLayaHttpClassifier(layaConfig("/ok", MISSING_VAR), { env: {} });
  const before = captured.length;
  const error = await rejection(laya.classify("x", QUESTIONS), "unavailable");
  assert.match(error.message, new RegExp(MISSING_VAR));
  assert.equal(captured.length, before);
});

test("maps 401 and 403 to auth", async () => {
  const unauthorized = await rejection(
    createLayaHttpClassifier(layaConfig("/unauthorized"), { env: {} }).classify("x", QUESTIONS),
    "auth",
  );
  assert.match(unauthorized.message, /401/);
  await rejection(
    createLayaHttpClassifier(layaConfig("/forbidden"), { env: {} }).classify("x", QUESTIONS),
    "auth",
  );
});

test("maps 429 to unavailable and reports the status", async () => {
  const error = await rejection(
    createLayaHttpClassifier(layaConfig("/throttled"), { env: {} }).classify("x", QUESTIONS),
    "unavailable",
  );
  assert.match(error.message, /429/);
});

test("an unreachable endpoint is a transport failure", async () => {
  const dead = http.createServer();
  await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
  const deadPort = (dead.address() as AddressInfo).port;
  await new Promise<void>((resolve) => dead.close(() => resolve()));

  const error = await rejection(
    createHttpClassifier(
      { name: "laya", endpoint: `http://127.0.0.1:${deadPort}/ok`, model: null, apiKeyEnvVar: "", timeoutMs: 2000 },
      { env: {} },
    ).classify("x", QUESTIONS),
    "transport",
  );
  assert.match(error.message, /laya request failed/);
});

test("maps a malformed answer body to protocol", async () => {
  await rejection(
    createLayaHttpClassifier(layaConfig("/garbage"), { env: {} }).classify("x", QUESTIONS),
    "protocol",
  );
  await rejection(
    createLayaHttpClassifier(layaConfig("/no-answers"), { env: {} }).classify("x", QUESTIONS),
    "protocol",
  );
});

test("createClassifier uses the http transport without spawning a child process", async () => {
  const spawnCalls: string[] = [];
  const blockedSpawn: LayaSpawn = (command) => {
    spawnCalls.push(command);
    throw new Error("spawn blocked by test");
  };

  const config: RouterConfig = defaultConfig();
  config.backend = "laya";
  config.laya.transport = "http";
  config.laya.endpoint = `${endpoint}/ok`;
  config.laya.apiKeyEnvVar = "";

  const classifier = createClassifier(config, { spawnImpl: blockedSpawn, env: {} });
  assert.equal(classifier.name, "laya");

  const result = await classifier.classify("hello", QUESTIONS);
  await classifier.dispose();

  assert.deepEqual(result.answers, ANSWERS);
  assert.deepEqual(spawnCalls, []);
  const sent = captured.at(-1)!;
  assert.equal(sent.url, "/ok");
  assert.equal("model" in JSON.parse(sent.body), false);
});

test("createClassifier still uses the python sidecar for the python transport", async () => {
  const spawnCalls: string[] = [];
  const blockedSpawn: LayaSpawn = (command) => {
    spawnCalls.push(command);
    throw new Error("spawn blocked by test");
  };

  const config: RouterConfig = defaultConfig();
  config.backend = "laya";

  const classifier = createClassifier(config, { spawnImpl: blockedSpawn, env: {} });
  assert.equal(classifier.name, "laya");

  const error = await rejection(classifier.classify("x", QUESTIONS), "unavailable");
  assert.match(error.message, /could not spawn laya worker/);
  assert.equal(spawnCalls.length, 1);
});
