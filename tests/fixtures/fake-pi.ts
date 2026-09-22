/**
 * Minimal in-process stand-in for omp's `ExtensionAPI` + `ExtensionContext`.
 *
 * Structural types only: this fixture never imports the omp package, so tests
 * stay decoupled from its full surface. `tests/extension.test.ts` casts these
 * objects to the real types at the single `classRouter(...)` call site.
 *
 * `emit` awaits handlers in registration order and returns the last non-void
 * result, mirroring omp's chained `before_agent_start` results.
 */

export interface FakeModel {
  id: string;
  provider: string;
  [key: string]: unknown;
}

export interface RecordedModel {
  id: string;
  provider: string;
}

export interface RecordedNotification {
  message: string;
  type?: "info" | "warning" | "error";
}

export interface RecordedEntry {
  type: string;
  data: unknown;
}

export interface RecordedCommand {
  name: string;
  description?: string;
  handler: (args: string, ctx: unknown) => unknown;
  getArgumentCompletions?: (prefix: string) => unknown;
}

export type FakeEventHandler = (event: unknown, ctx: unknown) => unknown;

export interface FakeSession {
  id: string;
  file: string | null;
}

/** Mutable state shared by the fake `pi` and its contexts. */
export interface FakeContextState {
  current: FakeModel | null;
  resolveTable: Map<string, FakeModel>;
  listModels: FakeModel[];
  notifications: RecordedNotification[];
  entries: RecordedEntry[];
  setModelCalls: RecordedModel[];
  setModelResult: boolean;
  label: string | null;
  aborts: number;
  shutdowns: number;
  timers: Set<NodeJS.Timeout>;
}

export interface FakePiOptions {
  cwd?: string;
  sessionId?: string;
  sessionFile?: string | null;
  /** Specs `models.resolve()` understands; an absent spec resolves to undefined. */
  resolve?: Record<string, FakeModel | undefined>;
  list?: FakeModel[];
  current?: FakeModel | null;
  /** What `setModel` returns; false models the no-auth path. */
  setModelResult?: boolean;
  flags?: Record<string, unknown>;
  sessionName?: string | null;
  /**
   * Host flavour. `"omp"` (default) exposes the omp-only surface: the
   * `ctx.models` facade, managed timers, and `pi.logger`. `"pi"` omits all
   * three, adds upstream pi's `ctx.model` / `ctx.modelRegistry`, and rejects
   * event names outside upstream pi's union.
   */
  host?: "omp" | "pi";
}

export interface FakeContextOptions {
  cwd?: string;
  session?: FakeSession;
  /** See `FakePiOptions.host`. */
  host?: "omp" | "pi";
}

/** Upstream pi's extension event union, as far as this fixture models it. */
const UPSTREAM_EVENTS: Record<string, true> = {
  session_start: true,
  session_shutdown: true,
  before_agent_start: true,
  agent_end: true,
};

/** Structural `ModelRegistry` stand-in used by the pi-shaped context. */
export interface FakeModelRegistry {
  find(provider: string, id: string): FakeModel | undefined;
  getAvailable(): FakeModel[];
  getAll(): FakeModel[];
  hasConfiguredAuth(model: FakeModel): boolean;
}

/** Structural `ExtensionContext` stand-in. */
export interface FakeContext {
  cwd: string;
  mode: string;
  hasUI: boolean;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | null;
  };
  /** omp only. Absent on the pi-shaped host. */
  models?: {
    list(): FakeModel[];
    current(): FakeModel | undefined;
    resolve(spec: string): FakeModel | undefined;
    family(model: FakeModel): string;
  };
  /** Upstream pi only. Absent on the omp-shaped host. */
  model?: FakeModel;
  /** Upstream pi only. Absent on the omp-shaped host. */
  modelRegistry?: FakeModelRegistry;
  isIdle(): boolean;
  getSystemPrompt(): string[];
  /** omp managed timers. Absent on the pi-shaped host. */
  setInterval?(handler: () => void, ms?: number): NodeJS.Timeout;
  /** omp managed timers. Absent on the pi-shaped host. */
  setTimeout?(handler: () => void, ms?: number): NodeJS.Timeout;
  /** omp managed timers. Absent on the pi-shaped host. */
  clearTimer?(timer: NodeJS.Timeout): void;
  isProjectTrusted(): boolean;
  hasPendingMessages(): boolean;
  abort(): void;
  shutdown(): void;
}

/** Structural `ExtensionAPI` stand-in plus the fixture's own `emit`. */
export interface FakePi {
  pi: {
    /** omp only; absent on the pi-shaped host. */
    logger?: { debug(): void; info(): void; warn(): void; error(): void };
    on(event: string, handler: FakeEventHandler): void;
    setLabel(name: string): void;
    appendEntry(type: string, data?: unknown): void;
    registerCommand(name: string, spec: Omit<RecordedCommand, "name">): void;
    getFlag(name: string): unknown;
    getSessionName(): string | null;
    setModel(model: FakeModel): Promise<boolean>;
  };
  ctx: FakeContext;
  state: FakeContextState;
  session: FakeSession;
  handlers: Map<string, FakeEventHandler[]>;
  commands: Map<string, RecordedCommand>;
  emit(event: string, payload: unknown, targetCtx?: unknown): Promise<unknown>;
  createCtx(options?: FakeContextOptions): FakeContext;
  setSessionId(id: string): void;
  setSessionFile(file: string | null): void;
  setCurrentModel(model: FakeModel | null): void;
  setSetModelResult(value: boolean): void;
  setResolve(spec: string, model: FakeModel | undefined): void;
}

