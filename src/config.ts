/**
 * Config discovery, defaults, merge, and validation.
 *
 * Precedence is project over global; within a scope JSON is preferred over YAML.
 * The first existing, parseable, valid file wins. A file that fails to read or
 * parse is reported and skipped, but a file that parses yet violates the
 * contract is rejected outright: silently mis-routing is worse than falling back
 * to the session's own model.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Question, RouterConfig, RouterConfigInput } from "./types.ts";

export type ConfigFormat = "json" | "yaml";

export interface ConfigSource {
  path: string;
  scope: "project" | "global";
  format: ConfigFormat;
}

export interface ConfigLoadResult {
  config: RouterConfig | null;
  source: ConfigSource | null;
  errors: string[];
}

/** Parses one YAML document. Supplied by the host, since only Bun has one. */
export type YamlParser = (text: string) => unknown;

/**
 * Bun ships a YAML parser; Node does not. Absent a parser, YAML candidates are
 * reported as errors rather than silently ignored, so a `.yml` config that is
 * being skipped is visible.
 */
export function defaultYamlParser(): YamlParser | null {
  const scope: unknown = globalThis;
  if (typeof scope !== "object" || scope === null || !("Bun" in scope)) return null;
  const bun = scope.Bun;
  if (typeof bun !== "object" || bun === null || !("YAML" in bun)) return null;
  const yaml = bun.YAML;
  if (typeof yaml !== "object" || yaml === null || !("parse" in yaml)) return null;
  const parse = yaml.parse;
  if (typeof parse !== "function") return null;
  // Verified callable just above; only its signature is unknowable statically.
  const call = parse as (value: string) => unknown;
  return (text: string) => call(text);
}

/** Candidate files per scope, in precedence order. */
const CANDIDATES: ReadonlyArray<{ name: string; format: ConfigFormat }> = [
  { name: "class-router.json", format: "json" },
  { name: "class-router.yml", format: "yaml" },
  { name: "class-router.yaml", format: "yaml" },
];

/** Every candidate, project first, JSON before YAML, then global. */
export function configPaths(cwd: string, home: string): ConfigSource[] {
  const sources: ConfigSource[] = [];
  for (const scope of ["project", "global"] as const) {
    const base = scope === "project" ? cwd : home;
    for (const candidate of CANDIDATES) {
      sources.push({ path: path.join(base, ".omp", candidate.name), scope, format: candidate.format });
    }
  }
  return sources;
}

