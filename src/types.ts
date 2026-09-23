/**
 * Frozen shared contract for the classifier router.
 *
 * Every module in this package depends only on this file, so the four
 * implementation slices (config, router/breaker, classifiers, extension wiring)
 * never need to agree on anything else.
 *
 * Question/Answer shapes mirror both supported backends, which speak the same
 * wire format:
 *  - Jev  (TypeSafe) `POST /v1/systemone` -> `{ model, answers, usage }`
 *  - Laya (local, via python sidecar)     -> `{ model, answers, usage }`
 * Keeping one answer type means routing logic is backend-agnostic.
 */

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/** `instructions` / criterion descriptions accept structured payloads, per TypeSafe. */
export type InstructionValue = string | Record<string, unknown> | unknown[];

export interface ChoiceQuestion {
  type: "choice";
  instructions: InstructionValue;
  /** Option id -> rubric description (null when the id is self-describing). */
  criteria: Record<string, InstructionValue | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: InstructionValue;
  /** Ordered, at least two levels, lowest first. */
  criteria: InstructionValue[];
}

export interface NoulQuestion {
  type: "noul";
  instructions: InstructionValue;
  criteria?: { true?: InstructionValue; false?: InstructionValue };
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

/** Question id -> question. Ids are for code and are never sent to the model. */
export type Questions = Record<string, Question>;

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  /** Every option mapped to its probability. */
  probabilities: Record<string, number>;
  /** 0..1, derived from the probability distribution. */
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted value across the levels; may land between levels. */
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  /** Probability the answer is yes, 0..1. */
  noul: number;
  confidence: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export type Answers = Record<string, Answer>;

/** Normalized backend reply. `answers` is the only field routing reads. */
export interface ClassificationResult {
  model?: string;
  answers: Answers;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** The state handed to a classifier: prompt text, or a structured document. */
export type ClassifierState = string | Record<string, unknown> | unknown[];

// ---------------------------------------------------------------------------
// Classifiers
// ---------------------------------------------------------------------------

export interface ClassifyOptions {
  signal?: AbortSignal;
}

/**
 * A classifier turns state + typed questions into typed answers.
 *
 * Implementations MUST throw `ClassifierError` on any failure (transport,
 * auth, timeout, malformed reply). They MUST NOT throw for a well-formed reply
 * that merely lacks a question id; callers treat missing answers as absent.
 */
export interface Classifier {
  /** Stable backend id, e.g. `"jev"` or `"laya"`. */
  readonly name: string;
  /**
   * Optional: make the backend ready before the first classification.
   * `classify` MUST still work without a prior `warmup` call.
   */
  warmup?(options?: ClassifyOptions): Promise<void>;
  classify(state: ClassifierState, questions: Questions, options?: ClassifyOptions): Promise<ClassificationResult>;
  /** Release resources (HTTP handles, sidecar processes). Idempotent. */
  dispose(): Promise<void>;
}

export type ClassifierErrorCode = "unavailable" | "timeout" | "auth" | "transport" | "protocol" | "aborted";

export class ClassifierError extends Error {
  readonly code: ClassifierErrorCode;
  readonly backend: string;

