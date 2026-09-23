/**
 * Unit tests for the host capability adapter (`src/host.ts`).
 *
 * These exercise the adapter directly, with no extension and no real host: a
 * hand-built omp-shaped context, a hand-built upstream-pi-shaped context, and
 * deliberately malformed contexts. The adapter's whole job is to be total, so
 * every "must not throw" case here is a real contract, not a formality.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectHost,
  resolveModel,
  currentModel,
  hasConfiguredAuth,
  startTimer,
  log,
  registerEvent,
  type HostCapabilities,
  type HostModel,
  type HostTimers,
} from "../src/host.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SLOW: HostModel = { id: "slow-model", provider: "test" };
const DEFAULT: HostModel = { id: "default-model", provider: "test" };

/** An omp-shaped context: the facade plus managed timers. */
function ompContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    models: {
      list: () => [SLOW, DEFAULT],
      current: () => SLOW,
      resolve: (spec: string) => (spec === "@slow" ? SLOW : undefined),
      family: (model: HostModel) => model.provider,
    },
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimer: (timer: unknown) => clearTimeout(timer as NodeJS.Timeout),
    model: SLOW,
    ...overrides,
  };
}

/** An upstream-pi-shaped context: no facade, no managed timers, a registry. */
function piContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: DEFAULT,
    modelRegistry: {
      find: (provider: string, id: string) => (provider === "test" && id === "slow-model" ? SLOW : undefined),
    },
    ...overrides,
  };
}

/**
 * Drive the raw-timer path deterministically: `startTimer` reaches for the
 * global `setTimeout` when the host has no managed timers, so temporarily
 * swapping the globals lets the test fire and inspect timers with no wall-clock
 * wait at all.
 */
function withFakeClock(
  run: (clock: { scheduled: Array<{ callback: () => void; ms: number }>; cleared: unknown[] }) => void,
): void {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const scheduled: Array<{ callback: () => void; ms: number }> = [];
  const cleared: unknown[] = [];
  let nextHandle = 0;

  (globalThis as { setTimeout: unknown }).setTimeout = (callback: () => void, ms?: number) => {
    nextHandle += 1;
    const handle = nextHandle;
    scheduled.push({ callback, ms: ms ?? 0 });
    return handle;
  };
  (globalThis as { clearTimeout: unknown }).clearTimeout = (handle: unknown) => {
    cleared.push(handle);
  };

  try {
    run({ scheduled, cleared });
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
  }
}

// ---------------------------------------------------------------------------
// detectHost
// ---------------------------------------------------------------------------

test("detectHost recognises a full omp-shaped context", () => {
  const caps = detectHost(ompContext());

  assert.equal(caps.name, "omp");
  assert.equal(caps.retryEvents, true);
  assert.ok(caps.models, "expected the facade to be captured");
  assert.ok(caps.timers, "expected managed timers to be captured");
  assert.equal(caps.models!.resolve("@slow"), SLOW);
  assert.equal(caps.models!.current(), SLOW);
});

test("detectHost recognises an upstream-pi-shaped context", () => {
  const caps = detectHost(piContext());

  assert.equal(caps.name, "pi");
  assert.equal(caps.retryEvents, false);
  assert.equal(caps.models, undefined);
  assert.equal(caps.timers, undefined);
});

test("detectHost treats bare, null, and undefined contexts as the pi path", () => {
  for (const ctx of [{}, null, undefined]) {
    const caps = detectHost(ctx);
    assert.equal(caps.name, "pi", `expected pi for ${JSON.stringify(ctx)}`);
    assert.equal(caps.retryEvents, false);
    assert.equal(caps.models, undefined);
    assert.equal(caps.timers, undefined);
  }
});

test("detectHost treats a managed-timer-only context as omp", () => {
  const caps = detectHost({
    setTimeout: () => 1,
    clearTimer: () => {},
  });

  assert.equal(caps.name, "omp");
  assert.ok(caps.timers);
  assert.equal(caps.models, undefined);
});

test("detectHost ignores a malformed facade and half-supplied timers", () => {
  // A `models` object without callable resolve/current is not the facade.
  assert.equal(detectHost({ models: {} }).name, "pi");
  assert.equal(detectHost({ models: { resolve: () => undefined } }).name, "pi");
  assert.equal(detectHost({ models: "nope" }).name, "pi");

  // Both managed-timer methods are required.
  assert.equal(detectHost({ setTimeout: () => 1 }).name, "pi");
  assert.equal(detectHost({ clearTimer: () => {} }).name, "pi");
  assert.equal(detectHost({ models: SLOW }).name, "pi");
});

