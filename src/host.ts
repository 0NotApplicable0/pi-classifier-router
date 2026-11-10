/**
 * Host capability adapter: one extension, two harnesses.
 *
 * The extension targets the upstream pi extension API
 * (`@earendil-works/pi-coding-agent`) so the same entry point loads on pi and on
 * Oh My Pi (omp). omp resolves the upstream module at runtime and its context is
 * a superset, so the richer surface is used when present and the upstream
 * surface is used otherwise.
 *
 * omp-only surfaces used here, all absent from upstream pi 0.87:
 *  - `ctx.models` (the list/current/resolve/family facade) -> `ctx.modelRegistry` + `ctx.model`
 *  - `ctx.setTimeout` / `ctx.clearTimer` (managed, session-scoped timers) -> raw timers
 *  - the `auto_retry_start` / `auto_retry_end` extension events -> `agent_end` observation
 *
 * Present on BOTH hosts, so used unconditionally: `ctx.ui.notify`,
 * `ctx.cwd`, `ctx.mode`, `ctx.isProjectTrusted`, `ctx.sessionManager.getSessionFile`,
 * `ctx.modelRegistry`, `ctx.model`, `pi.on`, `pi.setModel`, `pi.appendEntry`,
 * `pi.setLabel`, `pi.registerCommand`.
 *
 * Every function here is total: a partial, unexpected, or null context must not
 * throw. Extension load and turn handling depend on that.
 */

/** Minimal model identity shared by both hosts. */
export interface HostModel {
  id: string;
  provider: string;
}

/** The omp model facade (`ctx.models`). */
export interface HostModels {
  resolve(spec: string): HostModel | undefined;
  current(): HostModel | undefined;
  family?(model: HostModel): string;
}

