/**
 * Class Router: classify each prompt with a System-One backend (Jev over HTTP,
 * or Laya through a local Python sidecar) and route the session to the best
 * model, with a per-spec circuit breaker and fallback chains.
 *
 * Types come from the upstream pi extension API so one entry point loads on
 * both pi and Oh My Pi (omp); omp-only capabilities are feature-detected through
 * `./host.ts`. Load-time work is registration only. Every runtime behaviour
 * hangs off an event handler or the `/class-router` command, and nothing on the
 * routing path may break a turn: a failed classification degrades to the
 * session's own model.
 */

import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { CircuitBreaker } from "./breaker.ts";
import type { BreakerSnapshot } from "./breaker.ts";
import { createClassifier } from "./classify/index.ts";
import { defaultConfig, loadConfig } from "./config.ts";
import type { ConfigSource } from "./config.ts";
import {
  applyModel,
  currentModel,
  detectHost,
  hasConfiguredAuth,
  log,
  registerEvent,
  resolveModel,
  startTimer,
} from "./host.ts";
import { decide } from "./router.ts";
import { ClassifierError } from "./types.ts";
import type { Answer, ClassificationResult, Classifier, Decision, DecisionReason, RouterConfig } from "./types.ts";

const NOTIFY_PREFIX = "[class-router]";
const HISTORY_LIMIT = 50;
/** Slack between the backend's own timeout and the outer "never hang" guard. */
const HARD_GUARD_SLACK_MS = 250;
const SUBCOMMANDS = ["status", "on", "off", "reset", "explain"] as const;

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

export type FailureReason = "rate_limit" | "overloaded" | "auth" | "transport" | "other";

/**
 * Map a provider error string onto the breaker's coarse failure taxonomy.
 *
 * The order matters: a 429 that also mentions a timeout is a rate limit, and
 * an aborted request is transport noise even when the message embeds a status.
 */
export function classifyFailure(errorMessage: string): FailureReason {
  const text = errorMessage.toLowerCase();
  if (/(\b429\b|rate[ _-]?limit|too many requests|quota)/.test(text)) return "rate_limit";
  if (/(\b503\b|overloaded|capacity|temporarily unavailable)/.test(text)) return "overloaded";
  if (/(\b401\b|\b403\b|invalid api key|unauthorized|api key|authentication)/.test(text)) return "auth";
  if (/(abort|econnreset|etimedout|econnrefused|socket hang up|network|fetch failed)/.test(text)) return "transport";
  return "other";
}

// ---------------------------------------------------------------------------
// Prompt handling
// ---------------------------------------------------------------------------

/**
 * Whether a prompt is a slash command rather than work to classify. Only the
 * first word counts, and it must look like a command name: `/review now` is a
 * command, but `/home/me/app.ts is failing` and `/tmp/x.log shows...` start
 * with a path and are real requests.
 */
export function isSlashCommand(trimmed: string): boolean {
  const first = trimmed.split(/\s/, 1)[0] ?? "";
  return /^\/[A-Za-z][\w:-]*$/.test(first);
}

/**
 * Bound a prompt to `max` characters, keeping its start and end around an
 * omission marker; `null` or a short prompt is returned unchanged. Boundaries
 * never split a surrogate pair.
 */
