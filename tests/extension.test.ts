/**
 * End-to-end tests for the class-router extension factory.
 *
 * Each test drives the REAL `classRouter` factory through a fake `ExtensionAPI`
 * and a temp project directory whose `.omp/class-router.json` points at an
 * in-process Jev stub. The extension constructs its classifier with the real
 * `createClassifier` (no injection seam exists through the factory), so the
 * only way to observe backend behaviour is to speak the real wire protocol.
 *
 * Isolation: every test uses a unique session id, a unique project dir, and a
 * unique circuit-breaker config, because config, sessions, and the breaker are
 * cached process-wide by the extension.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import classRouter, { classifyFailure } from "../src/index.ts";
import { defaultConfig } from "../src/config.ts";
import type { Answers } from "../src/types.ts";
import { createFakePi, type FakeModel, type FakePi, type FakePiOptions } from "./fixtures/fake-pi.ts";
import { startStubJevServer, type JevStubReply, type StubJevServer } from "./fixtures/stub_jev_server.ts";

const TOKEN_VAR = "TYPESAFE_API_KEY";
const TOKEN = "stub-token-never-real";
process.env[TOKEN_VAR] = TOKEN;

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** A distinct breaker per test, so the process-wide cache never leaks state. */
function nextBreaker(overrides: Record<string, number> = {}): Record<string, number> {
  return { failureThreshold: 3, cooldownMs: 600_000 + seq, halfOpenMaxTrials: 1, ...overrides };
}

const MODELS: Record<string, FakeModel> = {
  "@smol": { id: "smol-model", provider: "test" },
  "@default": { id: "default-model", provider: "test" },
  "@slow": { id: "slow-model", provider: "test" },
};

function choice(choiceId: string, confidence: number): Answers {
  return {
    task_complexity: {
      type: "choice",
      choice: choiceId,
      probabilities: { trivial: 0.02, standard: 0.06, hard: 0.92 },
      confidence,
    },
  };
}

interface Harness {
  cwd: string;
  stub: StubJevServer;
  fake: FakePi;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  notifications(): string[];
  decisions(): Array<Record<string, unknown>>;
  cleanup(): Promise<void>;
}

interface HarnessOptions extends FakePiOptions {
  setModelResult?: boolean;
}

async function harness(
  reply: JevStubReply,
  buildConfig: (stubUrl: string) => Record<string, unknown>,
  options: HarnessOptions = {},
): Promise<Harness> {
  const stub = await startStubJevServer(reply);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-classifier-router-"));
  fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".omp", "class-router.json"), JSON.stringify(buildConfig(stub.url), null, 2));

  const fake = createFakePi({
    cwd,
    sessionId: options.sessionId ?? unique("session"),
    sessionFile: options.sessionFile ?? null,
    resolve: options.resolve ?? MODELS,
    current: options.current ?? { id: "session-default-model", provider: "test" },
    setModelResult: options.setModelResult ?? true,
    host: options.host,
    list: options.list,
  });

  classRouter(fake.pi as unknown as ExtensionAPI);

  return {
    cwd,
    stub,
    fake,
    pi: fake.pi as unknown as ExtensionAPI,
    ctx: fake.ctx as unknown as ExtensionContext,
    notifications: () => fake.state.notifications.map((entry) => entry.message),
    decisions: () =>
      fake.state.entries
        .filter((entry) => entry.type === "class-router.decision")
        .map((entry) => entry.data as Record<string, unknown>),
    async cleanup() {
      await stub.close();
      fs.rmSync(cwd, { recursive: true, force: true });
    },
  };
}

