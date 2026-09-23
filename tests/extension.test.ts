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
import { spawnSync } from "node:child_process";
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
    projectTrusted: options.projectTrusted,
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
  const h = await piHarness({ answers: choice("hard", 0.92) }, (url) =>
    piConfig(url, { circuitBreaker: nextBreaker({ failureThreshold: 3 }) }),
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
  const h = await piHarness({ answers: choice("hard", 0.92) }, (url) =>
    piConfig(url, { circuitBreaker: nextBreaker({ failureThreshold: 2 }) }),
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
    const breakerLine =
      h
        .notifications()
        .filter((message) => message.includes("breaker: "))
        .at(-1) ?? "";
    assert.match(breakerLine, /test\/slow-model=closed\/1/);

    await h.fake.emit("before_agent_start", { prompt: PROMPT }, h.ctx);
    assert.equal(h.fake.state.setModelCalls.at(-1)?.id, "slow-model");
  } finally {
    await h.cleanup();
  }
});

test("auto_retry_start still drives attribution on the omp host", async () => {
  const h = await harness({ answers: choice("hard", 0.92) }, (url) =>
    baseConfig(url, { circuitBreaker: nextBreaker({ failureThreshold: 1 }) }),
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

test("a failing classifier records the failure and leaves the model alone", async () => {
  const h = await harness({ status: 500, answers: {} }, (url) => baseConfig(url));
  try {
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);

    assert.equal(h.stub.requests.length, 1);
    assert.equal(h.fake.state.setModelCalls.length, 0);
    assert.ok(
      h.notifications().some((message) => message.includes("classification failed (unavailable)")),
      `expected an unavailable notification, got ${JSON.stringify(h.notifications())}`,
    );

    // Notifications are ephemeral, so a failure must also leave a durable line:
    // otherwise "declined to route" and "never ran" are indistinguishable later.
    const first = h.decisions();
    assert.equal(first.length, 1);
    assert.equal(first[0]!["reason"], "classification-failed");
    assert.equal(first[0]!["error"], "unavailable");
    assert.equal(first[0]!["changed"], false);
    assert.equal(first[0]!["apply"], null);

    // A malformed body must degrade the same way, with a protocol code.
    h.stub.respond({ malformed: true });
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);
    assert.equal(h.stub.requests.length, 2);
    assert.equal(h.fake.state.setModelCalls.length, 0);
    assert.ok(h.notifications().some((message) => message.includes("classification failed (protocol)")));
    const second = h.decisions();
    assert.equal(second.length, 2);
    assert.equal(second[1]!["reason"], "classification-failed");
    assert.equal(second[1]!["error"], "protocol");
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
  const h = await harness({ answers: choice("hard", 0.92) }, (url) =>
    baseConfig(url, { circuitBreaker: nextBreaker({ failureThreshold: 3 }) }),
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
  const h = await harness({ answers: choice("hard", 0.92) }, (url) =>
    baseConfig(url, { circuitBreaker: nextBreaker({ failureThreshold: 1 }) }),
  );
  try {
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);
    const command = h.fake.commands.get("class-router");
    assert.ok(command, "class-router command was not registered");
    const breakerLine = () =>
      h
        .notifications()
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
    await h.fake.emit("agent_end", { messages: [{ role: "assistant", stopReason: "end" }], willContinue: true }, h.ctx);
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

// ---------------------------------------------------------------------------
// Attempt records: the session transcript is the only durable audit trail, so a
// record must distinguish "routed and changed the model" from "routed and the
// model was already right" from "could not classify at all".
// ---------------------------------------------------------------------------

test("an applied route records the resolved model and that it changed", async () => {
  const h = await harness({ answers: choice("hard", 0.92) }, (url) => baseConfig(url));
  try {
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);

    assert.equal(h.fake.state.setModelCalls.length, 1);
    const decisions = h.decisions();
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!["reason"], "routed");
    assert.equal(decisions[0]!["spec"], "@slow");
    assert.equal(decisions[0]!["resolved"], "slow-model");
    assert.equal(decisions[0]!["changed"], true);
  } finally {
    await h.cleanup();
  }
});

test("routing to the model already in use is recorded as unchanged", async () => {
  const h = await harness({ answers: choice("hard", 0.92) }, (url) => baseConfig(url));
  try {
    // The session already sits on the model this decision would choose.
    h.fake.setCurrentModel({ id: "slow-model", provider: "test" });
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);

    assert.equal(h.fake.state.setModelCalls.length, 0, "the current model must not be re-set");
    const decisions = h.decisions();
    assert.equal(decisions.length, 1, "a no-op route is still an attempt worth recording");
    assert.equal(decisions[0]!["reason"], "routed");
    assert.equal(decisions[0]!["resolved"], "slow-model");
    assert.equal(decisions[0]!["changed"], false, "nothing moved, so the record must say so");
  } finally {
    await h.cleanup();
  }
});

test("a model spec that does not resolve is recorded as unchanged", async () => {
  const h = await harness({ answers: choice("hard", 0.92) }, (url) => baseConfig(url), {
    resolve: { "@slow": undefined },
  });
  try {
    await h.fake.emit("before_agent_start", { prompt: "Refactor the entire auth subsystem" }, h.ctx);

    assert.equal(h.fake.state.setModelCalls.length, 0);
    const decisions = h.decisions();
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!["resolved"], null);
    assert.equal(decisions[0]!["changed"], false);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Half-open probes
//
// Routing asks the breaker about every spec in a chain, so asking must never
// consume the single half-open probe: only the spec that actually runs claims
// it, and a claim that ends without an outcome is handed back.
// ---------------------------------------------------------------------------

/** A short cooldown that is still unique per test, so each gets its own breaker. */
function probeBreaker(): Record<string, number> {
  seq += 1;
  return nextBreaker({ failureThreshold: 1, cooldownMs: 20 + (seq % 20) });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Route once to @slow, fail the run, and wait out the cooldown. */
async function openThenCoolSlow(h: Harness, breaker: Record<string, number>): Promise<void> {
  await h.fake.emit("before_agent_start", { prompt: PROMPT }, h.ctx);
  assert.equal(h.fake.state.setModelCalls.at(-1)?.id, "slow-model");
  await h.fake.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] }, h.ctx);
  // Leave @slow's model so the next route is a real switch.
  h.fake.setCurrentModel({ id: "session-default-model", provider: "test" });
  await sleep(breaker["cooldownMs"]! + 10);
}

test("a low-confidence turn does not use up a half-open circuit's probe", async () => {
  const breaker = probeBreaker();
  const h = await harness({ answers: choice("hard", 0.92) }, (url) => baseConfig(url, { circuitBreaker: breaker }));
  try {
    await openThenCoolSlow(h, breaker);

    h.stub.respond({ answers: choice("hard", 0.1) });
    await h.fake.emit("before_agent_start", { prompt: PROMPT }, h.ctx);
    assert.equal(h.decisions().at(-1)!["reason"], "low-confidence");

    h.stub.respond({ answers: choice("hard", 0.92) });
    await h.fake.emit("before_agent_start", { prompt: PROMPT }, h.ctx);
    assert.equal(h.decisions().at(-1)!["apply"], "@slow");
    assert.equal(h.fake.state.setModelCalls.at(-1)?.id, "slow-model");
  } finally {
    await h.cleanup();
  }
});

test("a probe claimed for a spec that never runs is released", async () => {
  const breaker = probeBreaker();
  const h = await harness({ answers: choice("hard", 0.92) }, (url) => baseConfig(url, { circuitBreaker: breaker }));
  try {
    await openThenCoolSlow(h, breaker);

    // @slow is chosen but cannot be applied, so its claim must be returned.
    h.fake.setResolve("@slow", undefined);
    await h.fake.emit("before_agent_start", { prompt: PROMPT }, h.ctx);
    assert.equal(h.decisions().at(-1)!["apply"], "@slow");
    assert.equal(h.decisions().at(-1)!["changed"], false);

    h.fake.setResolve("@slow", MODELS["@slow"]);
    await h.fake.emit("before_agent_start", { prompt: PROMPT }, h.ctx);
    assert.equal(h.decisions().at(-1)!["apply"], "@slow");
    assert.equal(h.fake.state.setModelCalls.at(-1)?.id, "slow-model");
  } finally {
    await h.cleanup();
  }
});

test("a successful probe run closes the circuit", async () => {
  const breaker = probeBreaker();
  const h = await harness({ answers: choice("hard", 0.92) }, (url) => baseConfig(url, { circuitBreaker: breaker }));
  try {
    await openThenCoolSlow(h, breaker);

    await h.fake.emit("before_agent_start", { prompt: PROMPT }, h.ctx);
    assert.equal(h.fake.state.setModelCalls.at(-1)?.id, "slow-model");
    await h.fake.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, h.ctx);

    const command = h.fake.commands.get("class-router");
    assert.ok(command);
    await command.handler("status", h.ctx);
    assert.ok(h.notifications().some((line) => /breaker: .*@slow=closed\/0/.test(line)));
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Project trust
// ---------------------------------------------------------------------------

test("an untrusted project's config is never loaded, and trusting it reloads", async () => {
  const h = await harness({ answers: choice("hard", 0.92) }, (url) => baseConfig(url), { projectTrusted: false });
  const projectFile = path.join(h.cwd, ".omp", "class-router.json");
  try {
    await h.fake.emit("session_start", {}, h.ctx);
    assert.ok(
      h.notifications().some((line) => line.includes(projectFile) && /not trusted/.test(line)),
      "the skipped project file is reported",
    );

    const command = h.fake.commands.get("class-router");
    assert.ok(command);
    await command.handler("status", h.ctx);
    const source = h.notifications().find((line) => line.includes("config source:"));
    assert.ok(source);
    assert.ok(!source.includes(projectFile), "the project file is not the config source");
    assert.equal(h.stub.requests.length, 0);

    h.fake.state.projectTrusted = true;
    await command.handler("status", h.ctx);
    assert.ok(h.notifications().some((line) => /config reloaded/.test(line)));
    assert.ok(h.notifications().some((line) => line.includes("config source:") && line.includes(projectFile)));
  } finally {
    await h.cleanup();
  }
});

test("config warnings for unknown keys are surfaced as warnings", async () => {
  const h = await harness({ answers: choice("hard", 0.92) }, (url) => baseConfig(url, { dryrun: true }));
  try {
    await h.fake.emit("session_start", {}, h.ctx);
    const warning = h.fake.state.notifications.find((entry) => entry.message.includes("config warning"));
    assert.ok(warning, `notifications: ${JSON.stringify(h.notifications())}`);
    assert.equal(warning.type, "warning");
    assert.match(warning.message, /did you mean "dryRun"/);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Timeouts are reported as timeouts. The extension's own guard must not abort
// the backend at the same moment the backend's timer fires, or the slow call is
// logged as a caller abort instead.
// ---------------------------------------------------------------------------

test("a classification that exceeds its budget is recorded as a timeout", async () => {
  const h = await harness({ answers: choice("hard", 0.92), delayMs: 1000 }, (url) =>
    baseConfig(url, { jev: { endpoint: url, apiKeyEnvVar: TOKEN_VAR, timeoutMs: 100 } }),
  );
  try {
    await h.fake.emit("before_agent_start", { prompt: PROMPT }, h.ctx);
    const decisions = h.decisions();
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!["reason"], "classification-failed");
    assert.equal(decisions[0]!["error"], "timeout");
    assert.ok(h.notifications().some((message) => message.includes("classification failed (timeout)")));
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Shared classifiers
//
// Sessions in one process share a classifier only when their backend config
// matches. The Laya sidecar is the expensive case (each spawn reloads the
// checkpoints), so these tests count spawns of the stub worker.
// ---------------------------------------------------------------------------

const STUB_LAYA = path.resolve(import.meta.dirname, "fixtures", "stub_laya_worker.py");

interface LayaSession {
  fake: FakePi;
  ctx: ExtensionContext;
  cwd: string;
}

/** A session in its own project dir whose config points Laya at the stub worker. */
function layaSession(timeoutMs: number): LayaSession {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-classifier-router-laya-"));
  fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".omp", "class-router.json"),
    JSON.stringify({
      backend: "laya",
      laya: {
        pythonBin: "python3",
        workerScript: STUB_LAYA,
        repo: "stub/repo",
        router: false,
        preload: false,
        timeoutMs,
      },
      circuitBreaker: nextBreaker(),
      notify: false,
    }),
  );
  const fake = createFakePi({ cwd, sessionId: unique("laya-session"), resolve: MODELS });
  classRouter(fake.pi as unknown as ExtensionAPI);
  return { fake, ctx: fake.ctx as unknown as ExtensionContext, cwd };
}

async function prompt(session: LayaSession): Promise<void> {
  await session.fake.emit("before_agent_start", { prompt: PROMPT }, session.ctx);
}

function spawnCount(logFile: string): number {
  if (!fs.existsSync(logFile)) return 0;
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line !== "").length;
}

const hasPython = !spawnSync("python3", ["--version"]).error;

test(
  "sessions with different configs keep their own classifiers instead of evicting each other",
  hasPython ? {} : { skip: "python3 is unavailable" },
  async () => {
    const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "spawn-log-")), "spawns");
    process.env["STUB_LAYA_SPAWN_LOG"] = logFile;
    const base = 3000 + seq;
    const first = layaSession(base);
    const second = layaSession(base + 1);
    const again = layaSession(base);
    try {
      for (let round = 0; round < 3; round += 1) {
        await prompt(first);
        await prompt(second);
      }
      // One sidecar per distinct config, not one per switch.
      assert.equal(spawnCount(logFile), 2);
      for (const session of [first, second]) {
        assert.ok(
          session.fake.state.entries.every(
            (entry) => (entry.data as { reason: string }).reason !== "classification-failed",
          ),
        );
      }

      // A third session with the first one's config shares its sidecar.
      await prompt(again);
      assert.equal(spawnCount(logFile), 2);

      // The session that created it leaving must not pull it from under the other.
      await first.fake.emit("session_shutdown", {}, first.ctx);
      await prompt(again);
      assert.equal(spawnCount(logFile), 2);

      // Once the last user leaves it is disposed, so the next user spawns afresh.
      await again.fake.emit("session_shutdown", {}, again.ctx);
      const fresh = layaSession(base);
      try {
        await prompt(fresh);
        assert.equal(spawnCount(logFile), 3);
      } finally {
        await fresh.fake.emit("session_shutdown", {}, fresh.ctx);
        fs.rmSync(fresh.cwd, { recursive: true, force: true });
      }
    } finally {
      delete process.env["STUB_LAYA_SPAWN_LOG"];
      for (const session of [first, second, again]) {
        await session.fake.emit("session_shutdown", {}, session.ctx);
        fs.rmSync(session.cwd, { recursive: true, force: true });
      }
      fs.rmSync(path.dirname(logFile), { recursive: true, force: true });
    }
  },
);

test("sessions with different breaker settings keep separate circuits", async () => {
  const hardBreaker = nextBreaker({ failureThreshold: 1 });
  const a = await harness({ answers: choice("hard", 0.92) }, (url) => baseConfig(url, { circuitBreaker: hardBreaker }));
  const b = await harness({ answers: choice("hard", 0.92) }, (url) => baseConfig(url));
  try {
    await a.fake.emit("before_agent_start", { prompt: PROMPT }, a.ctx);
    await a.fake.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] }, a.ctx);

    // B routing in between must not replace A's breaker (and forget @slow is open).
    await b.fake.emit("before_agent_start", { prompt: PROMPT }, b.ctx);
    assert.equal(b.fake.state.setModelCalls.at(-1)?.id, "slow-model");

    a.fake.setCurrentModel({ id: "session-default-model", provider: "test" });
    await a.fake.emit("before_agent_start", { prompt: PROMPT }, a.ctx);
    assert.equal(a.decisions().at(-1)!["apply"], "@default");
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});