export function clipPrompt(prompt: string, max: number | null): string {
  if (max === null || prompt.length <= max) return prompt;
  let head = Math.ceil(max / 2);
  let tailStart = prompt.length - (max - head);
  if (isLowSurrogate(prompt.charCodeAt(head))) head -= 1;
  if (isLowSurrogate(prompt.charCodeAt(tailStart))) tailStart += 1;
  const omitted = tailStart - head;
  return `${prompt.slice(0, head)}\n\n[... ${omitted} characters omitted ...]\n\n${prompt.slice(tailStart)}`;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

/** Why an attempt produced no decision at all. */
type NoDecisionReason = "classification-failed" | "backend-unavailable";

/** One routing attempt, whether or not it produced a model. */
interface RouteRecord {
  category: string | null;
  confidence: number;
  spec: string | null;
  apply: string | null;
  /** Model id the chosen spec resolved to, when one resolved. */
  resolved: string | null;
  /** True only when the session model actually moved. */
  changed: boolean;
  reason: DecisionReason | NoDecisionReason;
  backend: RouterConfig["backend"];
  latencyMs: number;
  at: number;
  /** Failure code, present only on a `classification-failed` attempt. */
  error?: string;
}

/** What applying a decision did to the session model. */
interface AppliedModel {
  resolved: string | null;
  changed: boolean;
  /** True when the decided spec is the one this turn runs on (changed or already current). */
  active: boolean;
}

const NOT_APPLIED: AppliedModel = { resolved: null, changed: false, active: false };

interface PendingFailure {
  reason: FailureReason;
  message: string;
}

interface SessionState {
  sessionId: string;
  cwd: string;
  /** Project trust the config was loaded under; a change forces a reload. */
  projectTrusted: boolean;
  config: RouterConfig;
  /** Breaker for this session's `circuitBreaker` settings, shared with matching sessions. */
  breaker: CircuitBreaker;
  /** Key of the shared classifier this session holds, or null when it holds none. */
  classifierKey: string | null;
  source: ConfigSource | null;
  errors: string[];
  sourceNotified: boolean;
  authNotified: boolean;
  lastDecision: Decision | null;
  lastRecord: RouteRecord | null;
  /** Spec this extension last applied, or null when it changed nothing. */
  appliedSpec: string | null;
  /** Model id that spec resolved to, for "is it still our model?" comparisons. */
  appliedModelId: string | null;
  pendingFailure: PendingFailure | null;
  /** One breaker failure per run, so a retry storm is not counted repeatedly. */
  failureRecorded: boolean;
  /**
   * Spec whose breaker probe slot this session holds, or null. A half-open
   * circuit admits a bounded number of probes, so a slot claimed for a run that
   * never settles an outcome must be released or the circuit never recovers.
   */
  probeSpec: string | null;
  history: RouteRecord[];
  routed: number;
  skipped: number;
  failed: number;
}

const sessions = new Map<string, SessionState>();

/** A classifier shared by every session whose backend configuration matches. */
interface ClassifierEntry {
  classifier: Classifier;
  /** Sessions using it; the classifier is disposed when the last one leaves. */
  sessions: Set<string>;
}

/**
 * Classifiers and breakers are cached per configuration, not per process.
 * Sessions in one process (a parent and its subagents, or several projects)
 * may load different configs; a single slot made them evict each other's
 * classifier on every prompt, and for Laya each eviction killed the sidecar and
 * reloaded its checkpoints.
 */
const classifiers = new Map<string, ClassifierEntry>();

/**
 * Breakers are tiny and hold per-spec health worth keeping across sessions, so
 * they are never evicted: a session that reopens with the same thresholds sees
 * the circuits it left.
 */
const breakers = new Map<string, CircuitBreaker>();

function sessionKey(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return "unknown";
  }
}

/**
 * Best-effort subagent detection.
 *
 * omp 18.2.9 exposes no supported "am I a subagent?" signal: `ExtensionContext`
 * carries no agent kind, `session_start` carries no reason, `getHeader()` has no
 * `parentSession` for task subagents (only for forks), and subagents share the
 * parent's process. The session file path is the one reliable discriminator, so
 * this depends on omp's on-disk session layout rather than an API guarantee:
 * the default layout nests a subagent under `omp-task-<hex>/`, and an explicit
 * `--session-dir` nests it under a directory whose basename is the parent's own
 * `.jsonl` file. An unknown path fails safe toward MAIN.
 */
function isSubagentSession(ctx: ExtensionContext): boolean {
  let file: string | undefined;
  try {
    file = ctx.sessionManager.getSessionFile();
  } catch {
    return false;
  }
  if (typeof file !== "string" || file === "") return false;
  if (/[/\\]omp-task-[0-9a-f]+[/\\]/.test(file)) return true;
  return path.basename(path.dirname(file)).endsWith(".jsonl");
}

/**
 * Whether the host trusts the session's project. Anything but an explicit
 * `true` (a missing method, a throw) is untrusted: project config can pick the
 * executable the Laya sidecar runs and where prompts and tokens are sent.
 */
function isProjectTrusted(ctx: ExtensionContext): boolean {
  try {
    return typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted() === true;
  } catch {
    return false;
  }
}

