import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createLayaClassifier } from "../src/classify/laya.ts";
import { ClassifierError } from "../src/types.ts";
import type { ClassificationResult, LayaBackendConfig, Questions } from "../src/types.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "..");
const STUB = path.join(TEST_DIR, "fixtures", "stub_laya_worker.py");
const PYTHON = "python3";

const QUESTIONS: Questions = {
  primary: {
    type: "choice",
    instructions: "Which model should answer?",
    criteria: { fast: "a cheap model", deep: "the slowest, smartest model" },
  },
};

interface Echo {
  id: number;
  op: string;
  state: unknown;
  questions: unknown;
}

function echoOf(result: ClassificationResult): Echo {
  const echo = (result.answers as unknown as { echo?: Echo }).echo;
  assert.ok(echo, "the stub echoed no request");
  return echo;
}

function config(overrides: Partial<LayaBackendConfig> = {}): LayaBackendConfig {
  return {
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
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>, code: string): Promise<ClassifierError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ClassifierError, `expected ClassifierError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.backend, "laya");
    return error;
  }
  throw new assert.AssertionError({ message: `expected rejection with code ${code}` });
}

const probe = spawnSync(PYTHON, ["--version"], { encoding: "utf8" });

if (probe.error || probe.status !== 0) {
  test("laya classifier suite", {
    skip: `skipping laya tests: ${PYTHON} is unavailable (${probe.error?.message ?? `exit ${probe.status}`})`,
  }, () => {});
} else {
  test("correlates interleaved calls and resolves a relative worker script", async (t) => {
    const laya = createLayaClassifier(config({ workerScript: path.relative(REPO_ROOT, STUB) }), {
      extensionRoot: REPO_ROOT,
      env: {},
    });
    t.after?.(() => laya.dispose());

    assert.equal(laya.name, "laya");
    const [first, second] = await Promise.all([
      laya.classify("first prompt", QUESTIONS),
      laya.classify("second prompt", QUESTIONS),
    ]);

    assert.equal(echoOf(first).state, "first prompt");
    assert.equal(echoOf(second).state, "second prompt");
    assert.equal(echoOf(first).op, "predict");
    assert.deepEqual(echoOf(first).questions, QUESTIONS);
    assert.ok(echoOf(first).id < echoOf(second).id, "each call must carry its own id");
    assert.equal(first.model, "stub-model");
  });

  test("warmup waits for ready and completes the preload round trip", async (t) => {
    const laya = createLayaClassifier(config({ preload: true, router: true }), {
      env: { STUB_LAYA_READY_DELAY_MS: "120" },
    });
    t.after?.(() => laya.dispose());

    // warmup resolving proves both the deferred `ready` event and the preload reply arrived.
    await laya.warmup?.();
    const result = await laya.classify("after warmup", QUESTIONS);
    assert.equal(echoOf(result).state, "after warmup");
  });

  test("warmup fails with timeout when the worker never becomes ready", async (t) => {
    const laya = createLayaClassifier(config({ warmupTimeoutMs: 150 }), {
      env: { STUB_LAYA_READY_DELAY_MS: "3000" },
    });
    t.after?.(() => laya.dispose());

    const error = await rejection(laya.warmup?.() ?? Promise.resolve(), "timeout");
    assert.match(error.message, /150ms/);
  });

  test("warmup passes only non-empty flags to the worker", async (t) => {
    const logs: string[] = [];
    const laya = createLayaClassifier(config({ subfolder: "typed-decisions", device: "cpu", router: true }), {
      env: {},
      logger: (message) => logs.push(message),
    });
    t.after?.(() => laya.dispose());

    await laya.classify("args", QUESTIONS);
    const line = logs.find((message) => message.includes("STUB_LAYA_ARGS"));
    assert.ok(line, `worker never reported its argv: ${logs.join(" | ")}`);
    const argv = JSON.parse(line.slice(line.indexOf("["))) as string[];
    assert.deepEqual(argv, ["--repo", "stub/repo", "--device", "cpu", "--router", "--subfolder", "typed-decisions"]);
  });

  /** The argv the stub worker was started with, read back from its stderr. */
  async function argvFor(
    overrides: Partial<LayaBackendConfig>,
    t: { after?: (fn: () => unknown) => void },
  ): Promise<string[]> {
    const logs: string[] = [];
    const laya = createLayaClassifier(config(overrides), { env: {}, logger: (message) => logs.push(message) });
    t.after?.(() => laya.dispose());
    await laya.classify("args", QUESTIONS);
    const line = logs.find((message) => message.includes("STUB_LAYA_ARGS"));
    assert.ok(line, `worker never reported its argv: ${logs.join(" | ")}`);
    return JSON.parse(line.slice(line.indexOf("["))) as string[];
  }

  test("maxLoaded reaches the worker only in router mode", async (t) => {
    assert.deepEqual(await argvFor({ router: true, maxLoaded: 3 }, t), [
      "--repo",
      "stub/repo",
      "--router",
      "--max-loaded",
      "3",
    ]);
    // null leaves Laya's own default in charge.
    assert.deepEqual(await argvFor({ router: true, maxLoaded: null }, t), ["--repo", "stub/repo", "--router"]);
    assert.deepEqual(await argvFor({ router: false, maxLoaded: 3 }, t), ["--repo", "stub/repo"]);
  });

  test("a worker crash rejects the in-flight call as unavailable, and a later call respawns", async (t) => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "laya-stub-")), "crash-once");
    fs.writeFileSync(marker, "");
    t.after?.(() => fs.rmSync(marker, { force: true }));

    const laya = createLayaClassifier(config(), { env: { STUB_LAYA_CRASH_ONCE: marker } });
    t.after?.(() => laya.dispose());

    const error = await rejection(laya.classify("dies", QUESTIONS), "unavailable");
    assert.match(error.message, /exited/);
    assert.ok(!fs.existsSync(marker), "the first worker should have consumed the crash marker");

    const result = await laya.classify("alive again", QUESTIONS);
    assert.equal(echoOf(result).state, "alive again");
  });

  test("a silent worker fails with timeout", async (t) => {
    const laya = createLayaClassifier(config({ timeoutMs: 150 }), { env: { STUB_LAYA_MODE: "timeout" } });
    t.after?.(() => laya.dispose());

    const error = await rejection(laya.classify("hang", QUESTIONS), "timeout");
    assert.match(error.message, /150ms/);
  });

  test("a failure reply is surfaced with the worker's kind, never empty answers", async (t) => {
    const protocol = createLayaClassifier(config(), { env: { STUB_LAYA_MODE: "fail_protocol" } });
    t.after?.(() => protocol.dispose());
    await rejection(protocol.classify("x", QUESTIONS), "protocol");

    const unavailable = createLayaClassifier(config(), { env: { STUB_LAYA_MODE: "fail_unavailable" } });
    t.after?.(() => unavailable.dispose());
    const error = await rejection(unavailable.classify("x", QUESTIONS), "unavailable");
    assert.match(error.message, /stub unavailable/);
  });

  test("ignores non-JSON stdout noise and warns once", async (t) => {
    const logs: string[] = [];
    const laya = createLayaClassifier(config(), {
      env: { STUB_LAYA_NOISE: "1" },
      logger: (message) => logs.push(message),
    });
    t.after?.(() => laya.dispose());

    const first = await laya.classify("noisy", QUESTIONS);
    const second = await laya.classify("noisy again", QUESTIONS);
    assert.equal(echoOf(first).state, "noisy");
    assert.equal(echoOf(second).state, "noisy again");
    assert.equal(logs.filter((message) => message.includes("non-JSON")).length, 1);
  });

  test("dispose is idempotent, safe before spawn, and permits a respawn", async () => {
    const cold = createLayaClassifier(config(), { env: {} });
    await cold.dispose();
    await cold.dispose();

    const crashed = createLayaClassifier(config(), { env: { STUB_LAYA_MODE: "crash" } });
    await rejection(crashed.classify("x", QUESTIONS), "unavailable");
    await crashed.dispose();

    const laya = createLayaClassifier(config(), { env: {} });
    const first = await laya.classify("one", QUESTIONS);
    await laya.dispose();
    await laya.dispose();

    const second = await laya.classify("two", QUESTIONS);
    assert.equal(echoOf(first).state, "one");
    assert.equal(echoOf(second).state, "two");
    assert.ok(echoOf(second).id > echoOf(first).id);
    await laya.dispose();
  });
}
