# Architecture

How the extension works inside, for contributors and for anyone debugging it at
the edges. For installing, configuring and using it, see the
[README](../README.md).

## One entry point, two hosts

The extension targets the **upstream pi extension API**
(`@earendil-works/pi-coding-agent`), so one entry point, `src/index.ts`, loads on
both **pi 0.87.x** and **Oh My Pi (omp) 18.2.x**. omp resolves that upstream
specifier at runtime. Only types are imported from it, and only with
`import type`, so it adds no runtime dependency: Node builtins, `fetch`, and the
optional `python/laya_worker.py` subprocess are all the extension uses.
`@earendil-works/pi-coding-agent` is therefore a dev dependency (for the types)
and an optional peer dependency, never a runtime one. Verifying omp support
means running the omp binary against the entry point, not importing omp's types.

Load-time work is registration only. Every runtime behaviour hangs off an event
handler (`session_start`, `before_agent_start`, `agent_end`, `session_shutdown`,
and on omp the retry events) or the `/class-router` command, and nothing on the
routing path may break a turn.

### Capability detection

`src/host.ts` inspects the live context and uses whatever the host actually
provides. Detection is structural, not a version check: a context counts as omp
when it exposes `ctx.models` with callable `resolve`/`current`, or both managed
timer methods. Anything else, including a partial or unexpected context, takes
the pi path, and detection never throws.

On omp the extension upgrades automatically to:

- `ctx.models` for model resolution, including role aliases (`@smol`,
  `@default`, `@slow`) and `ctx.models.current()`.
- Managed timers (`ctx.setTimeout` / `ctx.clearTimer`), which are unref'd and
  cleared on session shutdown, instead of raw timers.
- `auto_retry_start` / `auto_retry_end` for failure attribution, with the error
  text classified into the breaker's `rate_limit` / `overloaded` / `auth` /
  `transport` / `other` taxonomy.

On upstream pi, where none of that exists, the same behaviour comes from what pi
does expose:

- **Model resolution** falls back to `ctx.modelRegistry`: its `find` method,
  then a scan of `getAvailable()` (or `getAll()`), then `ctx.model`. This
  understands concrete `provider/id` specs and bare ids only, so role aliases
  resolve nothing on pi.
- **Timers** fall back to raw `setTimeout` / `clearTimeout`.
- **The breaker's failure signal** is read off `agent_end`: a failure when the
  trailing assistant message has `stopReason: "error"` or `"aborted"`, or a
  non-empty `errorMessage`. This separates a failed run from a clean one, but it
  cannot classify the provider error the way `auto_retry_start` does.
- **Auth** is checked up front with `ctx.modelRegistry.hasConfiguredAuth`, where
  omp instead reports it through `pi.setModel` returning `false`.

| | omp 18.2.x | upstream pi 0.87.x |
| --- | --- | --- |
| runtime | Bun | Node (the `pi` CLI is `#!/usr/bin/env node`) |
| resolvable spec style | `provider/id`, bare id, or role alias (`@slow`) | `provider/id` or bare id only |
| failure signal | `auto_retry_start` / `auto_retry_end` | `agent_end`, read off the trailing assistant message |
| timers | managed (`ctx.setTimeout` / `ctx.clearTimer`) | raw `setTimeout` / `clearTimeout` |
| automatic continuation | `agent_end` carries `willContinue` | not available, so every `agent_end` settles the run |
| YAML config | supported (`Bun.YAML`) | not supported; use JSON |

The retry events are omp-only in the extension event union. Registration is
attempted rather than gated, through a guard that reports refusal instead of
throwing, so a host whose event union rejects them cannot break extension load;
the breaker then relies on `agent_end`.

### Logging

`pi.logger` is used when the host provides it (omp). Otherwise the extension
writes one line to stderr, and only when `CLASS_ROUTER_DEBUG` is set. Logging
never throws and never writes to stdout, which is the host's protocol surface.

