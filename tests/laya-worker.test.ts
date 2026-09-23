/**
 * The real python/laya_worker.py, run against a fake `laya` module so no torch
 * or checkpoints are needed. Covers the queue behaviour the protocol stub cannot:
 * the worker serves one request at a time, so a request the client has already
 * abandoned must be skipped rather than run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createLayaClassifier } from "../src/classify/laya.ts";
import type { LayaBackendConfig } from "../src/types.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.resolve(TEST_DIR, "..", "python", "laya_worker.py");
const STUB = path.join(TEST_DIR, "fixtures", "stub_laya_worker.py");
const FAKE_LAYA = path.join(TEST_DIR, "fixtures", "fake_laya");
const PYTHON = "python3";

interface Reply {
  id: number;
  ok: boolean;
  kind?: string;
  error?: string;
  result?: { answers?: { calls?: number; state?: { name?: string } } };
}

/** Spawn the real worker and collect its stdout as parsed NDJSON lines. */
function startWorker(extraArgs: string[] = []): {
  send(request: Record<string, unknown>): void;
  next(): Promise<Record<string, unknown>>;
  stop(): void;
} {
  const child = spawn(PYTHON, [WORKER, "--repo", "fake/repo", ...extraArgs], {
    env: { ...process.env, PYTHONPATH: FAKE_LAYA },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: Array<Record<string, unknown>> = [];
  const waiters: Array<(line: Record<string, unknown>) => void> = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const parsed = JSON.parse(buffer.slice(0, index)) as Record<string, unknown>;
      buffer = buffer.slice(index + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(parsed);
      else lines.push(parsed);
      index = buffer.indexOf("\n");
    }
  });
  child.stderr.resume();
  return {
    send(request) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    },
    next() {
      const line = lines.shift();
      if (line) return Promise.resolve(line);
      return new Promise((resolve) => waiters.push(resolve));
    },
    stop() {
      child.kill();
    },
  };
}

const probe = spawnSync(PYTHON, ["--version"], { encoding: "utf8" });

if (probe.error || probe.status !== 0) {
  test("laya worker suite", { skip: `${PYTHON} is unavailable` }, () => {});
} else {
  test("the worker skips a predict whose deadline passed while it was queued", async () => {
    const worker = startWorker();
    try {
      const ready = await worker.next();
      assert.equal(ready["event"], "ready");

      const now = Date.now();
      // A keeps the worker busy past B's deadline; C is still wanted.
      worker.send({ id: 1, op: "predict", state: { name: "a", sleep_ms: 400 }, questions: {}, deadline: now + 60_000 });
      worker.send({ id: 2, op: "predict", state: { name: "b" }, questions: {}, deadline: now + 100 });
      worker.send({ id: 3, op: "predict", state: { name: "c" }, questions: {}, deadline: now + 60_000 });

      const a = (await worker.next()) as unknown as Reply;
      const b = (await worker.next()) as unknown as Reply;
      const c = (await worker.next()) as unknown as Reply;

      assert.equal(a.id, 1);
      assert.equal(a.ok, true);
      assert.equal(a.result?.answers?.calls, 1);

      assert.equal(b.id, 2);
      assert.equal(b.ok, false);
      assert.equal(b.kind, "timeout");
      assert.match(b.error ?? "", /deadline passed/);

      // C ran as the second prediction: B never reached `predict`.
      assert.equal(c.id, 3);
      assert.equal(c.ok, true);
      assert.equal(c.result?.answers?.calls, 2);
      assert.equal(c.result?.answers?.state?.name, "c");
    } finally {
      worker.stop();
    }
  });

  test("a request without a deadline still runs (older clients)", async () => {
    const worker = startWorker();
    try {
      await worker.next();
      worker.send({ id: 1, op: "predict", state: { name: "a" }, questions: {} });
      const reply = (await worker.next()) as unknown as Reply;
      assert.equal(reply.ok, true);
      assert.equal(reply.result?.answers?.calls, 1);
    } finally {
      worker.stop();
    }
  });

  test("ping and shutdown are never skipped, even with a past deadline", async () => {
    const worker = startWorker();
    try {
      await worker.next();
      worker.send({ id: 1, op: "ping", deadline: 0 });
      const ping = (await worker.next()) as unknown as Reply;
      assert.equal(ping.ok, true);
      worker.send({ id: 2, op: "shutdown", deadline: 0 });
      const bye = (await worker.next()) as unknown as Reply;
      assert.equal(bye.ok, true);
    } finally {
      worker.stop();
    }
  });

  /** The kwargs the worker handed to laya.Router, observed through the fake. */
  async function routerKwargs(extraArgs: string[]): Promise<Record<string, unknown>> {
    const worker = startWorker(extraArgs);
    try {
      await worker.next();
      worker.send({ id: 1, op: "predict", state: "hi", questions: {} });
      const reply = (await worker.next()) as { result?: { answers?: { router_kwargs?: Record<string, unknown> } } };
      const kwargs = reply.result?.answers?.router_kwargs;
      assert.ok(kwargs, `no router kwargs in ${JSON.stringify(reply)}`);
      return kwargs;
    } finally {
      worker.stop();
    }
  }

  test("router mode leaves max_loaded to Laya unless --max-loaded is given", async () => {
    assert.deepEqual(await routerKwargs(["--router"]), { preload: false });
    assert.deepEqual(await routerKwargs(["--router", "--max-loaded", "3"]), { preload: false, max_loaded: 3 });
  });

  test("the client stamps each request with a deadline of now + its timeout", async () => {
    const config: LayaBackendConfig = {
      transport: "python",
      endpoint: "",
      apiKeyEnvVar: "",
      pythonBin: PYTHON,
      workerScript: STUB,
      repo: "stub/repo",
      subfolder: null,
      device: null,
      router: false,
      maxLoaded: null,
      preload: false,
      timeoutMs: 3000,
      warmupTimeoutMs: 3000,
      hfTokenEnvVar: "HF_TOKEN",
    };
    const laya = createLayaClassifier(config);
    try {
      const before = Date.now();
      const result = await laya.classify("hello", {});
      const after = Date.now();
      const echo = (result.answers as unknown as { echo: { deadline?: unknown } }).echo;
      assert.equal(typeof echo.deadline, "number");
      const deadline = echo.deadline as number;
      assert.ok(deadline >= before + 3000 && deadline <= after + 3000, `deadline ${deadline} out of range`);
    } finally {
      await laya.dispose();
    }
  });
}
