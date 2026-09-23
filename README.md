# @ejstembler/pi-classifier-router

[![pipeline](https://gitlab.com/ejstembler/pi-classifier-router/badges/main/pipeline.svg)](https://gitlab.com/ejstembler/pi-classifier-router/-/pipelines)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](package.json)

An extension for pi and Oh My Pi (omp) that classifies each incoming prompt with a
System-One model and routes the session to the model that fits it.

On `before_agent_start` the extension sends the prompt to a classifier (TypeSafe
**Jev** over HTTP, or **Laya** either in a local Python sidecar or on a shared
host over HTTP), reads the typed answer that names a category, maps that
category to a model spec, and applies it with `pi.setModel` before the turn
reaches the provider. A per-spec circuit breaker plus ordered fallback chains
keep a failing model from being retried forever, and every routing attempt is
recorded on the session as a `class-router.decision` entry.

The extension never breaks a turn: a classification failure, an unresolvable
spec, or a model without auth all fall back to the session's current model with a
notification.

## Hosts

The extension targets the **upstream pi extension API**
(`@earendil-works/pi-coding-agent`), so one entry point - `src/index.ts` - loads
on both **pi 0.87.x** and **Oh My Pi (omp) 18.2.x**. omp resolves that upstream
specifier at runtime, so a single file serves both hosts; only types are imported
and only with `import type`, so it adds no runtime dependency (Node builtins,
`fetch`, and the optional `python/laya_worker.py` subprocess are all it uses).

`src/host.ts` inspects the live context, and the extension uses whatever the host
actually provides. On omp it upgrades automatically to:

- `ctx.models` for model resolution, including role aliases (`@smol`,
  `@default`, `@slow`) and `ctx.models.current()`.
- Managed timers (`ctx.setTimeout` / `ctx.clearTimer`), which are unref'd and
  cleared on session shutdown, instead of raw timers.
- `auto_retry_start` / `auto_retry_end` for failure attribution, with the error
  text classified into the breaker's `rate_limit` / `overloaded` / `auth` /
  `transport` / `other` taxonomy.

On upstream pi, where none of that exists, the same behaviour is derived from
what pi does expose: model resolution falls back to `ctx.modelRegistry` (its
`find` method, then a scan of `getAvailable()`, then `ctx.model`); timers fall
back to raw `setTimeout`/`clearTimeout`; and the breaker's failure signal is
derived from `agent_end` when the trailing assistant message reports
`stopReason: "error"` (or `"aborted"`, or a non-empty `errorMessage`). That is a
slightly coarser signal, not a missing feature: it separates a failed run from a
clean one, but it cannot classify the provider error the way `auto_retry_start`
does.

### Model specs differ per host

**On upstream pi there is no `ctx.models` facade, so role aliases cannot be
resolved.** `routing.modelMapping` and `fallbackChains` values must be concrete
`provider/id` specs (or bare model ids) that pi's `modelRegistry` can look up.
The built-in defaults are omp-shaped (`@smol`, `@default`, `@slow`), so the
defaults - and any config written for omp with role aliases - resolve nothing on
pi: each affected decision logs and notifies `spec <spec> did not resolve;
keeping session model` and leaves the session model alone. That is a safe no-op,
not an error, but it is quiet unless you read the notification.

A spec is `provider/id` split on the **first** slash only, because upstream pi's
model ids themselves contain slashes. Its current models are all fireworks
routers, so a pi config names them like this:

```json
{
  "backend": "jev",
  "routing": {
    "modelMapping": {
      "trivial": "fireworks/accounts/fireworks/routers/glm-5p3-fast",
      "standard": "fireworks/accounts/fireworks/routers/glm-5p3-fast",
      "hard": "fireworks/accounts/fireworks/routers/deepseek-pro-latest"
    },
    "fallbackChains": {
      "fireworks/accounts/fireworks/routers/deepseek-pro-latest": [
        "fireworks/accounts/fireworks/routers/deepseek-pro-latest",
        "fireworks/accounts/fireworks/routers/glm-5p3-fast"
      ]
    }
  }
}
```

Here the provider is the first segment (`fireworks`) and the model id is
everything after it (`accounts/fireworks/routers/deepseek-pro-latest`).

### Differences between hosts

| | omp 18.2.x | upstream pi 0.87.x |
| --- | --- | --- |
| resolvable spec style | `provider/id`, bare id, or role alias (`@slow`) | `provider/id` or bare id only; role aliases do not resolve |
| failure signal | `auto_retry_start` / `auto_retry_end` | `agent_end`, read off the trailing assistant message |
| timers | managed (`ctx.setTimeout` / `ctx.clearTimer`) | raw `setTimeout` / `clearTimeout` |
| automatic continuation | `agent_end` carries `willContinue` | not available, so every `agent_end` settles the run |

Detection is structural, not a version check: a context counts as omp when it
exposes `ctx.models` with callable `resolve`/`current`, or both managed timer
methods. Anything else - including a partial or unexpected context - takes the pi
path, and detection never throws.

Logging follows the same split: `pi.logger` when the host provides it (omp), and
otherwise one line to stderr only when `CLASS_ROUTER_DEBUG` is set. Logging never
throws and never writes to stdout, which is the host's protocol surface.

## Install

The package declares its own entrypoint, so neither host needs extra wiring:

```json
"pi": { "extensions": ["./src/index.ts"] }
```

Both hosts read that `pi.extensions` manifest, and both load an entrypoint
directly from the command line:

```bash
# pi
pi -e /path/to/pi-classifier-router/src/index.ts
pi install /path/to/pi-classifier-router

# omp
omp -e /path/to/pi-classifier-router/src/index.ts
omp install /path/to/pi-classifier-router
```

`pi install <source>` and `omp install <source>` add the package to the host's
settings, and both hosts also accept an `extensions` array in their settings
files: pi reads `~/.pi/agent/settings.json` (user) and `.pi/settings.json`
(project, after project trust), while omp reads `.omp/settings.json` (project)
and its user settings file (run `omp config path` for the directory):

```json
{ "extensions": ["/path/to/pi-classifier-router/src/index.ts"] }
```

`devDependencies` carries one type package: `@earendil-works/pi-coding-agent`
supplies the types the source compiles against, on both hosts. It is not a
runtime dependency; neither host resolves it at runtime for this extension,
because the type imports are erased at load. Verifying omp support means running
the omp binary against the entrypoint, not importing omp's types.

### After installing: restart the session

Extension **modules** load at session start, so a session that was already
running when you installed this one will not have it. `/reload-plugins` refreshes
skills, slash commands and MCP servers, but not extension modules. Restart the
session (or start a new one) before expecting routing to happen; otherwise
prompts run with no router and leave no trace, which reads as a broken
extension.

### Upgrading

```bash
pi update --extensions                                  # pi
omp plugin install @ejstembler/pi-classifier-router --force   # omp
```

`omp plugin upgrade <name>` is for marketplace plugins only (`name@marketplace`);
for an npm-installed plugin it refuses and names the `plugin install --force`
form instead.

## Backends

`backend` selects one classifier for the process.

### Jev (TypeSafe, HTTP)

| key | default | meaning |
| --- | --- | --- |
| `endpoint` | `https://api.typesafe.ai/v1/systemone` | System-One evaluation endpoint |
| `model` | `jev-latest` | model alias sent in the request body |
| `apiKeyEnvVar` | `TYPESAFE_API_KEY` | environment variable holding the bearer token |
| `timeoutMs` | `3000` | per-classification budget |

The token is read from the named environment variable, sent as
`Authorization: Bearer <token>`, and never logged or embedded in errors. A
missing token makes Jev `unavailable` and the session keeps its model.

**Privacy:** with Jev, the text of every prompt the router classifies is sent to
the TypeSafe API (or whatever `endpoint` names). Slash commands and empty prompts
are never sent, and `routing.maxPromptChars` limits how much of a long prompt is
sent. If prompts must not leave the machine, use `backend: "laya"` with the local
sidecar, or turn routing off with `enabled: false` for projects that need it.

### Laya (System One, local sidecar or remote HTTP)

| key | default | meaning |
| --- | --- | --- |
| `transport` | `"python"` | where inference runs: `"python"` spawns the local sidecar, `"http"` posts to `endpoint` |
| `endpoint` | `""` | full URL of a System-One-compatible endpoint; used when `transport` is `"http"` |
| `apiKeyEnvVar` | `""` | environment variable holding an optional bearer token for `endpoint`; blank means no `Authorization` header |
| `pythonBin` | `python3` | interpreter used to run the sidecar |
| `workerScript` | `python/laya_worker.py` | worker path (absolute, or relative to the extension root) |
| `repo` | `convaiinnovations/laya` | Hugging Face repo bundling the checkpoints; `router: false` only |
| `subfolder` | `null` | `null` = English root, `"multilingual"`, `"typed-decisions"`; `router: false` only |
| `device` | `null` | torch device (`cpu`, `cuda`, `mps`), or `null` for auto-detect |
| `router` | `true` | serve checkpoints through `laya.Router` (adds multilingual routing) |
| `maxLoaded` | `null` | checkpoints `laya.Router` keeps loaded; `null` keeps Laya's default (English + multilingual); `router: true` only |
| `preload` | `true` | load weights during warmup instead of on the first classification |
| `timeoutMs` | `4000` | per-classification budget |
| `warmupTimeoutMs` | `600000` | budget for loading weights |
| `hfTokenEnvVar` | `HF_TOKEN` | environment variable holding the Hugging Face token |

`router` decides how checkpoints are chosen. `laya.Router` takes no repo or
subfolder: it always serves the `convaiinnovations/laya` checkpoints and picks
one per prompt by language. So with the local sidecar and `backend: "laya"`, a
config that sets `repo` or `subfolder` together with `router: true` is rejected
rather than silently ignored. To load one specific checkpoint (for example,
`"typed-decisions"` or a fine-tune in your own repo), set `router: false`.
`maxLoaded` is the reverse: it applies only to the Router, so setting it with
`router: false` is rejected.

`transport` gates which fields matter: the python-only keys (`pythonBin`,
`workerScript`, `repo`, `subfolder`, `device`, `router`, `maxLoaded`, `preload`,
`warmupTimeoutMs`, `hfTokenEnvVar`) are ignored when `transport` is `"http"`,
and `endpoint`/`apiKeyEnvVar` are ignored when `transport` is `"python"`. Both
transports share `timeoutMs`, and both speak the same wire format, so switching
placements is a config change rather than a code change. `transport: "http"`
requires a non-blank `endpoint` that parses as an `http:` or `https:` URL; a file
that points it anywhere else is rejected. Credentials are never required:
`apiKeyEnvVar` unset or blank means the request carries no `Authorization`
header, while a non-blank variable name with no value in the environment fails
the call as `unavailable` without sending a request. When a token is present it
is sent as `Authorization: Bearer <token>` and is never logged or embedded in
errors.

The Laya request body carries no `model` field: checkpoint selection belongs to
the host that runs inference, whether that is the local sidecar or a remote
endpoint.

#### Where Laya runs

The same typed-question protocol backs all three placements below; `transport`
picks between the two that are implemented today.

**(a) Local Python sidecar** (`transport: "python"`, the default). The faithful
form: it runs upstream's `laya_worker.py` unchanged. It needs an interpreter with
the Python requirements installed, plus a one-time multi-GB weight download from
Hugging Face on first run. After preload it costs roughly 200-460 ms of CPU per
prompt - the reason its default `timeoutMs` is larger than Jev's. Nothing leaves
the machine.

**(b) Local, Python-free via an ONNX re-host** (planned, not implemented). A JS
runtime can read ONNX weights, which would drop the interpreter dependency, but
no Hub ONNX export exists for Laya: the custom decision heads are not part of the
standard graph, so the export would have to be produced once from the PyTorch
checkpoint before this path could ship. Until then this placement is unavailable,
and no config value enables it.

**(c) One shared host over HTTP** (`transport: "http"`). Point `endpoint` at a
containerized `python/laya_worker.py`, a FastAPI wrapper around it, or any
endpoint speaking the same typed-question protocol, and thin clients route
without a local install. Upstream measures roughly 33 ms on a GPU, so this is the
fastest placement and the cheapest to operate from a client machine. The trade is
that it is a network hop: routing depends on the host being reachable, and it is
not offline-local.

Setup for the local sidecar:

```bash
pip install -r python/requirements.txt
export HF_TOKEN=...        # only needed for a gated repo
```

The paragraphs below describe the `transport: "python"` sidecar. With
`transport: "http"` the worker runs on the remote host instead, so none of this
local machinery is involved: no spawn, no local weights, and the call is bounded
by `timeoutMs` composed with the caller's own signal.

The first run downloads the checkpoint weights from Hugging Face into the usual
transformers cache; that download dominates the first startup. The sidecar is
spawned lazily, keeps the checkpoints resident across requests, and is respawned
after a crash, so a dead worker degrades to `unavailable` for one prompt instead
of poisoning the session.

Warmup starts at `session_start` and never blocks the session: with
`preload: true` the worker loads weights in the background (bounded by
`warmupTimeoutMs`), so a slow load does not collide with the first prompt's
`timeoutMs`. With `preload: false`, warmup only waits for the worker to report
ready and the first classification pays the load.

The worker serves one request at a time and cannot stop a prediction once it
has started. Each request therefore carries a `deadline` (the time the client
stops waiting, `timeoutMs` after sending). If a request is still queued when its
deadline passes, the worker answers `timeout` without running it. On a slow CPU,
one prediction that overran its budget therefore delays only the next request,
instead of making every request queued behind it time out too.

Latency is dominated by the device: a GPU (`cuda`/`mps`) handles a typed question
in tens to low hundreds of milliseconds, while CPU-only inference is roughly an
order of magnitude slower, which is why the default budget is larger than Jev's.
Every call is also bounded by an independent outer guard, so a wedged sidecar
cannot hang a turn even if it ignores its abort.

Documented limits: upstream benchmarks evaluate Laya as a fine-tuned System-One
model. A zero-shot base checkpoint is close to chance on typed decisions, so
expect near-random routing until the checkpoint you point `repo`/`subfolder` at
is fine-tuned for the question set you configure. The benefit of Laya is that
inference runs where you choose - on your own machine, or on a host you control -
so it is not a drop-in accuracy replacement for a hosted Jev model.

## Configuration

Config files are searched in this order, project before global and JSON before
YAML:

1. `<project>/.omp/class-router.json`
2. `<project>/.omp/class-router.yml`
3. `<project>/.omp/class-router.yaml`
4. `~/.omp/class-router.json`
5. `~/.omp/class-router.yml`
6. `~/.omp/class-router.yaml`

Project files (1-3) are read only when the host trusts the project
(`ctx.isProjectTrusted()`). A config can choose the executable the Laya sidecar
runs and the endpoint that receives your prompts and a bearer token, so a cloned
repository must not be able to supply one. In an untrusted project a project
file is reported and skipped, and the global files are used. Trusting the
project later reloads the config on the next prompt or `/class-router` command.

Both formats describe exactly the same configuration, so use whichever you
prefer:

```yaml
# ~/.omp/class-router.yml
backend: jev
routing:
  confidenceThreshold: 0.7
  modelMapping:
    hard: @slow
```

```json
{ "backend": "jev", "routing": { "confidenceThreshold": 0.7, "modelMapping": { "hard": "@slow" } } }
```

YAML is parsed by the host (`Bun.YAML`), which is free because pi and omp are both
Bun. A YAML file on a host without a parser is reported as an error rather than
silently skipped, so a `.yml` that is being ignored is always visible.

These paths are literal and identical on both hosts: the extension discovers its
own config and never reads host settings. In particular this file is **not**
omp's `~/.omp/agent/config.yml` (that is omp's own settings: `modelRoles`, theme,
advisor) and not pi's `~/.pi/agent/settings.json`. They sit alongside each other
and are unrelated.

The first existing file that parses and validates wins; a project file therefore
overrides a global one, and a `.json` overrides a `.yml` in the same scope. A
missing file everywhere is not an error: built-in defaults apply. A file that
cannot be read or parsed is reported and the search continues; a file that parses
but violates the contract is rejected outright
(routing falls back to defaults and the errors are notified), because silent
mis-routing is worse than leaving the model alone.

Values are layered over the defaults: top-level sections (`jev`, `laya`,
`routing`, `circuitBreaker`) merge one level deep, and the `modelMapping` and
`fallbackChains` maps merge by key. Scalar and array values replace wholesale,
and so does `routing.questions`: every question is sent to the classifier on
every prompt, so a file that declares `questions` supplies the complete set, and
the default `task_complexity` question is not sent unless the file includes it.

Every value is type-checked, and every question must be well formed (a known
`type`, `instructions`, and at least two options or levels for `choice` and
`score`). A bad value rejects the file. An unknown key does not: it is reported
as a warning, with a suggestion when it looks like a misspelling (for example,
`confidenceTreshold`), because otherwise the setting would silently keep its
default. Keys starting with `$` (such as `$comment`) are treated as annotations
and ignored. Config is cached per session and reloaded when the session's
working directory changes.

| key | default |
| --- | --- |
| `enabled` | `true` |
| `backend` | `"jev"` |
| `dryRun` | `false` |
| `notify` | `true` |
| `applyTo` | `"all"` |
| `routing.questions` | one `task_complexity` choice question (`trivial`, `standard`, `hard`) |
| `routing.primaryQuestion` | `"task_complexity"` |
| `routing.modelMapping` | `{ trivial: "@smol", standard: "@default", hard: "@slow" }` (omp-shaped alias specs; see Hosts) |
| `routing.fallbackChains` | each spec falls back to itself then its neighbour (`@smol` -> `@default`, `@default` -> `@slow`, `@slow` -> `@default`) |
| `routing.confidenceThreshold` | `0.5` |
| `routing.defaultCategory` | `"standard"` |
| `routing.maxPromptChars` | `8000` |
| `circuitBreaker.failureThreshold` | `3` |
| `circuitBreaker.cooldownMs` | `120000` |
| `circuitBreaker.halfOpenMaxTrials` | `1` |

`routing.primaryQuestion` must name a `choice` question: score and noul answers
cannot name a model category. Other questions are answered, reported by
`/class-router explain`, and stored on the decision, but do not affect routing.

`maxPromptChars` limits how much of each prompt the classifier receives (at
least `200`, or `null` for no limit). A longer prompt keeps its first and last
halves with a `[... N characters omitted ...]` marker between them, because the
actual request is usually at the start or end of a large paste. This limits
token cost and latency without changing what is sent to the model itself.

Prompts that are slash commands (the first word is a command name such as
`/review` or `/class-router`) are not classified. A prompt that starts with a
path, such as `/home/me/app.ts is failing`, is a normal request and is
classified.

`fallbackChains` maps a **spec** (not a category) to the ordered candidates tried
when its circuit is open; a spec with no entry falls back to itself. If every
candidate is unavailable the decision reason is `all-circuits-open` and the
session model is left alone.

`applyTo` is `"all"`, `"main"`, or `"subagents"`. Subagent sessions are detected
from the session file path the host reports (see Limits): the patterns come from
omp's on-disk layout. Measured on both hosts: omp writes `<tmp>/omp-task-<hex>/<Agent>.jsonl`
or nests the child under the parent's own `.jsonl` file, whereas upstream pi writes
`<session-dir>/<timestamp>_<id>.jsonl`, whose parent directory name does not end in
`.jsonl`. Upstream pi also has no `task` tool, so it has no subagent sessions to
detect in the first place. A path matching neither pattern is treated as `main`, so
`applyTo: "main"` cannot silently disable routing everywhere.

## Worked example

`examples/class-router.json` is a complete, valid config: Jev backend, a second
noul question, explicit mapping, chains, and breaker settings. It uses role alias
specs (`@smol`, `@default`, `@slow`), so it is an omp config; on upstream pi
replace those values with concrete `provider/id` specs (see Hosts above).

```json
{
  "backend": "jev",
  "applyTo": "main",
  "jev": {
    "endpoint": "https://api.typesafe.ai/v1/systemone",
    "model": "jev-latest",
    "apiKeyEnvVar": "TYPESAFE_API_KEY",
    "timeoutMs": 3000
  },
  "routing": {
    "questions": {
      "task_complexity": {
        "type": "choice",
        "instructions": "How demanding is this request for an AI coding agent?",
        "criteria": {
          "trivial": "a single lookup, rename, or one-line answer; no exploration",
          "standard": "a normal multi-step edit or investigation inside one or two files",
          "hard": "large refactor, cross-cutting design, deep debugging, or long multi-file reasoning"
        }
      },
      "needs_plan": {
        "type": "noul",
        "instructions": "Does this request need an explicit plan before any edit?",
        "criteria": { "true": "the change spans modules, migrations, or public interfaces", "false": "the change is local and reversible" }
      }
    },
    "primaryQuestion": "task_complexity",
    "modelMapping": { "trivial": "@smol", "standard": "@default", "hard": "@slow" },
    "fallbackChains": {
      "@smol": ["@smol", "@default"],
      "@default": ["@default", "@slow"],
      "@slow": ["@slow", "@default"]
    },
    "confidenceThreshold": 0.5,
    "defaultCategory": "standard"
  },
  "circuitBreaker": { "failureThreshold": 3, "cooldownMs": 120000, "halfOpenMaxTrials": 1 }
}
```

A Laya deployment over HTTP differs only in the backend section; the routing and
breaker settings above carry over unchanged. The host behind `endpoint` runs the
same typed-question protocol, so nothing else in the config moves:

```json
{
  "backend": "laya",
  "laya": {
    "transport": "http",
    "endpoint": "https://gpu-host.internal/v1/systemone",
    "apiKeyEnvVar": "LAYA_ENDPOINT_TOKEN",
    "timeoutMs": 4000
  }
}
```

## Model specs

Mapping values and chain entries are resolved through `src/host.ts`. On omp that
is `ctx.models.resolve(spec)`, which accepts the same forms omp's `--model` flag
does: `provider/id`, a bare model id, or a configured role alias such as `@slow`.
Role aliases follow whatever those roles point to in settings, which is why they
are the recommended form there.

Upstream pi has no such facade, so resolution falls back to `ctx.modelRegistry`
(`find(provider, id)`, then a scan of `getAvailable()`, then the live
`ctx.model`), which understands concrete `provider/id` specs and bare ids only.
A role alias therefore resolves nothing on pi - see Hosts above for the concrete
specs to use there.

A spec that does not resolve leaves the session model alone with a warning. A
spec that resolves to the model already in use is treated as applied without a
redundant `setModel`. When `setModel` returns `false` (no auth for that model),
the extension notifies once per session and deliberately does **not** count it as
a breaker failure, because no request was ever sent. Where the host can answer
the auth question directly (`ctx.modelRegistry.hasConfiguredAuth`, as upstream pi
can), the extension asks before calling `setModel` and otherwise relies on its
return value.

## Circuit breaker

One breaker is kept per process, with one circuit per spec:

- `closed` - requests pass. Consecutive failures reaching `failureThreshold` open
  the circuit.
- `open` - requests are refused. After `cooldownMs` the circuit becomes
  `half_open` and admits at most `halfOpenMaxTrials` probes.
- `half_open` - a probe success closes the circuit and clears the failure count; a
  probe failure re-opens it with a fresh cooldown.

Checking a fallback chain never uses up a probe. A probe is claimed only for
the spec that actually runs the turn. If that run ends without an outcome being
attributed (a dry run, a spec that does not resolve, missing auth, or a manual
`/model` switch), the probe is handed back so the circuit can still recover.

The breaker is fed by observed outcomes, never by classification errors:

On omp:

- `auto_retry_start` records a failure for the spec this extension applied,
  classifying the error text as `rate_limit` (429/quota), `overloaded`
  (503/capacity), `auth` (401/403/invalid key), `transport` (abort/ECONNRESET/
  ETIMEDOUT), or `other`. One failure is recorded per run, so a retry storm does
  not open a circuit by repetition alone.
- `agent_end` settles the run: when `willContinue` is `true` the event is an
  automatic continuation, not a settle, and is ignored. Otherwise the run's
  outcome is attributed: success records a success, a trailing error/aborted
  assistant message (or a failure already seen from `auto_retry_start`) records a
  failure.
- `auto_retry_end` with `success: true` records a success; a failed retry leaves
  the failure that `auto_retry_start` recorded.

On upstream pi there are no retry events, so `agent_end` alone carries the
signal, and `willContinue` is not available: the run's outcome is read off the
trailing assistant message, which records a failure when `stopReason` is
`"error"` or `"aborted"` (or `errorMessage` is non-empty) and otherwise records a
success. The failure taxonomy above is therefore lossier on pi - the outcome is
known, the provider error class is not - but the breaker's open/half-open/closed
behaviour is the same.

Registration of the retry events is guarded, so a host whose event union rejects
them cannot break extension load; the breaker simply relies on `agent_end`.

Attribution only happens while the session model still equals the model this
extension applied. A manual `/model` switch, or another extension's override, is
never blamed on the router.

`/class-router reset` clears every circuit.

## Command

`/class-router [status|on|off|reset|explain]`

- no argument or `status` - enabled/dry-run, backend, config source, breaker
  snapshot (spec, state, failure count), last decision, and how many prompts were
  routed, skipped, or failed this session.
- `on` / `off` - toggle `enabled` at runtime for this session.
- `reset` - clear the circuit breaker.
- `explain` - the full last decision: category, confidence, spec, chain, apply,
  reason, detail, backend, plus every other question answer on its own line.
- anything else - the valid subcommands. Argument completion offers
  `status|on|off|reset|explain`.

All command output goes through `ctx.ui.notify`, one line per notification,
prefixed `[class-router]`. No notification contains the prompt body, a token, or
any other secret, and decision entries record only category, confidence, spec,
apply, reason, backend, and latency.

## dryRun

With `dryRun: true` the prompt is still classified and the decision is still
notified and recorded, but `setModel` is never called. It is the way to measure
what the router would choose against a fixed model before letting it route.

## Troubleshooting

### "It doesn't seem to do anything"

Most often nothing changed because the router chose the model you were already
on, which is a deliberate no-op: `setModel` is not called when the resolved model
is the current one. The default mapping makes this common, because `standard`
maps to `@default` and `hard` to `@slow`:

```
trivial  -> @smol     often deliberately cheaper than your default
standard -> @default  the model you are already using
hard     -> @slow     your stronger model, if `modelRoles.slow` differs
```

If `modelRoles.default` and `modelRoles.slow` name the same model, two of the
three categories route to where you already are and only `trivial` visibly moves.
Give `slow` a genuinely different model to see routing for hard prompts.

The record distinguishes the two cases for you: `changed: false` with a
non-null `resolved` means the router worked and the model was already right.

### Where to look

Every attempt is recorded on the session, and failures are recorded too; a
notification is ephemeral, so the transcript is the only durable audit trail:

```
~/.omp/agent/sessions/<project>/<timestamp>_<id>.jsonl    omp
~/.pi/agent/sessions/<project>/<timestamp>_<id>.jsonl     pi
```

```bash
# every routing attempt in a session, with outcome
grep -o '"customType":"class-router.decision".\{0,200\}' ~/.omp/agent/sessions/<project>/<session>.jsonl
```

Each entry records:

| field | meaning |
| --- | --- |
| `category`, `confidence` | what the classifier answered |
| `spec` | the spec the mapping chose |
| `resolved` | the model id that spec resolved to, or `null` if it did not resolve |
| `changed` | `true` only when the session model actually moved |
| `reason` | `routed`, or a decline such as `low-confidence` / `all-circuits-open` |
| `backend`, `latencyMs` | which classifier ran and how long it took |
| `error` | failure code, present when `reason` is `classification-failed` |

`reason: "classification-failed"` or `"backend-unavailable"` means the router ran
and could not classify. **No entry at all** means it never ran for that prompt,
which is what a session started before the extension was installed looks like.

The host's runtime log carries the diagnostic lines:

```bash
grep -i "class-router" ~/.omp/logs/omp.*.log | tail
```

Both hosts also expose this live: `/class-router status` shows the config source
it loaded, the breaker state, and the last decision, and `/class-router explain`
prints every answer behind it.

## Limits

- **Subagent detection is layout-based.** Neither host exposes an agent-kind to
  extensions: omp 18.2.9 has none on `ExtensionContext`, `session_start` carries
  no reason, `getHeader().parentSession` is unpopulated for task spawns, and
  subagents share the parent's process. The extension therefore reads the session
  file path (a subagent nests under `omp-task-<hex>/`, or under a directory named
  for the parent's `.jsonl` file), which depends on omp's on-disk layout rather
  than an API guarantee. Measured on upstream pi: its session files live at
  `<session-dir>/<timestamp>_<id>.jsonl`, which matches neither pattern, and pi has
  no `task` tool, so no subagent sessions arise there; unknown paths fail safe as `main`.
- **Routing adds one classifier round trip before the turn.** It is bounded by
  `timeoutMs` plus a small outer guard, and any failure degrades to the current
  model, but the latency is real.
- **Jev spends a token budget per prompt**, and a high-confidence threshold keeps
  more prompts on the session model rather than risking a wrong choice.
- **Laya accuracy depends on the checkpoint.** Zero-shot base checkpoints are
  near chance on typed decisions; fine-tuning is required for routing-quality
  answers.

## Third-party

Neither backend is vendored in this package. The MIT license above covers this
package's own source only; it does not extend to either backend or to any model
weights, none of which are redistributed here.

**Laya** is an optional, separately installed dependency. Its code and all three
checkpoints (`laya`, `laya-multilingual`, `laya-typed-decisions`) are licensed
Apache-2.0 by Convai Innovations, and the weights are downloaded from the Hub on
first use rather than shipped here. Install it yourself with
`pip install -r python/requirements.txt`; the sidecar imports it as a library and
contains none of its source. Project: https://github.com/NandhaKishorM/laya

**Jev** is a hosted service, not a licensed artifact, so no software license
applies. There is no code dependency on it: the extension makes HTTP calls to
TypeSafe's evaluation endpoint using an API key you supply, and your use is
governed by TypeSafe's own terms. See https://docs.typesafe.ai

The question and answer formats this extension speaks are the public wire
contracts of those two systems, which is what makes a single configuration work
against either.

## License

MIT. See [LICENSE](LICENSE).