/** Minimal config pointing the real extension at the stub server. */
function baseConfig(stubUrl: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    backend: "jev",
    jev: { endpoint: stubUrl, apiKeyEnvVar: TOKEN_VAR, timeoutMs: 2000 },
    circuitBreaker: nextBreaker(),
    notify: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Upstream-pi-shaped host
//
// The pi host has no `ctx.models` facade, so routing targets must be concrete
// `provider/id` specs that its `modelRegistry` can resolve; role aliases such
// as `@slow` are an omp-only convenience.
// ---------------------------------------------------------------------------

const PI_MODELS: FakeModel[] = [
  { id: "slow-model", provider: "test" },
  { id: "default-model", provider: "test" },
];

const PROMPT = "Refactor the entire auth subsystem across the repo";

/** A pi-shaped harness: no facade, no managed timers, no logger. */
function piHarness(
  reply: JevStubReply,
  buildConfig: (stubUrl: string) => Record<string, unknown>,
  options: HarnessOptions = {},
): Promise<Harness> {
  return harness(reply, buildConfig, { host: "pi", list: PI_MODELS, resolve: {}, ...options });
}

/** Config whose routing targets resolve through the registry, not the facade. */
function piConfig(stubUrl: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseConfig(stubUrl, {
    routing: {
      modelMapping: { hard: "test/slow-model" },
      fallbackChains: { "test/slow-model": ["test/slow-model", "test/default-model"] },
    },
    ...overrides,
  });
}

test("routes on an upstream-pi-shaped host with no facade and no managed timers", async () => {
  const h = await piHarness({ answers: choice("hard", 0.92) }, (url) => piConfig(url));
  try {
    assert.equal(h.fake.ctx.models, undefined, "the pi host must not expose a models facade");
    assert.equal(h.fake.ctx.setTimeout, undefined, "the pi host must not expose managed timers");
    assert.equal(h.fake.ctx.clearTimer, undefined);

    await h.fake.emit("before_agent_start", { prompt: PROMPT }, h.ctx);

    assert.deepEqual(h.fake.state.setModelCalls, [{ id: "slow-model", provider: "test" }]);
    assert.equal(h.stub.requests.length, 1);

    const decisions = h.decisions();
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!["reason"], "routed");
    assert.equal(decisions[0]!["category"], "hard");
    assert.equal(decisions[0]!["apply"], "test/slow-model");
  } finally {
    await h.cleanup();
  }
});

test("a missing pi.logger does not break routing or failure reporting", async () => {
  const h = await piHarness({ status: 500, answers: {} }, (url) => piConfig(url));
  try {
    assert.equal(h.fake.pi.logger, undefined);

    await h.fake.emit("before_agent_start", { prompt: PROMPT }, h.ctx);

    assert.equal(h.stub.requests.length, 1);
    assert.equal(h.fake.state.setModelCalls.length, 0);
    assert.ok(
      h.notifications().some((message) => message.includes("classification failed (unavailable)")),
      `expected an unavailable notification, got ${JSON.stringify(h.notifications())}`,
    );
  } finally {
    await h.cleanup();
  }
});

test("agent_end errors still open the circuit on the pi path", async () => {
  const h = await piHarness(
    { answers: choice("hard", 0.92) },
    (url) => piConfig(url, { circuitBreaker: nextBreaker({ failureThreshold: 3 }) }),
  );
  try {
    await h.fake.emit("before_agent_start", { prompt: PROMPT }, h.ctx);
    assert.deepEqual(h.fake.state.setModelCalls, [{ id: "slow-model", provider: "test" }]);

    // No auto_retry_start here: the pi host does not emit it, so agent_end alone
    // must carry the failure signal.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await h.fake.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] }, h.ctx);
    }

    await h.fake.emit("before_agent_start", { prompt: PROMPT }, h.ctx);

    assert.equal(h.fake.state.setModelCalls.length, 2);
    assert.equal(h.fake.state.setModelCalls[1]!.id, "default-model");
    const decisions = h.decisions();
    assert.equal(decisions.length, 2);
    assert.equal(decisions[1]!["reason"], "routed");
    assert.equal(decisions[1]!["apply"], "test/default-model");
  } finally {
    await h.cleanup();
  }
});

test("auto_retry_start on a host that does not emit it neither throws nor double-counts", async () => {
  const h = await piHarness(
    { answers: choice("hard", 0.92) },
    (url) => piConfig(url, { circuitBreaker: nextBreaker({ failureThreshold: 2 }) }),
  );
  try {
    await h.fake.emit("before_agent_start", { prompt: PROMPT }, h.ctx);
    await h.fake.emit(
      "auto_retry_start",
      { errorMessage: "429 Too Many Requests", attempt: 1, maxAttempts: 3, delayMs: 50 },
      h.ctx,
    );
    await h.fake.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] }, h.ctx);

    // Exactly one failure: had the unsupported event double-counted, this
    // threshold-2 circuit would already be open.
    const command = h.fake.commands.get("class-router");
    assert.ok(command, "class-router command was not registered");
    await command.handler("status", h.ctx);
    const breakerLine = h.notifications().filter((message) => message.includes("breaker: ")).at(-1) ?? "";
    assert.match(breakerLine, /test\/slow-model=closed\/1/);

    await h.fake.emit("before_agent_start", { prompt: PROMPT }, h.ctx);
    assert.equal(h.fake.state.setModelCalls.at(-1)?.id, "slow-model");
  } finally {
    await h.cleanup();
  }
});