// ---------------------------------------------------------------------------
// resolveModel
// ---------------------------------------------------------------------------

test("resolveModel uses the facade when present", () => {
  const caps = detectHost(ompContext());

  assert.deepEqual(resolveModel(caps, ompContext(), "@slow"), SLOW);
  assert.equal(resolveModel(caps, ompContext(), "@unknown"), undefined);
});

test("resolveModel falls back to the registry on the pi path", () => {
  const calls: Array<[string, string]> = [];
  const ctx = piContext({
    modelRegistry: {
      find: (provider: string, id: string) => {
        calls.push([provider, id]);
        return provider === "test" && id === "slow-model" ? SLOW : undefined;
      },
    },
  });
  const caps = detectHost(ctx);

  assert.deepEqual(resolveModel(caps, ctx, "test/slow-model"), SLOW);
  assert.deepEqual(calls, [["test", "slow-model"]]);
  assert.equal(resolveModel(caps, ctx, "test/nope"), undefined);
});

test("resolveModel splits on the first slash only", () => {
  const slashed: HostModel = { id: "accounts/fireworks/routers/firerouter", provider: "fireworks" };
  const calls: Array<[string, string]> = [];
  const ctx = piContext({
    modelRegistry: {
      find: (provider: string, id: string) => {
        calls.push([provider, id]);
        return slashed;
      },
    },
  });

  assert.deepEqual(resolveModel(detectHost(ctx), ctx, "fireworks/accounts/fireworks/routers/firerouter"), slashed);
  assert.deepEqual(calls, [["fireworks", "accounts/fireworks/routers/firerouter"]]);
});

test("resolveModel returns the live model when the spec matches it", () => {
  const byId = detectHost(
    piContext({
      model: { id: "slow-model", provider: "test" },
      modelRegistry: {},
    }),
  );
  assert.deepEqual(
    resolveModel(
      byId,
      piContext({
        model: { id: "slow-model", provider: "test" },
        modelRegistry: {},
      }),
      "slow-model",
    ),
    SLOW,
  );

  const byProviderId = detectHost(piContext({ modelRegistry: {} }));
  assert.deepEqual(resolveModel(byProviderId, piContext({ modelRegistry: {} }), "test/default-model"), DEFAULT);
});

test("resolveModel scans getAvailable when find is absent", () => {
  const ctx = piContext({
    modelRegistry: {
      getAvailable: () => [DEFAULT, SLOW],
    },
  });

  assert.deepEqual(resolveModel(detectHost(ctx), ctx, "test/slow-model"), SLOW);
  assert.equal(resolveModel(detectHost(ctx), ctx, "test/missing"), undefined);
});

test("resolveModel never throws on malformed contexts", () => {
  const caps = { name: "pi", retryEvents: false } as HostCapabilities;

  for (const ctx of [null, undefined, {}, { modelRegistry: "nope" }, { modelRegistry: { find: 3 } }, 42, "x"]) {
    assert.equal(resolveModel(caps, ctx, "test/slow-model"), undefined);
  }

  // A registry that throws on every probe must still be survived.
  const throwing = {
    modelRegistry: {
      find: () => {
        throw new Error("boom");
      },
      getAvailable: () => {
        throw new Error("boom");
      },
    },
  };
  assert.equal(resolveModel(detectHost(throwing), throwing, "test/slow-model"), undefined);
  assert.equal(resolveModel(caps, throwing, ""), undefined);
});

// ---------------------------------------------------------------------------
// currentModel
// ---------------------------------------------------------------------------

test("currentModel prefers the facade, then ctx.model, then nothing", () => {
  const omp = ompContext();
  assert.deepEqual(currentModel(detectHost(omp), omp), SLOW);

  const pi = piContext();
  assert.deepEqual(currentModel(detectHost(pi), pi), DEFAULT);

  assert.equal(currentModel({ name: "pi", retryEvents: false }, {}), undefined);
  assert.equal(currentModel({ name: "pi", retryEvents: false }, null), undefined);
  assert.equal(currentModel(detectHost({ model: "nope" }), { model: "nope" }), undefined);
});

// ---------------------------------------------------------------------------
// hasConfiguredAuth
// ---------------------------------------------------------------------------

