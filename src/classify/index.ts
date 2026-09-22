/**
 * Classifier selection: one factory per backend, chosen by `config.backend`.
 */

import type { Classifier, RouterConfig } from "../types.ts";
import { createJevClassifier } from "./jev.ts";
import { createLayaClassifier, type ChildProcessLike, type LayaSpawn } from "./laya.ts";
import { createLayaHttpClassifier } from "./laya-http.ts";

/** Injection seams for tests and for the extension's own environment. */
export interface ClassifierDeps {
  /** Environment for token lookup; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** `fetch` override; defaults to the global implementation. */
  fetchImpl?: typeof fetch;
  /** Sidecar spawner; defaults to `node:child_process.spawn`. */
  spawnImpl?: LayaSpawn;
  /** Diagnostic sink for non-fatal sidecar noise. */
  logger?: (message: string) => void;
  /** Base for relative `laya.workerScript` paths; defaults to the repo root. */
  extensionRoot?: string;
}

export function createClassifier(config: RouterConfig, deps: ClassifierDeps = {}): Classifier {
  if (config.backend === "laya") {
    return config.laya.transport === "http"
      ? createLayaHttpClassifier(config.laya, deps)
      : createLayaClassifier(config.laya, deps);
  }
  return createJevClassifier(config.jev, deps);
}

export type { ChildProcessLike, LayaSpawn };
export type { LayaTransport } from "../types.ts";