test("auto_retry_start still drives attribution on the omp host", async () => {
  const h = await harness(
    { answers: choice("hard", 0.92) },
    (url) => baseConfig(url, { circuitBreaker: nextBreaker({ failureThreshold: 1 }) }),
  );
  try {
    assert.ok(h.fake.ctx.models, "the omp host must expose the models facade");

    await h.fake.emit("before_agent_start", { prompt: PROMPT }, h.ctx);
    assert.deepEqual(h.fake.state.setModelCalls, [{ id: "slow-model", provider: "test" }]);

    // A single retry failure, with no agent_end, is enough to open a threshold-1
    // circuit: only the omp auto_retry_start event can have attributed it.
    await h.fake.emit("auto_retry_start", { errorMessage: "429 Too Many Requests", attempt: 1 }, h.ctx);
    await h.fake.emit("before_agent_start", { prompt: PROMPT }, h.ctx);

    assert.equal(h.fake.state.setModelCalls.length, 2);
    assert.equal(h.fake.state.setModelCalls[1]!.id, "default-model");
    assert.equal(h.decisions()[1]!["apply"], "@default");
  } finally {
    await h.cleanup();
  }
});

test("routes a confident hard answer to the mapped model and records the decision", async () => {
  const h = await harness({ answers: choice("hard", 0.92) }, (url) => baseConfig(url));
  try {
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem across the repo" }, h.ctx);

    assert.deepEqual(h.fake.state.setModelCalls, [{ id: "slow-model", provider: "test" }]);

    const decisions = h.decisions();
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!["reason"], "routed");
    assert.equal(decisions[0]!["category"], "hard");
    assert.equal(decisions[0]!["apply"], "@slow");

    assert.equal(h.stub.requests.length, 1);
    const sent = h.stub.requests[0]!;
    assert.equal(sent.method, "POST");
    assert.equal(sent.headers["authorization"], `Bearer ${TOKEN}`);
    assert.deepEqual(sent.body, {
      state: "Refactor the entire auth subsystem across the repo",
      model: defaultConfig().jev.model,
      questions: defaultConfig().routing.questions,
    });
  } finally {
    await h.cleanup();
  }
});

test("dryRun classifies and appends a decision without ever calling setModel", async () => {
  const h = await harness({ answers: choice("hard", 0.92) }, (url) => baseConfig(url, { dryRun: true }));
  try {
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);

    assert.equal(h.stub.requests.length, 1);
    assert.equal(h.fake.state.setModelCalls.length, 0);
    const decisions = h.decisions();
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!["reason"], "routed");
    assert.equal(decisions[0]!["apply"], "@slow");
  } finally {
    await h.cleanup();
  }
});

test("enabled false never issues an HTTP request", async () => {
  const h = await harness({ answers: choice("hard", 0.92) }, (url) => baseConfig(url, { enabled: false }));
  try {
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);

    assert.equal(h.stub.requests.length, 0);
    assert.equal(h.fake.state.setModelCalls.length, 0);
    assert.equal(h.decisions().length, 0);
  } finally {
    await h.cleanup();
  }
});

test("a failing classifier never throws out of the handler and leaves the model alone", async () => {
  const h = await harness({ status: 500, answers: {} }, (url) => baseConfig(url));
  try {
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);

    assert.equal(h.stub.requests.length, 1);
    assert.equal(h.fake.state.setModelCalls.length, 0);
    assert.equal(h.decisions().length, 0);
    assert.ok(
      h.notifications().some((message) => message.includes("classification failed (unavailable)")),
      `expected an unavailable notification, got ${JSON.stringify(h.notifications())}`,
    );

    // A malformed body must degrade the same way, with a protocol code.
    h.stub.respond({ malformed: true });
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);
    assert.equal(h.stub.requests.length, 2);
    assert.equal(h.fake.state.setModelCalls.length, 0);
    assert.ok(h.notifications().some((message) => message.includes("classification failed (protocol)")));
  } finally {
    await h.cleanup();
  }
});

test("below-threshold confidence leaves the model alone but still reports the category", async () => {
  const h = await harness({ answers: choice("hard", 0.2) }, (url) => baseConfig(url));
  try {
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);

    assert.equal(h.fake.state.setModelCalls.length, 0);
    const decisions = h.decisions();
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!["reason"], "low-confidence");
    assert.equal(decisions[0]!["category"], "hard");
    assert.ok(
      h.notifications().some((message) => message.includes('"hard"')),
      `expected the reported category in a notification, got ${JSON.stringify(h.notifications())}`,
    );
  } finally {
    await h.cleanup();
  }
});