function breakerFor(config: RouterConfig, pi: ExtensionAPI): CircuitBreaker {
  const key = JSON.stringify(config.circuitBreaker);
  const existing = breakers.get(key);
  if (existing !== undefined) return existing;
  const created = new CircuitBreaker(config.circuitBreaker);
  breakers.set(key, created);
  log(pi, "debug", "class-router: circuit breaker configured", { config: config.circuitBreaker });
  return created;
}

/** Hand back a probe slot this session claimed but will not settle. */
function releaseProbe(state: SessionState): void {
  const spec = state.probeSpec;
  if (spec === null) return;
  state.probeSpec = null;
  state.breaker.release(spec);
}

function classifierKeyOf(config: RouterConfig): string {
  return JSON.stringify({ backend: config.backend, jev: config.jev, laya: config.laya });
}

/** Drop this session's hold on its classifier, disposing it if no one else uses it. */
function detachClassifier(state: SessionState, pi: ExtensionAPI): void {
  const key = state.classifierKey;
  if (key === null) return;
  state.classifierKey = null;
  const entry = classifiers.get(key);
  if (entry === undefined) return;
  entry.sessions.delete(state.sessionId);
  if (entry.sessions.size > 0) return;
  classifiers.delete(key);
  void entry.classifier.dispose().catch(() => undefined);
  log(pi, "debug", "class-router: classifier disposed");
}

/**
 * The classifier for this session's backend configuration, shared with every
 * session whose configuration matches, and built on first use.
 */
