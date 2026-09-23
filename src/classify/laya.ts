/**
 * Laya (local System One) classifier: a persistent NDJSON sidecar process.
 *
 * Wire protocol, shared verbatim with `python/laya_worker.py`:
 *   request  {"id":<int>,"op":"predict"|"ping"|"preload"|"shutdown","deadline"?:<epoch ms>, ...}
 *   reply    {"id":<int>,"ok":true,"result":{...}}
 *          | {"id":<int>,"ok":false,"error":<string>,"kind":"unavailable"|"timeout"|"protocol"}
 *   event    {"event":"ready","version":<string>,"loaded":<string[]>}
 *          | {"event":"error","error":<string>,"kind":...}
 *
 * The worker serves one request at a time and cannot interrupt a running
 * prediction, so a request the client has already given up on would otherwise
 * still run, and every request queued behind it would time out in turn. Each
 * request therefore carries the wall-clock `deadline` at which the client stops
 * waiting; the worker answers an expired `predict`/`preload` with a `timeout`
 * error instead of running it. Client and worker share a host, so one clock.
 *
 * stdout carries one JSON object per line and nothing else; the worker writes
 * diagnostics to stderr. The child is spawned lazily and respawned after a
 * crash, so a dead worker degrades to `unavailable` without poisoning the
 * session.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { ClassifierError } from "../types.ts";
import type {
  Answers,
  ClassificationResult,
  Classifier,
  ClassifierErrorCode,
  ClassifierState,
  ClassifyOptions,
  LayaBackendConfig,
  Questions,
} from "../types.ts";
import type { ClassifierDeps } from "./index.ts";

const BACKEND = "laya";

/** Repo root: two directories above `src/classify/laya.ts`. */
const DEFAULT_EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The subset of `node:child_process.ChildProcess` this client needs. */
export interface ChildProcessLike {
  stdout: AsyncIterable<Uint8Array | string> | null;
  stderr: AsyncIterable<Uint8Array | string> | null;
  stdin: { write(chunk: string): boolean };
  kill(signal?: string): boolean;
  on(event: "exit" | "error", cb: (...args: unknown[]) => void): void;
  pid?: number;
}

export type LayaSpawn = (
  command: string,
  args: string[],
  options: { env: Record<string, string | undefined> },
) => ChildProcessLike;

interface ReadyInfo {
  version: string;
  loaded: string[];
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: ClassifierError) => void;
}

interface ReadyWaiter {
  resolve: (value: ReadyInfo) => void;
  reject: (error: ClassifierError) => void;
}

const defaultSpawn: LayaSpawn = (command, args, options) =>
  spawn(command, args, { env: options.env, stdio: ["pipe", "pipe", "pipe"] }) as unknown as ChildProcessLike;