test("classifies work prompts but skips slash commands and empty prompts", async () => {
  const h = await harness({ answers: choice("hard", 0.92) }, (url) => baseConfig(url));
  try {
    await h.fake.emit("before_agent_start", { prompt: "/status" }, h.ctx);
    await h.fake.emit("before_agent_start", { prompt: "   " }, h.ctx);
    assert.equal(h.stub.requests.length, 0);
    assert.equal(h.fake.state.setModelCalls.length, 0);

    await h.fake.emit("before_agent_start", { prompt: "please fix the failing test" }, h.ctx);
    assert.equal(h.stub.requests.length, 1);
    assert.equal(h.fake.state.setModelCalls.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("setModel returning false records no breaker failure for the spec", async () => {
  const h = await harness(
    { answers: choice("hard", 0.92) },
    (url) => baseConfig(url, { circuitBreaker: nextBreaker({ failureThreshold: 1 }) }),
    { setModelResult: false },
  );
  try {
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);
    assert.equal(h.fake.state.setModelCalls.length, 1);
    assert.ok(h.notifications().some((message) => message.includes("no auth for @slow")));

    // A retry storm after a failed apply must not blame the unapplied spec.
    await h.fake.emit(
      "auto_retry_start",
      { errorMessage: "429 Too Many Requests", attempt: 1, maxAttempts: 3, delayMs: 50 },
      h.ctx,
    );

    // With auth now available the same spec must still be selected: a recorded
    // failure would have opened the threshold-1 circuit and forced @default.
    h.fake.setSetModelResult(true);
    h.fake.setCurrentModel({ id: "session-default-model", provider: "test" });
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);
    assert.equal(h.fake.state.setModelCalls.at(-1)?.id, "slow-model");
  } finally {
    await h.cleanup();
  }
});

test("repeated retry failures open the circuit and the next routing attempt falls back", async () => {
  const h = await harness(
    { answers: choice("hard", 0.92) },
    (url) => baseConfig(url, { circuitBreaker: nextBreaker({ failureThreshold: 3 }) }),
  );
  try {
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);
    assert.deepEqual(h.fake.state.setModelCalls, [{ id: "slow-model", provider: "test" }]);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await h.fake.emit(
        "auto_retry_start",
        { errorMessage: "429 Too Many Requests", attempt, maxAttempts: 3, delayMs: 50 },
        h.ctx,
      );
      await h.fake.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] }, h.ctx);
    }

    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);

    assert.equal(h.fake.state.setModelCalls.length, 2);
    assert.equal(h.fake.state.setModelCalls[1]!.id, "default-model");
    assert.equal(h.decisions().length, 2);
    assert.equal(h.decisions()[1]!["reason"], "routed");
    assert.equal(h.decisions()[1]!["apply"], "@default");
  } finally {
    await h.cleanup();
  }
});

test("an automatic continuation is neither a success nor a failure", async () => {
  const h = await harness(
    { answers: choice("hard", 0.92) },
    (url) => baseConfig(url, { circuitBreaker: nextBreaker({ failureThreshold: 1 }) }),
  );
  try {
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);
    const command = h.fake.commands.get("class-router");
    assert.ok(command, "class-router command was not registered");
    const breakerLine = () =>
      h.notifications()
        .filter((message) => message.includes("breaker: "))
        .at(-1) ?? "<no breaker line>";

    // A failing settle that is only an automatic continuation must not count.
    await h.fake.emit(
      "agent_end",
      { messages: [{ role: "assistant", stopReason: "error" }], willContinue: true },
      h.ctx,
    );
    await command.handler("status", h.ctx);
    assert.match(breakerLine(), /@slow=closed\/0/);

    // A successful automatic continuation must not close (reset) the circuit.
    await h.fake.emit("auto_retry_start", { errorMessage: "429 Too Many Requests", attempt: 1 }, h.ctx);
    await h.fake.emit(
      "agent_end",
      { messages: [{ role: "assistant", stopReason: "end" }], willContinue: true },
      h.ctx,
    );
    await command.handler("status", h.ctx);
    assert.match(breakerLine(), /@slow=open\/1/);

    // An explicit retry success still closes it, proving bookkeeping is live.
    await h.fake.emit("auto_retry_end", { success: true, attempt: 1 }, h.ctx);
    await command.handler("status", h.ctx);
    assert.match(breakerLine(), /@slow=closed\/0/);
  } finally {
    await h.cleanup();
  }
});

