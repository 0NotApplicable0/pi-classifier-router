/**
 * Config discovery, defaults, merge, and validation.
 *
 * Precedence is project over global; within a scope JSON is preferred over YAML.
 * Project files are read only for a trusted project: a config can name the
 * executable the Laya sidecar spawns and the endpoint that receives prompts and
 * a bearer token, so a cloned repository must not be able to supply one.
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

export interface ConfigLoadOptions {
  /**
   * Whether the host trusts the project at `cwd`. When false, project-scope
   * files are skipped (and reported) and only the global scope is searched.
   */
  projectTrusted?: boolean;
}

export interface ConfigLoadResult {
  config: RouterConfig | null;
  source: ConfigSource | null;
  errors: string[];
  /** Non-fatal findings, such as unknown (likely misspelled) keys. */
  warnings: string[];
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

/** Every key the config understands, per section, derived from the defaults. */
function knownKeys(): Record<string, readonly string[]> {
  const base = defaultConfig();
  return {
    "": Object.keys(base),
    jev: Object.keys(base.jev),
    laya: Object.keys(base.laya),
    routing: Object.keys(base.routing),
    circuitBreaker: Object.keys(base.circuitBreaker),
  };
}

/** Keys a question object may carry. Criteria ids are free-form and not checked. */
const QUESTION_KEYS: readonly string[] = ["type", "instructions", "criteria"];

/** Classic edit distance, for "did you mean" hints on short config keys. */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j]!;
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/** `$`-prefixed keys (`$comment`, `$schema`) are annotations JSON has no other room for. */
function isAnnotation(key: string): boolean {
  return key.startsWith("$");
}

function unknownKeyMessage(where: string, key: string, known: readonly string[]): string {
  const name = where === "" ? key : `${where}.${key}`;
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  const hint = best !== null && bestDistance <= 2 ? `; did you mean ${JSON.stringify(best)}?` : "";
  return `unknown key "${name}" is ignored${hint}`;
}

/**
 * Keys the file sets that the config does not understand. A misspelled key is
 * otherwise silently replaced by its default, which looks exactly like the
 * setting having no effect.
 */
function findUnknownKeys(input: Record<string, unknown>): string[] {
  const known = knownKeys();
  const warnings: string[] = [];
  for (const key of Object.keys(input)) {
    if (!isAnnotation(key) && !known[""]!.includes(key)) warnings.push(unknownKeyMessage("", key, known[""]!));
  }
  for (const section of ["jev", "laya", "routing", "circuitBreaker"] as const) {
    const value = input[section];
    if (!isPlainObject(value)) continue;
    for (const key of Object.keys(value)) {
      if (!isAnnotation(key) && !known[section]!.includes(key)) warnings.push(unknownKeyMessage(section, key, known[section]!));
    }
  }
  const routing = input["routing"];
  const questions = isPlainObject(routing) ? routing["questions"] : undefined;
  if (isPlainObject(questions)) {
    for (const [id, question] of Object.entries(questions)) {
      if (!isPlainObject(question)) continue;
      for (const key of Object.keys(question)) {
        if (!isAnnotation(key) && !QUESTION_KEYS.includes(key)) {
          warnings.push(unknownKeyMessage(`routing.questions[${JSON.stringify(id)}]`, key, QUESTION_KEYS));
        }
      }
    }
  }
  return warnings;
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
 * per-key maps (`modelMapping`, `fallbackChains`) merge by key; arrays and
 * scalars replace wholesale. `questions` also replaces wholesale: every question
 * is sent to the classifier on every prompt, so a file that declares its own set
 * must not also pay for default questions it never asked. The input is never
 * mutated.
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
      questions: inputRouting?.questions !== undefined ? inputRouting.questions : { ...routing.questions },
      modelMapping: mergeKeyMap(routing.modelMapping, inputRouting?.modelMapping),
      fallbackChains: mergeKeyMap(routing.fallbackChains, inputRouting?.fallbackChains),
    },
  };
}

/**
 * Validate a merged config. `input` is the caller's own file contents, when
 * available, so defaults the file never mentioned are not held against it.
 */
/**
 * Sections must be objects before merging: a non-object section would be
 * spread key-by-key (a string into its characters).
 */