/** A complete, valid configuration. Fresh objects on every call. */
export function defaultConfig(): RouterConfig {
  return {
    enabled: true,
    backend: "jev",
    jev: {
      endpoint: "https://api.typesafe.ai/v1/systemone",
      model: "jev-latest",
      apiKeyEnvVar: "TYPESAFE_API_KEY",
      timeoutMs: 3000,
    },
    laya: {
      // HTTP transport is opt-in; the default spawns the local sidecar.
      transport: "python",
      endpoint: "",
      apiKeyEnvVar: "",
      pythonBin: "python3",
      workerScript: "python/laya_worker.py",
      repo: "convaiinnovations/laya",
      subfolder: null,
      device: null,
      router: true,
      preload: true,
      timeoutMs: 4000,
      warmupTimeoutMs: 600000,
      hfTokenEnvVar: "HF_TOKEN",
    },
    routing: {
      questions: {
        task_complexity: {
          type: "choice",
          instructions: "How demanding is this request for an AI coding agent?",
          criteria: {
            trivial: "a single lookup, rename, or one-line answer; no exploration",
            standard: "a normal multi-step edit or investigation inside one or two files",
            hard: "large refactor, cross-cutting design, deep debugging, or long multi-file reasoning",
          },
        },
      },
      primaryQuestion: "task_complexity",
      modelMapping: { trivial: "@smol", standard: "@default", hard: "@slow" },
      fallbackChains: {
        "@smol": ["@smol", "@default"],
        "@default": ["@default", "@slow"],
        "@slow": ["@slow", "@default"],
      },
      confidenceThreshold: 0.5,
      defaultCategory: "standard",
    },
    circuitBreaker: { failureThreshold: 3, cooldownMs: 120000, halfOpenMaxTrials: 1 },
    dryRun: false,
    notify: true,
    applyTo: "all",
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Per-key merge for the routing maps. A non-empty plain object merges over the
 * defaults; anything else (including an explicitly empty object) replaces them,
 * so validation can reject the intent instead of silently keeping defaults.
 */
function mergeKeyMap<T>(base: Record<string, T>, override: Record<string, T> | undefined): Record<string, T> {
  if (override === undefined) return { ...base };
  if (!isPlainObject(override) || Object.keys(override).length === 0) return override;
  return { ...base, ...(override as Record<string, T>) };
}

/**
 * Layer a partial input over defaults. Sections merge one level deep and the
 * per-key maps (`questions`, `modelMapping`, `fallbackChains`) merge by key;
 * arrays and scalars replace wholesale. The input is never mutated.
 */
function mergeConfig(base: RouterConfig, input: RouterConfigInput): RouterConfig {
  const inputRouting = input.routing;
  const routing = base.routing;
  return {
    enabled: input.enabled ?? base.enabled,
    backend: input.backend ?? base.backend,
    dryRun: input.dryRun ?? base.dryRun,
    notify: input.notify ?? base.notify,
    applyTo: input.applyTo ?? base.applyTo,
    jev: { ...base.jev, ...(input.jev ?? {}) },
    laya: { ...base.laya, ...(input.laya ?? {}) },
    circuitBreaker: { ...base.circuitBreaker, ...(input.circuitBreaker ?? {}) },
    routing: {
      primaryQuestion: inputRouting?.primaryQuestion ?? routing.primaryQuestion,
      confidenceThreshold: inputRouting?.confidenceThreshold ?? routing.confidenceThreshold,
      // `null` is a meaningful value here, so an explicit null must survive `??`.
      defaultCategory:
        inputRouting?.defaultCategory !== undefined ? inputRouting.defaultCategory : routing.defaultCategory,
      questions: mergeKeyMap(routing.questions, inputRouting?.questions),
      modelMapping: mergeKeyMap(routing.modelMapping, inputRouting?.modelMapping),
      fallbackChains: mergeKeyMap(routing.fallbackChains, inputRouting?.fallbackChains),
    },
  };
}

/**
 * Validate a merged config. `input` is the caller's own file contents, when
 * available, so defaults the file never mentioned are not held against it.
 */
function validateConfig(config: RouterConfig, input?: RouterConfigInput): string[] {
  const errors: string[] = [];

  if (config.backend !== "jev" && config.backend !== "laya") {
    errors.push(`backend must be "jev" or "laya", got ${JSON.stringify(config.backend)}`);
  }

  const routing = config.routing;
  const questions = routing.questions;
  /** Criteria of the primary question, once it is known to be a usable choice. */
  let criteria: Record<string, unknown> | null = null;
  if (!isPlainObject(questions) || Object.keys(questions).length === 0) {
    errors.push("routing.questions must be a non-empty object of questions");
  } else if (!(routing.primaryQuestion in questions)) {
    errors.push(
      `routing.primaryQuestion ${JSON.stringify(routing.primaryQuestion)} is not present in routing.questions`,
    );
  } else {
    // Validate the merged question so a bad override cannot slip through.
    const primary: Question | undefined = questions[routing.primaryQuestion];
    if (primary === undefined || !isPlainObject(primary) || primary.type !== "choice") {
      errors.push(
        `routing.questions[${JSON.stringify(routing.primaryQuestion)}].type must be "choice"; ` +
          "score and noul answers cannot name a model category",
      );
    } else {
      criteria = isPlainObject(primary.criteria) ? primary.criteria : {};
    }
  }

  const mapping = routing.modelMapping;
  if (!isPlainObject(mapping) || Object.keys(mapping).length === 0) {
    errors.push("routing.modelMapping must be a non-empty object mapping categories to model specs");
  } else {
    for (const [category, spec] of Object.entries(mapping)) {
      if (typeof spec !== "string") {
        errors.push(`routing.modelMapping[${JSON.stringify(category)}] must be a string, got ${typeof spec}`);
      }
    }

    // Only keys the file itself declared are checked against the question's
    // criteria. The mapping merges per key over the defaults, so testing the
    // merged map would reject a custom question set for inheriting `trivial`
    // and friends from the defaults it never asked for.
    const declared = input?.routing?.modelMapping;
    const declaredKeys = isPlainObject(declared) ? Object.keys(declared) : [];
    for (const category of declaredKeys) {
      if (criteria === null || category in criteria) continue;
      const expected = Object.keys(criteria).map((name) => JSON.stringify(name)).join(", ") || "(none)";
      errors.push(
        `routing.modelMapping[${JSON.stringify(category)}] is not a category of ` +
          `routing.questions[${JSON.stringify(routing.primaryQuestion)}]; expected one of ${expected}`,
      );
    }

    // A fallback category that is not itself mapped cannot do anything.
    const fallback = routing.defaultCategory;
    if (fallback !== null && isNonEmptyString(fallback) && !(fallback in mapping)) {
      errors.push(
        `routing.defaultCategory ${JSON.stringify(fallback)} is not a key of routing.modelMapping, ` +
          "so the fallback can never be applied",
      );
    }
  }

  const threshold = routing.confidenceThreshold;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    errors.push(`routing.confidenceThreshold must be a number in [0, 1], got ${JSON.stringify(threshold)}`);
  }

  const chains = routing.fallbackChains;
  if (!isPlainObject(chains)) {
    errors.push("routing.fallbackChains must be an object of spec -> spec[] chains");
  } else {
    for (const [spec, chain] of Object.entries(chains)) {
      if (!Array.isArray(chain) || chain.length === 0 || !chain.every(isNonEmptyString)) {
        errors.push(
          `routing.fallbackChains[${JSON.stringify(spec)}] must be a non-empty array of non-empty strings`,
        );
      }
    }
  }

  const breaker = config.circuitBreaker;
  if (typeof breaker.failureThreshold !== "number" || breaker.failureThreshold < 1) {
    errors.push(`circuitBreaker.failureThreshold must be >= 1, got ${JSON.stringify(breaker.failureThreshold)}`);
  }
  if (typeof breaker.cooldownMs !== "number" || breaker.cooldownMs < 0) {
    errors.push(`circuitBreaker.cooldownMs must be >= 0, got ${JSON.stringify(breaker.cooldownMs)}`);
  }
  if (typeof breaker.halfOpenMaxTrials !== "number" || breaker.halfOpenMaxTrials < 1) {
    errors.push(`circuitBreaker.halfOpenMaxTrials must be >= 1, got ${JSON.stringify(breaker.halfOpenMaxTrials)}`);
  }

  if (typeof config.jev.timeoutMs !== "number" || config.jev.timeoutMs <= 0) {
    errors.push(`jev.timeoutMs must be > 0, got ${JSON.stringify(config.jev.timeoutMs)}`);
  }
  if (typeof config.laya.timeoutMs !== "number" || config.laya.timeoutMs <= 0) {
    errors.push(`laya.timeoutMs must be > 0, got ${JSON.stringify(config.laya.timeoutMs)}`);
  }

  const transport = config.laya.transport;
  if (transport !== "python" && transport !== "http") {
    errors.push(`laya.transport must be "python" or "http", got ${JSON.stringify(transport)}`);
  } else if (transport === "http") {
    const endpoint = config.laya.endpoint;
    if (!isNonEmptyString(endpoint)) {
      errors.push('laya.endpoint must be a non-empty URL when laya.transport is "http"');
    } else {
      let parsed: URL | null = null;
      try {
        parsed = new URL(endpoint);
      } catch {
        parsed = null;
      }
      if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
        errors.push(`laya.endpoint must be an http(s) URL, got ${JSON.stringify(endpoint)}`);
      }
    }
  }

  return errors;
}

