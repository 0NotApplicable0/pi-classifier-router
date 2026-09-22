import { test } from "node:test";
import assert from "node:assert/strict";

import { CircuitBreaker } from "../src/breaker.ts";
import type { BreakerSnapshot } from "../src/breaker.ts";
import type { CircuitBreakerConfig } from "../src/types.ts";

const CONFIG: CircuitBreakerConfig = { failureThreshold: 3, cooldownMs: 1000, halfOpenMaxTrials: 1 };

function snapshotFor(breaker: CircuitBreaker, spec: string): BreakerSnapshot | undefined {
  return breaker.snapshot().find((entry) => entry.spec === spec);
}

test("opens exactly at failureThreshold", () => {
  const breaker = new CircuitBreaker(CONFIG, () => 0);
  breaker.recordFailure("@a");
  breaker.recordFailure("@a");
  assert.equal(breaker.allow("@a"), true);
  assert.equal(snapshotFor(breaker, "@a")?.state, "closed");
  assert.equal(snapshotFor(breaker, "@a")?.failures, 2);

  breaker.recordFailure("@a");
  assert.equal(breaker.allow("@a"), false);
  assert.equal(snapshotFor(breaker, "@a")?.state, "open");
  assert.equal(snapshotFor(breaker, "@a")?.openedAt, 0);
});

test("stays open before cooldown and permits a probe after it", () => {
  let now = 0;
  const breaker = new CircuitBreaker(CONFIG, () => now);
  for (let i = 0; i < 3; i += 1) breaker.recordFailure("@a");

  now = 999;
  assert.equal(breaker.allow("@a"), false);
  assert.equal(snapshotFor(breaker, "@a")?.state, "open");

  now = 1000;
  assert.equal(breaker.allow("@a"), true);
  assert.equal(snapshotFor(breaker, "@a")?.state, "half_open");
});

test("a half-open success closes the circuit", () => {
  let now = 0;
  const breaker = new CircuitBreaker(CONFIG, () => now);
  for (let i = 0; i < 3; i += 1) breaker.recordFailure("@a");
  now = 1000;
  assert.equal(breaker.allow("@a"), true);

  breaker.recordSuccess("@a");
  const snapshot = snapshotFor(breaker, "@a");
  assert.equal(snapshot?.state, "closed");
  assert.equal(snapshot?.failures, 0);
  assert.equal(snapshot?.openedAt, null);
  assert.equal(snapshot?.halfOpenTrials, 0);
  assert.equal(breaker.allow("@a"), true);
});

test("a half-open failure re-opens the circuit and resets the probe budget", () => {
  let now = 0;
  const breaker = new CircuitBreaker(CONFIG, () => now);
  for (let i = 0; i < 3; i += 1) breaker.recordFailure("@a");
  now = 1000;
  assert.equal(breaker.allow("@a"), true);

  breaker.recordFailure("@a");
  const snapshot = snapshotFor(breaker, "@a");
  assert.equal(snapshot?.state, "open");
  assert.equal(snapshot?.openedAt, 1000);
  assert.equal(snapshot?.halfOpenTrials, 0);

  now = 1500;
  assert.equal(breaker.allow("@a"), false);
  now = 2000;
  assert.equal(breaker.allow("@a"), true);
  assert.equal(snapshotFor(breaker, "@a")?.state, "half_open");
  assert.equal(snapshotFor(breaker, "@a")?.halfOpenTrials, 1);
});

test("half-open admits at most halfOpenMaxTrials concurrent probes", () => {
  const config: CircuitBreakerConfig = { failureThreshold: 1, cooldownMs: 100, halfOpenMaxTrials: 2 };
  let now = 0;
  const breaker = new CircuitBreaker(config, () => now);
  breaker.recordFailure("@a");
  now = 100;
  assert.equal(breaker.allow("@a"), true);
  assert.equal(breaker.allow("@a"), true);
  assert.equal(breaker.allow("@a"), false);
});

test("unknown specs are created closed and record calls do not throw", () => {
  const breaker = new CircuitBreaker(CONFIG, () => 0);
  assert.equal(breaker.allow("@new"), true);
  assert.deepEqual(breaker.snapshot(), [
    { spec: "@new", state: "closed", failures: 0, openedAt: null, halfOpenTrials: 0 },
  ]);
  assert.doesNotThrow(() => breaker.recordSuccess("@success"));
  assert.doesNotThrow(() => breaker.recordFailure("@failure"));
});

test("repeated allow calls on a closed circuit are side-effect free", () => {
  const breaker = new CircuitBreaker(CONFIG, () => 0);
  for (let i = 0; i < 5; i += 1) assert.equal(breaker.allow("@a"), true);
  const snapshot = snapshotFor(breaker, "@a");
  assert.equal(snapshot?.state, "closed");
  assert.equal(snapshot?.failures, 0);
  assert.equal(snapshot?.halfOpenTrials, 0);
});

test("firstAvailable skips open circuits and returns null when all are open", () => {
  const breaker = new CircuitBreaker(CONFIG, () => 0);
  for (let i = 0; i < 3; i += 1) breaker.recordFailure("@a");
  assert.equal(breaker.firstAvailable(["@a", "@b"]), "@b");

  for (let i = 0; i < 3; i += 1) breaker.recordFailure("@b");
  assert.equal(breaker.firstAvailable(["@a", "@b"]), null);
  assert.equal(breaker.firstAvailable([]), null);
});

test("reset clears one spec, or everything", () => {
  const breaker = new CircuitBreaker(CONFIG, () => 0);
  breaker.allow("@a");
  breaker.allow("@b");
  breaker.reset("@a");
  assert.deepEqual(
    breaker.snapshot().map((entry) => entry.spec),
    ["@b"],
  );
  breaker.reset();
  assert.deepEqual(breaker.snapshot(), []);
  assert.equal(breaker.allow("@a"), true);
});