test("session_shutdown clears per-session state and the extension keeps working", async () => {
  const h = await harness({ answers: choice("hard", 0.92) }, (url) => baseConfig(url));
  try {
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);
    const command = h.fake.commands.get("class-router");
    assert.ok(command, "class-router command was not registered");

    await command.handler("status", h.ctx);
    assert.ok(h.notifications().some((message) => message.includes("last decision: hard")));

    await h.fake.emit("session_shutdown", { reason: "quit" }, h.ctx);

    const before = h.fake.state.notifications.length;
    await command.handler("status", h.ctx);
    const after = h.fake.state.notifications.slice(before).map((entry) => entry.message);
    assert.ok(
      after.some((message) => message.includes("last decision: none")),
      `expected a cleared session, got ${JSON.stringify(after)}`,
    );

    // The disposed classifier must be rebuilt transparently on the next turn.
    const requestsBefore = h.stub.requests.length;
    h.fake.setCurrentModel({ id: "session-default-model", provider: "test" });
    await h.fake.emit("session_start", { reason: "startup" }, h.ctx);
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);
    assert.equal(h.stub.requests.length, requestsBefore + 1);
    assert.equal(h.fake.state.setModelCalls.length, 2);
  } finally {
    await h.cleanup();
  }
});

test("applyTo main leaves subagent sessions on their own model", async () => {
  const h = await harness({ answers: choice("hard", 0.92) }, (url) => baseConfig(url, { applyTo: "main" }), {
    sessionFile: "/tmp/virtual/omp-task-deadbeef/session.jsonl",
  });
  try {
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);
    assert.equal(h.stub.requests.length, 0);
    assert.equal(h.fake.state.setModelCalls.length, 0);

    h.fake.setSessionFile(null);
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);
    assert.equal(h.stub.requests.length, 1);
    assert.equal(h.fake.state.setModelCalls.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("the /class-router command toggles routing, reports status, and lists subcommands", async () => {
  const h = await harness({ answers: choice("hard", 0.92) }, (url) => baseConfig(url));
  try {
    const command = h.fake.commands.get("class-router");
    assert.ok(command, "class-router command was not registered");

    await command.handler("status", h.ctx);
    assert.ok(h.notifications().some((message) => message.includes("enabled")));
    assert.ok(h.notifications().some((message) => message.includes("config source:")));
    assert.ok(h.notifications().some((message) => message.includes("last decision: none")));

    await command.handler("off", h.ctx);
    assert.ok(h.notifications().some((message) => message.includes("routing disabled")));
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);
    assert.equal(h.stub.requests.length, 0);

    await command.handler("on", h.ctx);
    assert.ok(h.notifications().some((message) => message.includes("routing enabled")));
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);
    assert.equal(h.stub.requests.length, 1);

    await command.handler("reset", h.ctx);
    assert.ok(h.notifications().some((message) => message.includes("circuit breaker reset")));

    await command.handler("explain", h.ctx);
    assert.ok(h.notifications().some((message) => message.includes("reason: routed")));
    assert.ok(h.notifications().some((message) => message.includes("chain: @slow -> @default")));

    await command.handler("bogus", h.ctx);
    assert.ok(
      h.notifications().some((message) => message.includes("valid: status, on, off, reset, explain")),
      `expected the subcommand list, got ${JSON.stringify(h.notifications().slice(-1))}`,
    );
  } finally {
    await h.cleanup();
  }
});

test("classifyFailure sorts provider errors into the five buckets", () => {
  assert.equal(classifyFailure("429 Too Many Requests from provider"), "rate_limit");
  assert.equal(classifyFailure("request timed out after a rate limit retry"), "rate_limit");
  assert.equal(classifyFailure("503 Service Unavailable: model overloaded"), "overloaded");
  assert.equal(classifyFailure("The model is temporarily unavailable"), "overloaded");
  assert.equal(classifyFailure("401 Unauthorized: invalid API key"), "auth");
  assert.equal(classifyFailure("403 forbidden: authentication failed"), "auth");
  assert.equal(classifyFailure("socket hang up"), "transport");
  assert.equal(classifyFailure("fetch failed: ECONNRESET"), "transport");
  assert.equal(classifyFailure("request aborted by the user"), "transport");
  assert.equal(classifyFailure("the model produced an empty response"), "other");
  assert.equal(classifyFailure(""), "other");
});