test("hasConfiguredAuth reports the registry answer or undefined", () => {
  const yes = piContext({ modelRegistry: { hasConfiguredAuth: () => true } });
  assert.equal(hasConfiguredAuth(detectHost(yes), yes, SLOW), true);

  const no = piContext({ modelRegistry: { hasConfiguredAuth: () => false } });
  assert.equal(hasConfiguredAuth(detectHost(no), no, SLOW), false);

  const silent = piContext();
  assert.equal(hasConfiguredAuth(detectHost(silent), silent, SLOW), undefined);

  const throwing = piContext({
    modelRegistry: {
      hasConfiguredAuth: () => {
        throw new Error("boom");
      },
    },
  });
  assert.equal(hasConfiguredAuth(detectHost(throwing), throwing, SLOW), undefined);

  assert.equal(hasConfiguredAuth({ name: "pi", retryEvents: false }, null, SLOW), undefined);
});

// ---------------------------------------------------------------------------
// startTimer
// ---------------------------------------------------------------------------

test("startTimer fires exactly once on the raw path", () => {
  const caps = { name: "pi", retryEvents: false } as HostCapabilities;

  withFakeClock((clock) => {
    let fired = 0;
    startTimer(
      caps,
      () => {
        fired += 1;
      },
      5,
    );

    assert.equal(clock.scheduled.length, 1);
    assert.equal(clock.scheduled[0]!.ms, 5);

    clock.scheduled[0]!.callback();
    assert.equal(fired, 1);
    // No rescheduling: a timeout is one shot, not an interval.
    assert.equal(clock.scheduled.length, 1);
  });
});

test("startTimer cancel() clears the raw timer and stops the callback", () => {
  const caps = { name: "pi", retryEvents: false } as HostCapabilities;

  withFakeClock((clock) => {
    let fired = 0;
    const timer = startTimer(
      caps,
      () => {
        fired += 1;
      },
      5,
    );

    timer.cancel();
    timer.cancel();
    assert.equal(clock.cleared.length, 1);

    // Even if the native timer had already been queued, cancel must win.
    clock.scheduled[0]!.callback();
    assert.equal(fired, 0);
  });
});

test("startTimer delegates to managed timers and cancel() clears them", () => {
  const created: Array<{ callback: () => void; ms: number; handle: unknown }> = [];
  const cleared: unknown[] = [];
  let nextHandle = 0;

  const timers: HostTimers = {
    setTimeout(callback, ms) {
      nextHandle += 1;
      const handle = { handle: nextHandle };
      created.push({ callback, ms, handle });
      return handle;
    },
    clearTimer(handle) {
      cleared.push(handle);
    },
  };
  const caps: HostCapabilities = { name: "omp", timers, retryEvents: true };

  let fired = 0;
  const timer = startTimer(
    caps,
    () => {
      fired += 1;
    },
    10,
  );

  assert.equal(created.length, 1);
  assert.equal(created[0]!.ms, 10);

  created[0]!.callback();
  assert.equal(fired, 1);

  timer.cancel();
  assert.deepEqual(cleared, [created[0]!.handle]);

  // A cancel after fire is harmless and the callback must not run again.
  timer.cancel();
  created[0]!.callback();
  assert.equal(fired, 1);
  assert.equal(cleared.length, 1);
});

test("startTimer falls back to a raw timer when the managed one throws", () => {
  const timers: HostTimers = {
    setTimeout() {
      throw new Error("no managed timers");
    },
    clearTimer() {
      throw new Error("no managed timers");
    },
  };
  const caps: HostCapabilities = { name: "omp", timers, retryEvents: true };

  withFakeClock((clock) => {
    let fired = 0;
    const timer = startTimer(
      caps,
      () => {
        fired += 1;
      },
      5,
    );

    assert.equal(clock.scheduled.length, 1);
    clock.scheduled[0]!.callback();
    assert.equal(fired, 1);

    const second = startTimer(
      caps,
      () => {
        fired += 1;
      },
      5,
    );
    second.cancel();
    clock.scheduled[1]!.callback();
    assert.equal(fired, 1);
    timer.cancel();
  });
});

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