export function createLayaClassifier(config: LayaBackendConfig, deps: ClassifierDeps = {}): Classifier {
  const spawnImpl = deps.spawnImpl ?? defaultSpawn;
  const extensionRoot = deps.extensionRoot ?? DEFAULT_EXTENSION_ROOT;
  const workerScript = path.isAbsolute(config.workerScript)
    ? config.workerScript
    : path.resolve(extensionRoot, config.workerScript);

  let child: ChildProcessLike | null = null;
  let nextId = 1;
  let ready: ReadyInfo | null = null;
  let warnedStdout = false;
  const pending = new Map<number, PendingCall>();
  let readyWaiters: ReadyWaiter[] = [];

  function spawnArgs(): string[] {
    const args = ["--repo", config.repo];
    if (config.device) args.push("--device", config.device);
    if (config.router) args.push("--router");
    if (config.router && config.maxLoaded !== null) args.push("--max-loaded", String(config.maxLoaded));
    if (config.preload) args.push("--preload");
    if (config.subfolder) args.push("--subfolder", config.subfolder);
    return args;
  }

  function childEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env, ...(deps.env ?? {}) };
    const token = deps.env?.[config.hfTokenEnvVar] ?? process.env[config.hfTokenEnvVar];
    if (token) env["HF_TOKEN"] = token;
    return env;
  }

  /** Tear down a dead child: fail every in-flight call and allow a respawn. */
  function failChild(proc: ChildProcessLike, message: string): void {
    if (child !== proc) return;
    child = null;
    ready = null;
    warnedStdout = false;
    const error = new ClassifierError(BACKEND, "unavailable", message);
    for (const call of [...pending.values()]) call.reject(error);
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  function handleStdoutLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (!warnedStdout) {
        warnedStdout = true;
        deps.logger?.(`laya worker wrote a non-JSON stdout line: ${line.slice(0, 120)}`);
      }
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      if (!warnedStdout) {
        warnedStdout = true;
        deps.logger?.(`laya worker wrote a JSON value that is not an object: ${line.slice(0, 120)}`);
      }
      return;
    }

    const record = parsed as Record<string, unknown>;
    if (typeof record["event"] === "string") {
      const event = record["event"];
      if (event === "ready") {
        ready = {
          version: typeof record["version"] === "string" ? record["version"] : "unknown",
          loaded: Array.isArray(record["loaded"])
            ? record["loaded"].filter((name): name is string => typeof name === "string")
            : [],
        };
        const waiters = readyWaiters;
        readyWaiters = [];
        for (const waiter of waiters) waiter.resolve(ready);
      } else if (event === "error") {
        const proc = child;
        if (proc) failChild(proc, `laya worker reported an error: ${String(record["error"])}`);
      } else {
        deps.logger?.(`laya worker sent an unknown event: ${event}`);
      }
      return;
    }

    const id = record["id"];
    if (typeof id !== "number" || !Number.isInteger(id)) {
      deps.logger?.(`laya worker sent a reply without a numeric id: ${line.slice(0, 120)}`);
      return;
    }
    const call = pending.get(id);
    if (!call) {
      // A late reply to a call that timed out, aborted, or outlived a dispose.
      if (child) deps.logger?.(`laya worker replied to unknown request id ${id}`);
      return;
    }
    if (record["ok"] === true) {
      call.resolve(record["result"]);
      return;
    }
    const kind = record["kind"];
    const code: ClassifierErrorCode =
      kind === "timeout" || kind === "unavailable" || kind === "protocol" ? kind : "unavailable";
    call.reject(
      new ClassifierError(BACKEND, code, `laya worker failed: ${String(record["error"] ?? "unknown error")}`),
    );
  }

  function handleStderrLine(line: string): void {
    deps.logger?.(`laya worker: ${line}`);
  }

  function ensureChild(): ChildProcessLike {
    if (child) return child;
    const proc = spawnImpl(config.pythonBin, [workerScript, ...spawnArgs()], { env: childEnv() });
    child = proc;
    ready = null;
    warnedStdout = false;
    if (proc.stdout) {
      void pump(proc.stdout, (line) => {
        if (child === proc) handleStdoutLine(line);
      });
    }
    if (proc.stderr) {
      void pump(proc.stderr, (line) => {
        if (child === proc) handleStderrLine(line);
      });
    }
    proc.on("error", (error: unknown) => {
      failChild(proc, `laya worker failed to start: ${error instanceof Error ? error.message : String(error)}`);
    });
    proc.on("exit", (code: unknown) => {
      failChild(proc, `laya worker exited (${typeof code === "number" ? code : "signal"})`);
    });
    return proc;
  }

  function waitReady(timeoutMs: number, signal?: AbortSignal): Promise<ReadyInfo> {
    const current = ready;
    if (current) return Promise.resolve(current);
    return new Promise<ReadyInfo>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const waiter: ReadyWaiter = {
        resolve: (value) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const onAbort = (): void => {
        readyWaiters = readyWaiters.filter((entry) => entry !== waiter);
        waiter.reject(new ClassifierError(BACKEND, "aborted", "laya warmup aborted by caller"));
      };
      timer = setTimeout(() => {
        readyWaiters = readyWaiters.filter((entry) => entry !== waiter);
        waiter.reject(new ClassifierError(BACKEND, "timeout", `laya worker not ready within ${timeoutMs}ms`));
      }, timeoutMs);
      readyWaiters.push(waiter);
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  function request(
    op: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      let proc: ChildProcessLike;
      try {
        proc = ensureChild();
      } catch (error) {
        reject(
          new ClassifierError(
            BACKEND,
            "unavailable",
            `could not spawn laya worker: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }

      const id = nextId++;
      const deadline = Date.now() + timeoutMs;
      let timer: NodeJS.Timeout;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const failWith = (code: ClassifierErrorCode, message: string): void => {
        if (!pending.has(id)) return;
        pending.delete(id);
        cleanup();
        reject(new ClassifierError(BACKEND, code, message));
      };
      const onAbort = (): void => failWith("aborted", `laya ${op} aborted by caller`);

      pending.set(id, {
        resolve: (value) => {
          if (!pending.has(id)) return;
          pending.delete(id);
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          if (!pending.has(id)) return;
          pending.delete(id);
          cleanup();
          reject(error);
        },
      });
      timer = setTimeout(() => failWith("timeout", `laya ${op} exceeded ${timeoutMs}ms`), timeoutMs);
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        proc.stdin.write(`${JSON.stringify({ id, op, deadline, ...payload })}\n`);
      } catch (error) {
        failWith("unavailable", `laya worker stdin closed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  return {
    name: BACKEND,

    async warmup(options?: ClassifyOptions): Promise<void> {
      ensureChild();
      await waitReady(config.warmupTimeoutMs, options?.signal);
      if (config.preload) await request("preload", {}, config.warmupTimeoutMs, options?.signal);
    },

    async classify(
      state: ClassifierState,
      questions: Questions,
      options?: ClassifyOptions,
    ): Promise<ClassificationResult> {
      const value = await request("predict", { state, questions }, config.timeoutMs, options?.signal);
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new ClassifierError(BACKEND, "protocol", "laya worker returned no result object");
      }
      const record = value as Record<string, unknown>;
      const answers = record["answers"];
      if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
        throw new ClassifierError(BACKEND, "protocol", "laya worker returned no answers object");
      }
      const result: ClassificationResult = { answers: answers as Answers };
      if (typeof record["model"] === "string") result.model = record["model"];
      const usage = record["usage"];
      if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) {
        result.usage = usage as ClassificationResult["usage"];
      }
      return result;
    },

    async dispose(): Promise<void> {
      const proc = child;
      if (!proc) return;
      // Detach first so the imminent exit event cannot tear down a respawn.
      child = null;
      ready = null;
      const error = new ClassifierError(BACKEND, "unavailable", "laya worker disposed");
      for (const call of [...pending.values()]) call.reject(error);
      const waiters = readyWaiters;
      readyWaiters = [];
      for (const waiter of waiters) waiter.reject(error);
      try {
        proc.stdin.write(`${JSON.stringify({ id: nextId++, op: "shutdown" })}\n`);
      } catch {
        // Best effort: the child may already be gone.
      }
      try {
        proc.kill();
      } catch {
        // Best effort.
      }
    },
  };
}

/** Split an async byte/string stream into lines, tolerating chunk boundaries. */
async function pump(stream: AsyncIterable<Uint8Array | string>, onLine: (line: string) => void): Promise<void> {
  let buffer = "";
  try {
    for await (const chunk of stream) {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line.trim() !== "") onLine(line);
        index = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail !== "") onLine(tail);
  } catch {
    // Stream teardown; the child exit/error handler reports the failure.
  }
}