/** omp's session-scoped managed timers. */
export interface HostTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface HostCapabilities {
  /** Diagnostics only: `"omp"` when any omp-only surface was detected. */
  name: "omp" | "pi";
  models?: HostModels;
  timers?: HostTimers;
  /** True when the host exposes the retry events. */
  retryEvents: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

/**
 * Inspect a live context. Never throws: a missing or malformed field simply
 * means that capability is unavailable and the upstream path is used.
 */
export function detectHost(ctx: unknown, pi?: unknown): HostCapabilities {
  const capabilities: HostCapabilities = { name: "pi", retryEvents: false };

  if (isObject(ctx)) {
    const models = ctx["models"];
    if (isObject(models) && isFunction(models["resolve"]) && isFunction(models["current"])) {
      capabilities.models = models as unknown as HostModels;
    }

    const managedSetTimeout = ctx["setTimeout"];
    const managedClearTimer = ctx["clearTimer"];
    if (isFunction(managedSetTimeout) && isFunction(managedClearTimer)) {
      capabilities.timers = {
        setTimeout: (callback, ms) => managedSetTimeout.call(ctx, callback, ms),
        clearTimer: (handle) => managedClearTimer.call(ctx, handle),
      };
    }
  }

  // The omp surface is the only one whose extension event union advertises the
  // retry events; upstream pi's does not. Detection is structural, so an
  // omp-shaped context is what earns both the name and the retry signal.
  if (capabilities.models !== undefined || capabilities.timers !== undefined) {
    capabilities.name = "omp";
    capabilities.retryEvents = true;
  }

  // `pi` is accepted for future capability probing; the current event surface is
  // identical enough that nothing is derived from it today.
  void pi;
  return capabilities;
}

/** Split `provider/id` on the FIRST slash only: upstream ids contain slashes. */
function splitSpec(spec: string): { provider: string; id: string } | null {
  const trimmed = spec.trim();
  if (trimmed === "") return null;
  const slash = trimmed.indexOf("/");
  if (slash === -1) return { provider: "", id: trimmed };
  return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

/**
 * Handler shape for `registerEvent`. The host supplies the payload, so a handler
 * receives `unknown` and narrows it against the event contract it registered for.
 */
export type HostEventHandler = (payload: unknown, ctx: unknown) => unknown;

/**
 * Whether a candidate model is the one a spec named. An empty `provider` means
 * the spec was a bare id, which matches on id alone.
 */
function matchesSpec(model: HostModel, provider: string, id: string): boolean {
  if (model.id !== id) return false;
  return provider === "" || model.provider === provider;
}

/**
 * Resolve a model spec to a host model.
 *
 * omp: `ctx.models.resolve`, which already understands role aliases (`@slow`)
 * and settings-backed match preferences.
 *
 * upstream pi: there is no facade, so resolve structurally through
 * `ctx.modelRegistry` — `find(provider, modelId)` first, then a scan of
 * `getAvailable()` (falling back to `getAll()`), then the live current model.
 * Role aliases cannot be resolved without the facade; an unresolvable spec
 * returns undefined and the caller leaves the session model alone.
 */
export function resolveModel(capabilities: HostCapabilities, ctx: unknown, spec: string): HostModel | undefined {
  const facade = capabilities.models;
  if (facade !== undefined) {
    try {
      const resolved = facade.resolve(spec);
      if (resolved !== undefined && resolved !== null) return resolved;
      return undefined;
    } catch {
      return undefined;
    }
  }

  const parsed = splitSpec(spec);
  if (parsed === null) return undefined;

  if (!isObject(ctx)) return undefined;
  const registry = ctx["modelRegistry"];
  if (!isObject(registry)) return undefined;

  const find = registry["find"];
  if (parsed.provider !== "" && isFunction(find)) {
    try {
      const found = find.call(registry, parsed.provider, parsed.id);
      if (isObject(found) && typeof found["id"] === "string" && typeof found["provider"] === "string") {
        return found as unknown as HostModel;
      }
    } catch {
      // Fall through to the scan.
    }
  }

  const list = isFunction(registry["getAvailable"])
    ? registry["getAvailable"]
    : isFunction(registry["getAll"])
      ? registry["getAll"]
      : undefined;
  if (list !== undefined) {
    try {
      const models = list.call(registry);
      if (Array.isArray(models)) {
        for (const candidate of models) {
          if (
            isObject(candidate) &&
            typeof candidate["id"] === "string" &&
            typeof candidate["provider"] === "string" &&
            matchesSpec(candidate as unknown as HostModel, parsed.provider, parsed.id)
          ) {
            return candidate as unknown as HostModel;
          }
        }
      }
    } catch {
      // Fall through to the current-model check.
    }
  }

  const current = currentModel(capabilities, ctx);
  if (current !== undefined && matchesSpec(current, parsed.provider, parsed.id)) return current;
  return undefined;
}

/** The live session model: the facade on omp, `ctx.model` on upstream pi. */
export function currentModel(capabilities: HostCapabilities, ctx: unknown): HostModel | undefined {
  const facade = capabilities.models;
  if (facade !== undefined) {
    try {
      return facade.current() ?? undefined;
    } catch {
      return undefined;
    }
  }
  if (!isObject(ctx)) return undefined;
  const model = ctx["model"];
  if (isObject(model) && typeof model["id"] === "string" && typeof model["provider"] === "string") {
    return model as unknown as HostModel;
  }
  return undefined;
}

/**
 * Whether the host reports usable credentials for a model.
 *
 * omp answers this through `pi.setModel` returning false; upstream pi exposes
 * `ctx.modelRegistry.hasConfiguredAuth(model)` directly. Returns undefined when
 * the host cannot say, and the caller then relies on `setModel`'s result.
 */
export function hasConfiguredAuth(
  _capabilities: HostCapabilities,
  ctx: unknown,
  model: HostModel,
): boolean | undefined {
  if (!isObject(ctx)) return undefined;
  const registry = ctx["modelRegistry"];
  if (!isObject(registry)) return undefined;
  const probe = registry["hasConfiguredAuth"];
  if (!isFunction(probe)) return undefined;
  try {
    const result = probe.call(registry, model);
    return typeof result === "boolean" ? result : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The host's stored API key for a credential provider (`/login <provider>`),
 * via `ctx.modelRegistry.getApiKeyForProvider`, present on both hosts.
 * Undefined when the host has none, cannot say, or throws.
 */
export async function storedApiKey(ctx: unknown, provider: string): Promise<string | undefined> {
  if (!isObject(ctx)) return undefined;
  const registry = ctx["modelRegistry"];
  if (!isObject(registry)) return undefined;
  const lookup = registry["getApiKeyForProvider"];
  if (!isFunction(lookup)) return undefined;
  try {
    const key = await lookup.call(registry, provider);
    return typeof key === "string" && key.trim() !== "" ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Apply a model to the session.
 *
 * The one cast in this adapter: `HostModel` is the structural identity both
 * hosts expose, and every value reaching here came out of the host's own
 * resolver, so it already IS the host's model object with extra fields. The cast
 * changes no runtime value; it only reconciles the two packages' declared types.
 * Returns false when the host refuses (no configured auth for that provider).
 */
export async function applyModel(pi: unknown, model: HostModel): Promise<boolean> {
  if (!isObject(pi)) return false;
  const setModel = pi["setModel"];
  if (!isFunction(setModel)) return false;
  const apply = setModel as (candidate: HostModel) => Promise<boolean>;
  const result = await apply.call(pi, model);
  return result === true;
}

/**
 * A cancellable timeout.
 *
 * omp's managed timers are tracked and cleared on session shutdown; upstream pi
 * has none, so a raw timer is used there. Both handles are always cleared, so a
 * cancel after fire is harmless.
 */
export function startTimer(capabilities: HostCapabilities, callback: () => void, ms: number): { cancel(): void } {
  let cancelled = false;
  const fire = (): void => {
    if (cancelled) return;
    callback();
  };

  const timers = capabilities.timers;
  let handle: unknown;
  let raw: NodeJS.Timeout | undefined;

  if (timers !== undefined) {
    try {
      handle = timers.setTimeout(fire, ms);
    } catch {
      raw = setTimeout(fire, ms);
    }
  } else {
    raw = setTimeout(fire, ms);
  }

  return {
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      if (handle !== undefined && timers !== undefined) {
        try {
          timers.clearTimer(handle);
        } catch {
          // A timer the host already dropped is not an error.
        }
      }
      if (raw !== undefined) clearTimeout(raw);
    },
  };
}

/**
 * Host-agnostic logging. omp provides `pi.logger`; upstream pi does not, so the
 * fallback writes a single line to stderr only when CLASS_ROUTER_DEBUG is set.
 * Never throws, never writes to stdout (stdout is the extension protocol surface).
 */
export function log(
  pi: unknown,
  level: "debug" | "warn" | "error",
  message: string,
  data?: Record<string, unknown>,
): void {
  try {
    if (isObject(pi)) {
      const logger = pi["logger"];
      if (isObject(logger)) {
        const sink = logger[level];
        if (isFunction(sink)) {
          sink.call(logger, message, data);
          return;
        }
      }
    }
  } catch {
    // Fall through to the debug sink.
  }

  try {
    if (process.env["CLASS_ROUTER_DEBUG"] === undefined) return;
    const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`;
    process.stderr.write(`[class-router] ${level}: ${message}${suffix}\n`);
  } catch {
    // Logging must never be the thing that breaks a turn.
  }
}

/**
 * Register a handler for an event the host may not support.
 *
 * Both hosts accept arbitrary event names today, but registration is still
 * guarded so an unsupported or validating host can never break extension load.
 * Returns whether registration was accepted.
 */
export function registerEvent(pi: unknown, event: string, handler: HostEventHandler): boolean {
  if (!isObject(pi)) return false;
  const on = pi["on"];
  if (!isFunction(on)) return false;
  try {
    on.call(pi, event, handler);
    return true;
  } catch {
    return false;
  }
}
