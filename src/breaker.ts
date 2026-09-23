/**
 * Per-model circuit breaker.
 *
 * `closed` -> `open` after `failureThreshold` consecutive failures.
 * `open` -> `half_open` once `cooldownMs` has elapsed, letting through at most
 * `halfOpenMaxTrials` concurrent probes. A probe success closes the circuit; a
 * probe failure re-opens it with a fresh cooldown.
 *
 * The clock is injectable so tests need no timers. `allow` is a pure query: it
 * must stay safe to call repeatedly (the router filters a whole fallback chain
 * per prompt), so it never changes a circuit. A half-open probe is claimed
 * separately with `acquire`, and only for the spec that actually runs; a claim
 * that ends without a recorded outcome is handed back with `release`, otherwise
 * the probe budget leaks and the circuit stays half-open forever.
 */

import type { CircuitBreakerConfig } from "./types.ts";

export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerSnapshot {
  spec: string;
  state: BreakerState;
  failures: number;
  openedAt: number | null;
  halfOpenTrials: number;
}

interface Circuit {
  state: BreakerState;
  failures: number;
  openedAt: number | null;
  /** Probes started while half-open and not yet resolved by a record call. */
  halfOpenTrials: number;
}

export class CircuitBreaker {
  readonly #config: CircuitBreakerConfig;
  readonly #now: () => number;
  readonly #circuits = new Map<string, Circuit>();

  constructor(config: CircuitBreakerConfig, now: () => number = Date.now) {
    this.#config = config;
    this.#now = now;
  }

  #circuit(spec: string): Circuit {
    const existing = this.#circuits.get(spec);
    if (existing) return existing;
    const created: Circuit = { state: "closed", failures: 0, openedAt: null, halfOpenTrials: 0 };
    this.#circuits.set(spec, created);
    return created;
  }

  /** Whether a request to `spec` may proceed right now. Never changes state. */
  allow(spec: string): boolean {
    const circuit = this.#circuit(spec);
    if (circuit.state === "closed") return true;
    if (circuit.state === "open") return this.#cooledDown(circuit);
    return circuit.halfOpenTrials < this.#config.halfOpenMaxTrials;
  }

  /**
   * Claim the right to send a request to `spec`. On a closed circuit this is
   * free; on a cooled-down open or half-open circuit it takes one probe slot,
   * which `recordSuccess`/`recordFailure` resolve and `release` returns.
   */
  acquire(spec: string): boolean {
    const circuit = this.#circuit(spec);
    if (circuit.state === "closed") return true;

    if (circuit.state === "open") {
      if (!this.#cooledDown(circuit)) return false;
      circuit.state = "half_open";
      circuit.halfOpenTrials = 1;
      return true;
    }

    if (circuit.halfOpenTrials >= this.#config.halfOpenMaxTrials) return false;
    circuit.halfOpenTrials += 1;
    return true;
  }

  /** Return a probe slot claimed by `acquire` that will never see an outcome. */
  release(spec: string): void {
    const circuit = this.#circuits.get(spec);
    if (circuit === undefined || circuit.state !== "half_open" || circuit.halfOpenTrials === 0) return;
    circuit.halfOpenTrials -= 1;
  }

  #cooledDown(circuit: Circuit): boolean {
    return circuit.openedAt !== null && this.#now() - circuit.openedAt >= this.#config.cooldownMs;
  }

  recordSuccess(spec: string): void {
    const circuit = this.#circuit(spec);
    circuit.state = "closed";
    circuit.failures = 0;
    circuit.openedAt = null;
    circuit.halfOpenTrials = 0;
  }

  recordFailure(spec: string): void {
    const circuit = this.#circuit(spec);

    if (circuit.state === "half_open") {
      circuit.state = "open";
      circuit.openedAt = this.#now();
      circuit.halfOpenTrials = 0;
      return;
    }

    circuit.failures += 1;
    if (circuit.state === "closed" && circuit.failures >= this.#config.failureThreshold) {
      circuit.state = "open";
      circuit.openedAt = this.#now();
    }
  }

  /** Clear one spec, or every spec when called without an argument. */
  reset(spec?: string): void {
    if (spec === undefined) {
      this.#circuits.clear();
      return;
    }
    this.#circuits.delete(spec);
  }

  /** One entry per known spec, in first-seen order. */
  snapshot(): BreakerSnapshot[] {
    const snapshots: BreakerSnapshot[] = [];
    for (const [spec, circuit] of this.#circuits) {
      snapshots.push({
        spec,
        state: circuit.state,
        failures: circuit.failures,
        openedAt: circuit.openedAt,
        halfOpenTrials: circuit.halfOpenTrials,
      });
    }
    return snapshots;
  }

  /** First candidate currently allowing a request, or null when none do. */
  firstAvailable(chain: string[]): string | null {
    for (const spec of chain) {
      if (this.allow(spec)) return spec;
    }
    return null;
  }
}