test("log prefers pi.logger and never touches stderr when it is present", () => {
  const seen: Array<{ level: string; message: string }> = [];
  const pi = {
    logger: {
      debug: (message: string) => seen.push({ level: "debug", message }),
      warn: (message: string) => seen.push({ level: "warn", message }),
    },
  };

  const original = process.stderr.write;
  const writes: string[] = [];
  (process.stderr as { write: unknown }).write = (chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  };
  const envBefore = process.env["CLASS_ROUTER_DEBUG"];
  process.env["CLASS_ROUTER_DEBUG"] = "1";
  try {
    log(pi, "warn", "boom", { spec: "@slow" });
    assert.deepEqual(seen, [{ level: "warn", message: "boom" }]);
    assert.deepEqual(writes, []);
  } finally {
    (process.stderr as { write: unknown }).write = original;
    if (envBefore === undefined) delete process.env["CLASS_ROUTER_DEBUG"];
    else process.env["CLASS_ROUTER_DEBUG"] = envBefore;
  }
});

test("log is silent without a logger when CLASS_ROUTER_DEBUG is unset", () => {
  const original = process.stderr.write;
  const writes: string[] = [];
  const logs: unknown[] = [];
  const originalLog = console.log;
  (process.stderr as { write: unknown }).write = (chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  };
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };
  const envBefore = process.env["CLASS_ROUTER_DEBUG"];
  delete process.env["CLASS_ROUTER_DEBUG"];
  try {
    for (const pi of [undefined, null, {}, { logger: {} }, { logger: { warn: "not callable" } }]) {
      log(pi, "warn", "quiet");
      log(pi, "debug", "quiet");
    }
    assert.deepEqual(writes, []);
    assert.deepEqual(logs, []);
  } finally {
    (process.stderr as { write: unknown }).write = original;
    console.log = originalLog;
    if (envBefore === undefined) delete process.env["CLASS_ROUTER_DEBUG"];
    else process.env["CLASS_ROUTER_DEBUG"] = envBefore;
  }
});

test("log writes exactly one stderr line without a logger when debugging is on", () => {
  const original = process.stderr.write;
  const writes: string[] = [];
  (process.stderr as { write: unknown }).write = (chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  };
  const envBefore = process.env["CLASS_ROUTER_DEBUG"];
  process.env["CLASS_ROUTER_DEBUG"] = "1";
  try {
    log({}, "warn", "no logger here", { spec: "@slow" });

    assert.equal(writes.length, 1);
    assert.match(writes[0]!, /warn/);
    assert.match(writes[0]!, /no logger here/);
    assert.match(writes[0]!, /@slow/);
    assert.equal(writes[0]!.endsWith("\n"), true);
  } finally {
    (process.stderr as { write: unknown }).write = original;
    if (envBefore === undefined) delete process.env["CLASS_ROUTER_DEBUG"];
    else process.env["CLASS_ROUTER_DEBUG"] = envBefore;
  }
});

test("log never throws on hostile inputs", () => {
  const throwingLogger = {
    get logger() {
      throw new Error("getter boom");
    },
  };
  assert.doesNotThrow(() => log(throwingLogger, "warn", "x"));
  assert.doesNotThrow(() => log(Symbol("pi") as unknown, "debug", "x"));
});

// ---------------------------------------------------------------------------
// registerEvent
// ---------------------------------------------------------------------------

test("registerEvent returns true when the host accepts the event", () => {
  const registered: Array<{ event: string; handler: unknown }> = [];
  const pi = {
    on(event: string, handler: unknown) {
      registered.push({ event, handler });
    },
  };
  const handler = () => "ok";

  assert.equal(registerEvent(pi, "before_agent_start", handler), true);
  assert.equal(registered.length, 1);
  assert.equal(registered[0]!.event, "before_agent_start");
  assert.equal(registered[0]!.handler, handler);
});

test("registerEvent returns false and does not throw when the host rejects the event", () => {
  const pi = {
    on(event: string) {
      throw new Error(`unknown event ${event}`);
    },
  };

  let accepted = false;
  assert.doesNotThrow(() => {
    accepted = registerEvent(pi, "auto_retry_start", () => undefined);
  });
  assert.equal(accepted, false);
});

test("registerEvent returns false for hosts without a usable on()", () => {
  assert.equal(
    registerEvent(null, "before_agent_start", () => undefined),
    false,
  );
  assert.equal(
    registerEvent(undefined, "before_agent_start", () => undefined),
    false,
  );
  assert.equal(
    registerEvent({}, "before_agent_start", () => undefined),
    false,
  );
  assert.equal(
    registerEvent({ on: 3 }, "before_agent_start", () => undefined),
    false,
  );
});