/**
 * Walk the config paths in precedence order. Missing files everywhere resolve
 * to a null config without error; read/parse failures are recorded and the
 * search continues; a contract-violating file is rejected with a null config.
 */
export function loadConfig(
  cwd: string,
  home: string = os.homedir(),
  env: Record<string, string | undefined> = process.env,
  yaml: YamlParser | null = defaultYamlParser(),
): ConfigLoadResult {
  void env;
  const errors: string[] = [];

  for (const source of configPaths(cwd, home)) {
    let raw: string;
    try {
      raw = fs.readFileSync(source.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${source.scope} config ${source.path}: cannot read file: ${message}`);
      }
      continue;
    }

    let parsed: unknown;
    if (source.format === "yaml") {
      if (yaml === null) {
        errors.push(
          `${source.scope} config ${source.path}: YAML config needs a YAML parser and this host has none ` +
            `(only Bun provides one); use class-router.json instead`,
        );
        continue;
      }
      try {
        parsed = yaml(raw);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${source.scope} config ${source.path}: invalid YAML: ${message}`);
        continue;
      }
    } else {
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${source.scope} config ${source.path}: invalid JSON: ${message}`);
        continue;
      }
    }

    if (!isPlainObject(parsed)) {
      errors.push(`${source.scope} config ${source.path}: expected a ${source.format === "yaml" ? "YAML" : "JSON"} object at the top level`);
      continue;
    }

    const config = mergeConfig(defaultConfig(), parsed as RouterConfigInput);
    const validationErrors = validateConfig(config, parsed as RouterConfigInput);
    if (validationErrors.length > 0) {
      for (const message of validationErrors) {
        errors.push(`${source.scope} config ${source.path}: ${message}`);
      }
      return { config: null, source: null, errors };
    }

    return { config, source, errors };
  }

  return { config: null, source: null, errors };
}