function getClassifier(state: SessionState, pi: ExtensionAPI): Classifier | null {
  const key = classifierKeyOf(state.config);
  if (state.classifierKey !== key) detachClassifier(state, pi);

  let entry = classifiers.get(key);
  if (entry === undefined) {
    try {
      entry = { classifier: createClassifier(state.config), sessions: new Set() };
    } catch (error) {
      // A backend that cannot even be constructed must not take the extension down.
      const message = error instanceof Error ? error.message : String(error);
      log(pi, "warn", "class-router: classifier construction failed", {
        backend: state.config.backend,
        error: message,
      });
      return null;
    }
    classifiers.set(key, entry);
  }
  entry.sessions.add(state.sessionId);
  state.classifierKey = key;
  return entry.classifier;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Resolve the session's state, loading (or reloading, after a `/move`) config.
 * A missing config file is not an error: defaults apply.
 */
function ensureSession(ctx: ExtensionContext, pi: ExtensionAPI): SessionState {
  const sessionId = sessionKey(ctx);
  let state = sessions.get(sessionId);

  const projectTrusted = isProjectTrusted(ctx);
  if (state !== undefined && state.cwd === ctx.cwd && state.projectTrusted === projectTrusted) return state;

  const result = loadConfig(ctx.cwd, undefined, undefined, undefined, { projectTrusted });
  const cwdChanged = state !== undefined && state.cwd !== ctx.cwd;
  const trustChanged = state !== undefined && state.projectTrusted !== projectTrusted;

  if (state === undefined) {
    const config = result.config ?? defaultConfig();
    state = {
      sessionId,
      cwd: ctx.cwd,
      projectTrusted,
      config,
      breaker: breakerFor(config, pi),
      classifierKey: null,
      source: result.source,
      errors: result.errors,
      sourceNotified: false,
      authNotified: false,
      lastDecision: null,
      lastRecord: null,
      appliedSpec: null,
      appliedModelId: null,
      pendingFailure: null,
      failureRecorded: false,
      probeSpec: null,
      history: [],
      routed: 0,
      skipped: 0,
      failed: 0,
    };
    sessions.set(sessionId, state);
  } else {
    state.cwd = ctx.cwd;
    state.projectTrusted = projectTrusted;
    state.config = result.config ?? defaultConfig();
    // A held probe belongs to the old breaker; hand it back before switching.
    releaseProbe(state);
    state.breaker = breakerFor(state.config, pi);
    state.source = result.source;
    state.errors = result.errors;
  }

  for (const error of result.errors) {
    ctx.ui.notify(`${NOTIFY_PREFIX} config error: ${oneLine(error)}`, "error");
  }
  for (const warning of result.warnings) {
    ctx.ui.notify(`${NOTIFY_PREFIX} config warning: ${oneLine(warning)}`, "warning");
  }

  if (cwdChanged || trustChanged) {
    // A reload resets runtime toggles, so say so instead of silently reverting.
    ctx.ui.notify(`${NOTIFY_PREFIX} config reloaded for ${ctx.cwd}`);
  }

  reportSource(ctx, state);
  return state;
}

function reportSource(ctx: ExtensionContext, state: SessionState): void {
  if (state.sourceNotified || !state.config.notify) return;
  state.sourceNotified = true;
  const where = state.source === null ? "none (built-in defaults)" : `${state.source.path} (${state.source.scope})`;
  ctx.ui.notify(`${NOTIFY_PREFIX} config: ${oneLine(where)} | backend ${state.config.backend}`);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Notifications are one line each; collapse any whitespace that slipped in. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function notify(
  ctx: ExtensionContext,
  state: SessionState | null,
  message: string,
  type?: "info" | "warning" | "error",
): void {
  if (state !== null && !state.config.notify && type !== "error") return;
  ctx.ui.notify(`${NOTIFY_PREFIX} ${oneLine(message)}`, type);
}

function formatAnswer(answer: Answer): string {
  if (answer.type === "choice") return `choice=${answer.choice} (confidence ${answer.confidence.toFixed(2)})`;
  if (answer.type === "score") return `score=${answer.score.toFixed(2)} (confidence ${answer.confidence.toFixed(2)})`;
  return `noul=${answer.noul.toFixed(2)} (confidence ${answer.confidence.toFixed(2)})`;
}

function formatBreaker(snapshot: BreakerSnapshot[]): string {
  if (snapshot.length === 0) return "no circuits tracked";
  return snapshot.map((entry) => `${entry.spec}=${entry.state}/${entry.failures}`).join(", ");
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify with the backend's own timeout plus an independent outer guard, so a
 * backend that ignores its abort signal still cannot hang the turn.
 *
 * The backend owns the budget: both clients time out at `timeoutMs` and report
 * `timeout`. The guard fires only `HARD_GUARD_SLACK_MS` later, so it never
 * pre-empts the backend's own timer; if it aborted at the same moment, the
 * backend would see a caller abort and a slow call would be logged as
 * `aborted` rather than `timeout`.
 */
async function classifyGuarded(
  classifier: Classifier,
  prompt: string,
  config: RouterConfig,
  ctx: ExtensionContext,
): Promise<ClassificationResult> {
  const budgetMs = config.backend === "laya" ? config.laya.timeoutMs : config.jev.timeoutMs;
  const capabilities = detectHost(ctx);
  const controller = new AbortController();

  let cancelGuard = (): void => {};
  const hardGuard = new Promise<never>((_resolve, reject) => {
    // Timers must be host-managed where possible: omp's `ctx.setTimeout` is
    // unref'd, contains its callback's throws, and is cleared on session
    // shutdown, which a raw timer would outlive. `startTimer` uses the managed
    // surface when the host has one and a raw timer otherwise.
    const timer = startTimer(
      capabilities,
      () => {
        // Settle the race as a timeout BEFORE aborting: an abort listener can
        // reject the backend's promise synchronously, as a caller abort.
        reject(new ClassifierError(classifier.name, "timeout", `classification exceeded ${budgetMs}ms hard guard`));
        controller.abort();
      },
      budgetMs + HARD_GUARD_SLACK_MS,
    );
    cancelGuard = () => timer.cancel();
  });
  // The guard must never surface as an unhandled rejection once the race settles.
  hardGuard.catch(() => undefined);

  try {
    return await Promise.race([
      classifier.classify(prompt, config.routing.questions, { signal: controller.signal }),
      hardGuard,
    ]);
  } finally {
    cancelGuard();
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * Record one attempt on the session, successful or not.
 *
 * The transcript is the only durable audit trail: notifications are ephemeral,
 * so an attempt that fails must still leave a line, otherwise "the router
 * declined" and "the router never ran" are indistinguishable afterwards.
 */
function recordAttempt(pi: ExtensionAPI, state: SessionState, record: RouteRecord): void {
  state.lastRecord = record;
  state.history.push(record);
  if (state.history.length > HISTORY_LIMIT) state.history.splice(0, state.history.length - HISTORY_LIMIT);
  pi.appendEntry("class-router.decision", {
    category: record.category,
    confidence: record.confidence,
    spec: record.spec,
    apply: record.apply,
    resolved: record.resolved,
    changed: record.changed,
    reason: record.reason,
    backend: record.backend,
    latencyMs: record.latencyMs,
    error: record.error,
  });
}

/** An attempt that produced no decision at all. */
function noDecision(
  backend: RouterConfig["backend"],
  reason: NoDecisionReason,
  latencyMs: number,
  error?: string,
): RouteRecord {
  return {
    category: null,
    confidence: 0,
    spec: null,
    apply: null,
    resolved: null,
    changed: false,
    reason,
    backend,
    latencyMs,
    at: Date.now(),
    error,
  };
}

async function onBeforeAgentStart(pi: ExtensionAPI, event: { prompt: string }, ctx: ExtensionContext): Promise<void> {
  try {
    const state = ensureSession(ctx, pi);
    // A new run means any earlier run has ended; a probe it never settled is stale.
    releaseProbe(state);
    const prompt = typeof event.prompt === "string" ? event.prompt : "";
    const trimmed = prompt.trim();

    if (!state.config.enabled) {
      state.skipped += 1;
      return;
    }

    const subagent = isSubagentSession(ctx);
    if (state.config.applyTo === "main" && subagent) {
      state.skipped += 1;
      return;
    }
    if (state.config.applyTo === "subagents" && !subagent) {
      state.skipped += 1;
      return;
    }

    // Empty prompts and slash commands are not work to classify.
    if (trimmed === "" || isSlashCommand(trimmed)) {
      state.skipped += 1;
      return;
    }

    const started = Date.now();
    const classifier = getClassifier(state, pi);
    if (classifier === null) {
      state.skipped += 1;
      notify(ctx, state, `backend ${state.config.backend} unavailable; using session model`, "warning");
      recordAttempt(pi, state, noDecision(state.config.backend, "backend-unavailable", Date.now() - started));
      return;
    }

    let answers: Record<string, Answer>;
    try {
      const result = await classifyGuarded(
        classifier,
        clipPrompt(prompt, state.config.routing.maxPromptChars),
        state.config,
        ctx,
      );
      answers = result.answers;
    } catch (error) {
      state.failed += 1;
      const code = error instanceof ClassifierError ? error.code : "unexpected";
      log(pi, "warn", "class-router: classification failed", {
        backend: state.config.backend,
        code,
        error: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof ClassifierError) {
        notify(ctx, state, `classification failed (${error.code}); using session model`, "warning");
      } else {
        notify(ctx, state, `classification failed (unexpected); using session model`, "error");
      }
      recordAttempt(pi, state, noDecision(state.config.backend, "classification-failed", Date.now() - started, code));
      return;
    }

    const breaker = state.breaker;
    const decision = decide(state.config, answers, {
      isAvailable: (spec) => breaker.allow(spec),
    });
    state.lastDecision = decision;

    // `decide` only asked; claim the probe for the one spec that may now run.
    // Nothing awaits between the two, so the claim cannot lose a race.
    if (decision.apply !== null && !state.config.dryRun && breaker.acquire(decision.apply)) {
      state.probeSpec = decision.apply;
    }

    const applied = await applyDecision(pi, ctx, state, decision);
    // The spec is not running this turn (dry run, unresolved, no auth), so no
    // outcome will ever be recorded against the claim.
    if (!applied.active) releaseProbe(state);

    const latencyMs = Date.now() - started;
    recordAttempt(pi, state, {
      category: decision.category,
      confidence: decision.confidence,
      spec: decision.spec,
      apply: decision.apply,
      resolved: applied.resolved,
      changed: applied.changed,
      reason: decision.reason,
      backend: state.config.backend,
      latencyMs,
      at: Date.now(),
    });

    // Counted only once a decision actually exists: a failed classification is a
    // failure, not a routed prompt.
    state.routed += 1;
    notify(ctx, state, `${decision.detail} [${latencyMs}ms via ${state.config.backend}]`);
  } catch (error) {
    // Nothing below is allowed to break a turn.
    log(pi, "error", "class-router: routing hook failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      ctx.ui.notify(`${NOTIFY_PREFIX} routing error; using session model`, "error");
    } catch {
      // UI unavailable in this host mode.
    }
  }
}

async function applyDecision(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: SessionState,
  decision: Decision,
): Promise<AppliedModel> {
  if (state.config.dryRun || decision.apply === null) return NOT_APPLIED;

  const capabilities = detectHost(ctx);

  let model: ReturnType<typeof resolveModel>;
  try {
    model = resolveModel(capabilities, ctx, decision.apply);
  } catch (error) {
    log(pi, "warn", "class-router: model resolution failed", {
      spec: decision.apply,
      error: error instanceof Error ? error.message : String(error),
    });
    return NOT_APPLIED;
  }

  if (model === undefined) {
    log(pi, "warn", "class-router: model spec did not resolve", { spec: decision.apply });
    notify(ctx, state, `spec ${decision.apply} did not resolve; keeping session model`, "warning");
    return NOT_APPLIED;
  }

  const resolved = model.id;

  const currentId = currentModel(capabilities, ctx)?.id;
  if (currentId === model.id) {
    // Already the routed model: record the decision as applied, but do not
    // re-set it. Reporting `changed: false` is what makes a no-op legible in the
    // session log: without it, "routed" and "did nothing" look identical.
    state.appliedSpec = decision.apply;
    state.appliedModelId = model.id;
    return { resolved, changed: false, active: true };
  }

  // Prefer the host's own auth verdict when it has one (upstream pi exposes
  // `modelRegistry.hasConfiguredAuth`); otherwise rely on `setModel`'s result.
  if (hasConfiguredAuth(capabilities, ctx, model) === false) {
    if (!state.authNotified) {
      state.authNotified = true;
      notify(ctx, state, `no auth for ${decision.apply}; keeping session model`, "warning");
    }
    return { resolved, changed: false, active: false };
  }

  let changed: boolean;
  try {
    changed = await applyModel(pi, model);
  } catch (error) {
    log(pi, "warn", "class-router: setModel failed", {
      spec: decision.apply,
      error: error instanceof Error ? error.message : String(error),
    });
    return { resolved, changed: false, active: false };
  }

  if (!changed) {
    // No auth for this model is a configuration problem, not a model failure.
    if (!state.authNotified) {
      state.authNotified = true;
      notify(ctx, state, `no auth for ${decision.apply}; keeping session model`, "warning");
    }
    return { resolved, changed: false, active: false };
  }

  state.appliedSpec = decision.apply;
  state.appliedModelId = model.id;
  return { resolved, changed: true, active: true };
}

/** A run that ended in an error or abort, read off the trailing assistant message. */
function runFailed(messages: readonly unknown[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined;
    if (message === undefined || message.role !== "assistant") continue;
    if (message.stopReason === "error" || message.stopReason === "aborted") return true;
    if (typeof message.errorMessage === "string" && message.errorMessage !== "") return true;
    return false;
  }
  return false;
}

function onAgentEnd(event: { messages: readonly unknown[]; willContinue?: boolean }, ctx: ExtensionContext): void {
  try {
    // An automatic continuation is not a settle: leave the breaker untouched.
    if (event.willContinue === true) return;

    const state = sessions.get(sessionKey(ctx));
    if (state === undefined) return;
    if (state.appliedSpec === null) {
      releaseProbe(state);
      return;
    }

    // Only attribute an outcome while our model is still the session model; a
    // manual `/model` switch must never be blamed on the router. The applied
    // spec itself survives a model change, so a later turn can still use it.
    const current = currentModel(detectHost(ctx), ctx);
    if (current === undefined || current.id !== state.appliedModelId) {
      releaseProbe(state);
      state.pendingFailure = null;
      state.failureRecorded = false;
      return;
    }

    const failed = state.pendingFailure !== null || runFailed(event.messages);

    if (failed) {
      if (!state.failureRecorded) state.breaker.recordFailure(state.appliedSpec);
    } else {
      state.breaker.recordSuccess(state.appliedSpec);
    }

    // A recorded outcome resolves the probe; release covers a claim on a spec
    // other than the one just attributed.
    if (state.probeSpec === state.appliedSpec) state.probeSpec = null;
    releaseProbe(state);
    state.pendingFailure = null;
    state.failureRecorded = false;
  } catch {
    // Breaker bookkeeping never breaks a turn.
  }
}

function onAutoRetryStart(pi: ExtensionAPI, event: { errorMessage: string }, ctx: ExtensionContext): void {
  try {
    const state = sessions.get(sessionKey(ctx));
    if (state === undefined || state.appliedSpec === null) return;

    // Read-only guard: the applied spec must survive a model change, so a later
    // routing attempt can still select (and attribute) it.
    const current = currentModel(detectHost(ctx), ctx);
    if (current === undefined || current.id !== state.appliedModelId) return;

    const message = typeof event.errorMessage === "string" ? event.errorMessage : "";
    state.pendingFailure = { reason: classifyFailure(message), message };
    log(pi, "debug", "class-router: breaker failure", {
      spec: state.appliedSpec,
      reason: state.pendingFailure.reason,
    });

    if (!state.failureRecorded) {
      state.breaker.recordFailure(state.appliedSpec);
      state.failureRecorded = true;
      if (state.probeSpec === state.appliedSpec) state.probeSpec = null;
    }
  } catch {
    // Never break a turn from breaker bookkeeping.
  }
}

function onAutoRetryEnd(event: { success: boolean }, ctx: ExtensionContext): void {
  try {
    if (!event.success) return;

    const state = sessions.get(sessionKey(ctx));
    if (state === undefined || state.appliedSpec === null) return;

    const current = currentModel(detectHost(ctx), ctx);
    if (current === undefined || current.id !== state.appliedModelId) return;

    state.breaker.recordSuccess(state.appliedSpec);
    if (state.probeSpec === state.appliedSpec) state.probeSpec = null;
    state.pendingFailure = null;
    state.failureRecorded = false;
  } catch {
    // Never break a turn from breaker bookkeeping.
  }
}

function onSessionShutdown(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const sessionId = sessionKey(ctx);
  const state = sessions.get(sessionId);
  if (state === undefined) return;
  releaseProbe(state);
  detachClassifier(state, pi);
  sessions.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

function commandStatus(ctx: ExtensionContext, state: SessionState): void {
  const config = state.config;
  ctx.ui.notify(
    `${NOTIFY_PREFIX} ${config.enabled ? "enabled" : "disabled"}${config.dryRun ? " (dry run)" : ""} | backend ${config.backend} | applyTo ${config.applyTo}`,
  );
  const source = state.source === null ? "none (built-in defaults)" : `${state.source.path} (${state.source.scope})`;
  ctx.ui.notify(`${NOTIFY_PREFIX} config source: ${oneLine(source)}`);
  ctx.ui.notify(`${NOTIFY_PREFIX} breaker: ${formatBreaker(state.breaker.snapshot())}`);
  const last = state.lastRecord;
  if (last === null) {
    ctx.ui.notify(`${NOTIFY_PREFIX} last decision: none`);
  } else {
    ctx.ui.notify(
      `${NOTIFY_PREFIX} last decision: ${last.category ?? "none"} -> ${last.apply ?? "unchanged"} ` +
        `(${last.reason}, ${last.confidence.toFixed(2)}, ${last.latencyMs}ms, ` +
        `${last.changed ? "model changed" : `model unchanged${last.resolved ? ` (already ${last.resolved})` : ""}`})`,
    );
  }
  ctx.ui.notify(`${NOTIFY_PREFIX} session: ${state.routed} routed, ${state.skipped} skipped, ${state.failed} failed`);
}

function commandExplain(ctx: ExtensionContext, state: SessionState): void {
  const decision = state.lastDecision;
  if (decision === null) {
    ctx.ui.notify(`${NOTIFY_PREFIX} no decision yet`);
    return;
  }
  const lines = [
    `category: ${decision.category ?? "none"}`,
    `confidence: ${decision.confidence.toFixed(2)}`,
    `spec: ${decision.spec ?? "none"}`,
    `chain: ${decision.chain.length === 0 ? "none" : decision.chain.join(" -> ")}`,
    `apply: ${decision.apply ?? "unchanged"}`,
    `resolved: ${state.lastRecord?.resolved ?? "none"}`,
    `changed: ${state.lastRecord?.changed === true ? "yes" : "no"}`,
    `reason: ${decision.reason}`,
    `detail: ${decision.detail}`,
    `backend: ${state.lastRecord?.backend ?? state.config.backend}`,
  ];
  for (const line of lines) ctx.ui.notify(`${NOTIFY_PREFIX} ${oneLine(line)}`);

  const extra = Object.entries(decision.extra);
  if (extra.length === 0) {
    ctx.ui.notify(`${NOTIFY_PREFIX} other answers: none`);
    return;
  }
  for (const [id, answer] of extra) ctx.ui.notify(`${NOTIFY_PREFIX} answer ${id}: ${formatAnswer(answer)}`);
}

function registerCommand(pi: ExtensionAPI): void {
  pi.registerCommand("class-router", {
    description: "Inspect and control classifier-driven model routing",
    getArgumentCompletions: (argumentPrefix: string) => {
      const prefix = argumentPrefix.trim();
      const matches = SUBCOMMANDS.filter((name) => name.startsWith(prefix));
      if (matches.length === 0) return null;
      return matches.map((name) => ({ value: name, label: name }));
    },
    handler: async (args: string, ctx) => {
      try {
        const state = ensureSession(ctx, pi);
        const subcommand = (args.trim().split(/\s+/)[0] ?? "") || "status";

        switch (subcommand) {
          case "status":
            commandStatus(ctx, state);
            return;
          case "on":
            state.config.enabled = true;
            ctx.ui.notify(`${NOTIFY_PREFIX} routing enabled`);
            return;
          case "off":
            state.config.enabled = false;
            ctx.ui.notify(`${NOTIFY_PREFIX} routing disabled; the session model is left alone`);
            return;
          case "reset": {
            state.breaker.reset();
            ctx.ui.notify(`${NOTIFY_PREFIX} circuit breaker reset`);
            return;
          }
          case "explain":
            commandExplain(ctx, state);
            return;
          default:
            ctx.ui.notify(`${NOTIFY_PREFIX} unknown subcommand ${subcommand}; valid: ${SUBCOMMANDS.join(", ")}`);
        }
      } catch (error) {
        log(pi, "error", "class-router: command failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        ctx.ui.notify(`${NOTIFY_PREFIX} command failed`, "error");
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function classRouter(pi: ExtensionAPI): void {
  // The extension label is omp-only (`setLabel(name)` there, vs a two-argument
  // entry label upstream) and purely cosmetic, so it is not set.

  pi.on("session_start", async (_event, ctx) => {
    try {
      const state = ensureSession(ctx, pi);
      // Loading Laya's checkpoints takes far longer than a turn's budget, so it
      // starts here and never blocks the session. Jev's warmup is a no-op.
      const classifier = getClassifier(state, pi);
      if (classifier?.warmup !== undefined) {
        void classifier.warmup().catch((error: unknown) => {
          log(pi, "warn", "class-router: classifier warmup failed", {
            backend: state.config.backend,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } catch (error) {
      log(pi, "error", "class-router: session start failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    try {
      onSessionShutdown(pi, ctx);
    } catch (error) {
      log(pi, "warn", "class-router: shutdown failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  pi.on("before_agent_start", (event, ctx) => onBeforeAgentStart(pi, event, ctx));
  pi.on("agent_end", (event, ctx) => onAgentEnd(event, ctx));
  // The retry events are omp-only in the extension event union. Both hosts
  // accept arbitrary event names today, so registration is attempted rather
  // than gated; `registerEvent` reports refusal instead of throwing, which keeps
  // extension load safe on a host that validates names. Payload shapes below are
  // the host's event contracts, narrowed from the handler's `unknown`.
  registerEvent(pi, "auto_retry_start", (payload, ctx) =>
    onAutoRetryStart(pi, payload as { errorMessage: string }, ctx as ExtensionContext),
  );
  registerEvent(pi, "auto_retry_end", (payload, ctx) =>
    onAutoRetryEnd(payload as { success: boolean }, ctx as ExtensionContext),
  );

  registerCommand(pi);
}