function validateSections(input: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const section of ["jev", "laya", "routing", "circuitBreaker"] as const) {
    const value = input[section];
    if (value !== undefined && !isPlainObject(value)) {
      errors.push(`${section} must be an object, got ${describe(value)}`);
    }
  }
  return errors;
}

function validateConfig(config: RouterConfig, input?: RouterConfigInput): string[] {
  const errors: string[] = [];

  if (config.backend !== "jev" && config.backend !== "laya") {
    errors.push(`backend must be "jev" or "laya", got ${JSON.stringify(config.backend)}`);
  }
  for (const key of ["enabled", "dryRun", "notify"] as const) {
    if (typeof config[key] !== "boolean") errors.push(`${key} must be true or false, got ${describe(config[key])}`);
  }
  if (config.applyTo !== "all" && config.applyTo !== "main" && config.applyTo !== "subagents") {
    errors.push(`applyTo must be "all", "main", or "subagents", got ${describe(config.applyTo)}`);
  }

  const routing = config.routing;
  const questions = routing.questions;
  /** Criteria of the primary question, once it is known to be a usable choice. */
  let criteria: Record<string, unknown> | null = null;
  if (!isNonEmptyString(routing.primaryQuestion)) {
    errors.push(`routing.primaryQuestion must be a non-empty string, got ${describe(routing.primaryQuestion)}`);
  } else if (!isPlainObject(questions) || Object.keys(questions).length === 0) {
    errors.push("routing.questions must be a non-empty object of questions");
  } else if (!(routing.primaryQuestion in questions)) {
    const declared = isPlainObject(input?.routing?.questions);
    errors.push(
      `routing.primaryQuestion ${JSON.stringify(routing.primaryQuestion)} is not present in routing.questions` +
        (declared ? " (a declared question set replaces the default questions entirely)" : ""),
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

  if (isPlainObject(questions)) {
    for (const [id, question] of Object.entries(questions)) errors.push(...validateQuestion(id, question));
  }

  const defaultCategory: unknown = routing.defaultCategory;
  if (defaultCategory !== null && typeof defaultCategory !== "string") {
    errors.push(`routing.defaultCategory must be a string or null, got ${describe(defaultCategory)}`);
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
  if (!isNumber(breaker.failureThreshold) || breaker.failureThreshold < 1) {
    errors.push(`circuitBreaker.failureThreshold must be >= 1, got ${JSON.stringify(breaker.failureThreshold)}`);
  }
  if (!isNumber(breaker.cooldownMs) || breaker.cooldownMs < 0) {
    errors.push(`circuitBreaker.cooldownMs must be >= 0, got ${JSON.stringify(breaker.cooldownMs)}`);
  }
  if (!isNumber(breaker.halfOpenMaxTrials) || breaker.halfOpenMaxTrials < 1) {
    errors.push(`circuitBreaker.halfOpenMaxTrials must be >= 1, got ${JSON.stringify(breaker.halfOpenMaxTrials)}`);
  }

  const jev = config.jev;
  if (!isNumber(jev.timeoutMs) || jev.timeoutMs <= 0) {
    errors.push(`jev.timeoutMs must be > 0, got ${JSON.stringify(jev.timeoutMs)}`);
  }
  if (!isHttpUrl(jev.endpoint)) errors.push(`jev.endpoint must be an http(s) URL, got ${describe(jev.endpoint)}`);
  if (!isNonEmptyString(jev.model)) errors.push(`jev.model must be a non-empty string, got ${describe(jev.model)}`);
  if (typeof jev.apiKeyEnvVar !== "string") {
    errors.push(`jev.apiKeyEnvVar must be a string, got ${describe(jev.apiKeyEnvVar)}`);
  }

  const laya = config.laya;
  if (!isNumber(laya.timeoutMs) || laya.timeoutMs <= 0) {
    errors.push(`laya.timeoutMs must be > 0, got ${JSON.stringify(laya.timeoutMs)}`);
  }
  if (!isNumber(laya.warmupTimeoutMs) || laya.warmupTimeoutMs <= 0) {
    errors.push(`laya.warmupTimeoutMs must be > 0, got ${JSON.stringify(laya.warmupTimeoutMs)}`);
  }
  for (const key of ["pythonBin", "workerScript", "repo"] as const) {
    if (!isNonEmptyString(laya[key])) errors.push(`laya.${key} must be a non-empty string, got ${describe(laya[key])}`);
  }
  for (const key of ["apiKeyEnvVar", "hfTokenEnvVar"] as const) {
    if (typeof laya[key] !== "string") errors.push(`laya.${key} must be a string, got ${describe(laya[key])}`);
  }
  for (const key of ["subfolder", "device"] as const) {
    const value: unknown = laya[key];
    if (value !== null && typeof value !== "string") {
      errors.push(`laya.${key} must be a string or null, got ${describe(value)}`);
    }
  }
  for (const key of ["router", "preload"] as const) {
    if (typeof laya[key] !== "boolean") errors.push(`laya.${key} must be true or false, got ${describe(laya[key])}`);
  }

  const transport = config.laya.transport;
  if (transport !== "python" && transport !== "http") {
    errors.push(`laya.transport must be "python" or "http", got ${JSON.stringify(transport)}`);
  } else if (transport === "http") {
    const endpoint = config.laya.endpoint;
    if (!isNonEmptyString(endpoint)) {
      errors.push('laya.endpoint must be a non-empty URL when laya.transport is "http"');
    } else {
      if (!isHttpUrl(endpoint)) errors.push(`laya.endpoint must be an http(s) URL, got ${JSON.stringify(endpoint)}`);
    }
  }

  return errors;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** A short, type-revealing rendering of a bad value for error messages. */
function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  const json = JSON.stringify(value);
  return `${Array.isArray(value) ? "array" : value === null ? "null" : typeof value} ${json.length > 60 ? `${json.slice(0, 57)}...` : json}`;
}

function isInstruction(value: unknown): boolean {
  return isNonEmptyString(value) || isPlainObject(value) || Array.isArray(value);
}

/**
 * The shape every question must have before it is sent to a backend. A
 * malformed question otherwise surfaces only as a protocol error on every
 * prompt, long after the config was loaded.
 */
function validateQuestion(id: string, question: unknown): string[] {
  const where = `routing.questions[${JSON.stringify(id)}]`;
  if (!isPlainObject(question)) return [`${where} must be an object, got ${describe(question)}`];
  const errors: string[] = [];
  if (!isInstruction(question["instructions"])) {
    errors.push(`${where}.instructions must be a non-empty string or a structured object/array`);
  }
  const criteria = question["criteria"];
  switch (question["type"]) {
    case "choice":
      if (!isPlainObject(criteria) || Object.keys(criteria).length < 2) {
        errors.push(`${where}.criteria must be an object with at least two options for a choice question`);
      }
      break;
    case "score":
      if (!Array.isArray(criteria) || criteria.length < 2) {
        errors.push(`${where}.criteria must be an array of at least two levels for a score question`);
      }
      break;
    case "noul":
      if (criteria !== undefined && !isPlainObject(criteria)) {
        errors.push(`${where}.criteria must be an object with optional "true"/"false" entries for a noul question`);
      }
      break;
    default:
      errors.push(`${where}.type must be "choice", "score", or "noul", got ${describe(question["type"])}`);
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
  options: ConfigLoadOptions = {},
): ConfigLoadResult {
  void env;
  const errors: string[] = [];
  const warnings: string[] = [];
  const projectTrusted = options.projectTrusted ?? true;
  // Run from the home directory, the project scope IS the global scope.
  const projectIsHome = path.resolve(cwd) === path.resolve(home);

  for (const source of configPaths(cwd, home)) {
    if (source.scope === "project" && (projectIsHome || !projectTrusted)) {
      if (!projectIsHome && fs.existsSync(source.path)) {
        errors.push(
          `project config ${source.path}: ignored because this project is not trusted; ` +
            "trust the project in the host to use it",
        );
      }
      continue;
    }

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

    for (const message of findUnknownKeys(parsed)) {
      warnings.push(`${source.scope} config ${source.path}: ${message}`);
    }

    const input = parsed as RouterConfigInput;
    const sectionErrors = validateSections(parsed);
    const config = sectionErrors.length > 0 ? null : mergeConfig(defaultConfig(), input);
    const validationErrors = config === null ? sectionErrors : validateConfig(config, input);
    if (config === null || validationErrors.length > 0) {
      for (const message of validationErrors) {
        errors.push(`${source.scope} config ${source.path}: ${message}`);
      }
      return { config: null, source: null, errors, warnings };
    }

    return { config, source, errors, warnings };
  }

  return { config: null, source: null, errors, warnings };
}