  constructor(backend: string, code: ClassifierErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClassifierError";
    this.backend = backend;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface JevBackendConfig {
  /** Evaluation endpoint, e.g. `https://api.typesafe.ai/v1/systemone`. */
  endpoint: string;
  /** Model alias sent with the request, e.g. `jev-latest`. */
  model: string;
  /** Environment variable holding the bearer token. */
  apiKeyEnvVar: string;
  timeoutMs: number;
}

/** Where Laya inference runs: the local python sidecar, or a remote HTTP host. */
export type LayaTransport = "python" | "http";

/**
 * Laya System-One backend.
 *
 * `transport` selects the implementation: `"python"` spawns the local sidecar
 * worker, `"http"` posts typed questions to `endpoint` and needs no local
 * install. The python-only fields below are ignored when
 * `transport === "http"`; `endpoint`/`apiKeyEnvVar` are ignored when
 * `transport === "python"`.
 *
 * The http transport sends no `model` field: the remote host owns checkpoint
 * selection, so there is deliberately no `model` here.
 */
export interface LayaBackendConfig {
  /** Where inference runs. */
  transport: LayaTransport;
  /** Full URL of a System-One-compatible endpoint; used when `transport === "http"`. */
  endpoint: string;
  /**
   * Env var holding an optional bearer token for `endpoint`; an unset or empty
   * value means no `Authorization` header is sent.
   */
  apiKeyEnvVar: string;
  /** Python interpreter used to run the sidecar worker. Ignored for `"http"`. */
  pythonBin: string;
  /** Path to `python/laya_worker.py`, absolute or relative to the extension root. */
  workerScript: string;
  /** Hugging Face repo bundling the checkpoints. */
  repo: string;
  /** Checkpoint subfolder: `null` = English root, `"multilingual"`, `"typed-decisions"`. */
  subfolder: string | null;
  /** Torch device (`cpu`, `cuda`, `mps`), or `null` for auto-detect. */
  device: string | null;
  /**
   * Serve every checkpoint through `laya.Router` (adds multilingual routing).
   * The Router always serves the upstream `convaiinnovations/laya` checkpoints,
   * so `repo` and `subfolder` cannot be combined with it.
   */
  router: boolean;
  /**
   * Checkpoints `laya.Router` keeps resident; `null` keeps Laya's own default
   * (English + multilingual). Only meaningful with `router: true`.
   */
  maxLoaded: number | null;
  /** Load weights during `warmup` instead of on the first classification. */
  preload: boolean;
  /** Per-classification budget; exceeding it fails the call. */
  timeoutMs: number;
  /** Budget for loading weights during `warmup`. */
  warmupTimeoutMs: number;
  /** Environment variable holding the Hugging Face token, if the repo is gated. */
  hfTokenEnvVar: string;
}

export interface RoutingConfig {
  /** Typed questions sent to the classifier. MUST contain `primaryQuestion`. */
  questions: Questions;
  /**
   * Question id whose answer selects the model. MUST be a `choice` question;
   * score/noul answers cannot name a category. Other questions are collected
   * and reported but do not affect routing.
   */
  primaryQuestion: string;
  /** Category -> model spec, resolved through `ctx.models.resolve()`. */
  modelMapping: Record<string, string>;
  /**
   * Model spec -> ordered candidate specs tried when the circuit is open.
   * A spec with no entry falls back to itself. Chain entries are specs, not
   * mapped categories.
   */
  fallbackChains: Record<string, string[]>;
  /**
   * Minimum primary-answer confidence required to override the model.
   * Below it the session model is left alone.
   */
  confidenceThreshold: number;
  /** Category used when the primary answer is missing/unknown. `null` = no override. */
  defaultCategory: string | null;
}

/** Which sessions this router governs. */
export type ApplyTo = "all" | "main" | "subagents";

export interface CircuitBreakerConfig {
  /** Consecutive failures that open a circuit. */
  failureThreshold: number;
  /** How long an open circuit stays open before half-open trials. */
  cooldownMs: number;
  /** Allow one trial request through while half-open. */
  halfOpenMaxTrials: number;
}

export interface RouterConfig {
  enabled: boolean;
  backend: "jev" | "laya";
  jev: JevBackendConfig;
  laya: LayaBackendConfig;
  routing: RoutingConfig;
  circuitBreaker: CircuitBreakerConfig;
  /** Classify and log, but never change the model. */
  dryRun: boolean;
  /** Surface routing decisions through `ui.notify`. */
  notify: boolean;
  applyTo: ApplyTo;
}

/** Deep-partial config accepted from disk; defaults are layered over it. */
export interface RouterConfigInput {
  enabled?: boolean;
  backend?: RouterConfig["backend"];
  jev?: Partial<JevBackendConfig>;
  laya?: Partial<LayaBackendConfig>;
  routing?: Partial<RoutingConfig>;
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  dryRun?: boolean;
  notify?: boolean;
  applyTo?: ApplyTo;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/** Why a routing decision did or did not change the model. */
export type DecisionReason =
  | "routed"
  | "disabled"
  | "no-questions"
  | "missing-answer"
  | "low-confidence"
  | "unknown-category"
  | "unmapped-category"
  | "all-circuits-open";

export interface Decision {
  /** Chosen category, or null when the answer was unusable. */
  category: string | null;
  /** Confidence of the primary answer, 0 when absent. */
  confidence: number;
  /** Mapped model spec, before circuit filtering. Null when unmapped. */
  spec: string | null;
  /** Ordered candidate specs to try, already circuit-filtered. */
  chain: string[];
  /** Spec to apply, or null when the session model must be left alone. */
  apply: string | null;
  reason: DecisionReason;
  /** One-line human-readable explanation. */
  detail: string;
  /** Other question answers, carried for reporting. */
  extra: Record<string, Answer>;
}