## Per-session state and shared resources

Each session keeps its own state: its loaded config (and the project trust it
was loaded under), counters, history, the last decision, the spec it applied,
and any breaker probe it holds. Config is reloaded when the session's working
directory or its project trust changes.

Classifiers and circuit breakers are shared across sessions in one process:

- **Classifiers** are cached per backend configuration (`backend`, `jev`,
  `laya`). Sessions with matching configs share one; a classifier is disposed
  when the last session using it ends or switches config. For Laya this means
  one sidecar process per distinct config, not one per switch.
- **Breakers** are cached per `circuitBreaker` configuration and never evicted,
  so a session that reopens with the same thresholds sees the circuits it left.

## Routing a prompt

On `before_agent_start`:

1. Skip (counted, not recorded) when routing is disabled, `applyTo` excludes
   this session, or the prompt is empty or a slash command.
2. Clip the prompt to `routing.maxPromptChars` and classify it. The backend owns
   the time budget (`timeoutMs`) and reports `timeout`; an outer guard fires
   250 ms later so a backend that ignores its abort signal still cannot hang the
   turn.
3. `decide()` (`src/router.ts`, pure: no I/O, no clock) maps the answer to a
   spec, filtering the fallback chain through the breaker's `allow()`, which is a
   pure query.
4. Claim a breaker probe with `acquire()` for the one spec that will run, then
   resolve and apply it. If it does not end up running the turn (dry run,
   unresolved, no auth), the probe is released.
5. Record a `class-router.decision` entry and notify.

On `agent_end` (and the omp retry events) the run's outcome is attributed to the
applied spec, but only while the session model is still the model this extension
applied, so a manual `/model` switch is never blamed on the router.

## Wire protocols

### HTTP (Jev, and Laya with `transport: "http"`)

`POST <endpoint>` with `Content-Type: application/json`, and
`Authorization: Bearer <token>` only when a token variable is configured and set.
The body is `{ state, questions }`, plus `model` for Jev; Laya sends no `model`,
because the host that runs inference owns checkpoint selection. The response is
`{ model?, answers, usage? }`. A 401/403 maps to `auth`, a 429 or 5xx to
`unavailable`, other non-2xx and malformed bodies to `protocol`.

### Laya sidecar (`transport: "python"`)

A persistent child process speaking NDJSON over stdio. stdout carries exactly one
JSON object per line; every diagnostic goes to stderr.

```text
request  {"id": <int>, "op": "predict"|"ping"|"preload"|"shutdown", "deadline"?: <epoch ms>, ...}
reply    {"id": <int>, "ok": true, "result": {...}}
       | {"id": <int>, "ok": false, "error": "...", "kind": "unavailable"|"timeout"|"protocol"}
event    {"event": "ready", "version": "...", "loaded": [...]}
       | {"event": "error", "error": "...", "kind": ...}
```

The worker serves one request at a time and cannot interrupt a running
prediction. The client stamps each request with the wall-clock `deadline` at
which it stops waiting (client and worker share a host, so one clock), and the
worker answers an expired `predict`/`preload` with a `timeout` error instead of
running it. Requests without a deadline run as before.

The child is spawned lazily, respawned after a crash, and disposed with a
`shutdown` request followed by a kill.

## Subagent detection

Neither host exposes an agent kind to extensions: omp 18.2.9 has none on
`ExtensionContext`, `session_start` carries no reason,
`getHeader().parentSession` is unpopulated for task spawns, and subagents share
the parent's process. The extension therefore reads the session file path. omp
writes a subagent at `<tmp>/omp-task-<hex>/<Agent>.jsonl`, or nests it under a
directory named for the parent's `.jsonl` file. Upstream pi writes
`<session-dir>/<timestamp>_<id>.jsonl`, which matches neither pattern, and has no
`task` tool, so it has no subagent sessions. A path matching neither pattern is
treated as `main`, so `applyTo: "main"` cannot silently disable routing
everywhere.