export function createFakeContext(state: FakeContextState, options: FakeContextOptions = {}): FakeContext {
  const session = options.session ?? { id: "fake-session", file: null };
  const host = options.host ?? "omp";

  const ctx: FakeContext = {
    cwd: options.cwd ?? process.cwd(),
    mode: "print",
    hasUI: false,
    ui: {
      notify(message: string, type?: "info" | "warning" | "error"): void {
        state.notifications.push({ message, type });
      },
    },
    sessionManager: {
      getSessionId: () => session.id,
      getSessionFile: () => session.file,
    },
    isIdle: () => true,
    getSystemPrompt: () => [],
    isProjectTrusted: () => true,
    hasPendingMessages: () => false,
    abort: () => {
      state.aborts += 1;
    },
    shutdown: () => {
      state.shutdowns += 1;
    },
  };

  if (host === "omp") {
    ctx.models = {
      list: () => [...state.listModels],
      current: () => state.current ?? undefined,
      resolve: (spec: string) => state.resolveTable.get(spec),
      family: (model: FakeModel) => model.provider ?? "unknown",
    };
    ctx.setInterval = (handler: () => void, ms?: number) => {
      const timer = setInterval(handler, ms);
      state.timers.add(timer);
      return timer;
    };
    ctx.setTimeout = (handler: () => void, ms?: number) => {
      const timer = setTimeout(handler, ms);
      state.timers.add(timer);
      return timer;
    };
    ctx.clearTimer = (timer: NodeJS.Timeout) => {
      clearTimeout(timer);
      clearInterval(timer);
      state.timers.delete(timer);
    };
  } else {
    // Live view: `setCurrentModel` must be observable through the context.
    Object.defineProperty(ctx, "model", {
      enumerable: true,
      get: () => state.current ?? undefined,
    });
    ctx.modelRegistry = {
      find: (provider: string, id: string) =>
        state.listModels.find(
          (model) => model.id === id && (provider === "" || model.provider === provider),
        ),
      getAvailable: () => [...state.listModels],
      getAll: () => [...state.listModels],
      hasConfiguredAuth: () => true,
    };
  }

  return ctx;
}

export function createFakePi(options: FakePiOptions = {}): FakePi {
  const state: FakeContextState = {
    current: options.current ?? null,
    resolveTable: new Map<string, FakeModel>(),
    listModels: options.list ?? [],
    notifications: [],
    entries: [],
    setModelCalls: [],
    setModelResult: options.setModelResult ?? true,
    label: null,
    aborts: 0,
    shutdowns: 0,
    timers: new Set<NodeJS.Timeout>(),
  };
  for (const [spec, model] of Object.entries(options.resolve ?? {})) {
    if (model !== undefined) state.resolveTable.set(spec, model);
  }

  const session: FakeSession = {
    id: options.sessionId ?? "fake-session",
    file: options.sessionFile ?? null,
  };

  const handlers = new Map<string, FakeEventHandler[]>();
  const commands = new Map<string, RecordedCommand>();
  const host = options.host ?? "omp";

  const pi: FakePi["pi"] = {
    // omp only: the pi-shaped host has no logger at all.
    ...(host === "omp"
      ? {
          logger: {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
          },
        }
      : {}),
    on(event: string, handler: FakeEventHandler): void {
      // Upstream pi rejects event names outside its union; omp accepts any.
      if (host === "pi" && UPSTREAM_EVENTS[event] !== true) {
        throw new Error(`unknown extension event: ${event}`);
      }
      const list = handlers.get(event);
      if (list === undefined) handlers.set(event, [handler]);
      else list.push(handler);
    },
    setLabel(name: string): void {
      state.label = name;
    },
    appendEntry(type: string, data?: unknown): void {
      state.entries.push({ type, data });
    },
    registerCommand(name: string, spec: Omit<RecordedCommand, "name">): void {
      commands.set(name, { name, ...spec });
    },
    getFlag(name: string): unknown {
      return options.flags?.[name];
    },
    getSessionName(): string | null {
      return options.sessionName ?? null;
    },
    /** Records `{id, provider}` and reports whether the model was applied. */
    async setModel(model: FakeModel): Promise<boolean> {
      state.setModelCalls.push({ id: model.id, provider: model.provider });
      if (!state.setModelResult) return false;
      state.current = model;
      return true;
    },
  };

  const ctx = createFakeContext(state, { cwd: options.cwd ?? process.cwd(), session, host });

  async function emit(event: string, payload: unknown, targetCtx: unknown = ctx): Promise<unknown> {
    let last: unknown;
    for (const handler of handlers.get(event) ?? []) {
      const result = await handler(payload, targetCtx);
      if (result !== undefined) last = result;
    }
    return last;
  }

  return {
    pi,
    ctx,
    state,
    session,
    handlers,
    commands,
    emit,
    createCtx(contextOptions: FakeContextOptions = {}) {
      return createFakeContext(state, {
        cwd: contextOptions.cwd ?? ctx.cwd,
        session: contextOptions.session ?? session,
        host: contextOptions.host ?? host,
      });
    },
    setSessionId(id: string): void {
      session.id = id;
    },
    setSessionFile(file: string | null): void {
      session.file = file;
    },
    setCurrentModel(model: FakeModel | null): void {
      state.current = model;
    },
    setSetModelResult(value: boolean): void {
      state.setModelResult = value;
    },
    setResolve(spec: string, model: FakeModel | undefined): void {
      if (model === undefined) state.resolveTable.delete(spec);
      else state.resolveTable.set(spec, model);
    },
  };
}
