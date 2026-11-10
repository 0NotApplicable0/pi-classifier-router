# @ejstembler/pi-classifier-router

[![pipeline](https://gitlab.com/ejstembler/pi-classifier-router/badges/main/pipeline.svg)](https://gitlab.com/ejstembler/pi-classifier-router/-/pipelines)
[![npm](https://img.shields.io/npm/v/@ejstembler/pi-classifier-router.svg)](https://www.npmjs.com/package/@ejstembler/pi-classifier-router)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](package.json)

An extension for pi and Oh My Pi (omp) that classifies each incoming prompt with a
System-One model and routes the session to the model that fits it.

Before each turn, the extension sends the prompt to a classifier (TypeSafe
**Jev** over HTTP, or **Laya** in a local Python sidecar or on a shared host),
reads the typed answer that names a category (for example `trivial`, `standard`
or `hard`), maps that category to a model, and switches to it before the turn
reaches the provider. A per-model circuit breaker with fallback chains keeps a
failing model from being retried forever, and every routing attempt is recorded
on the session as a `class-router.decision` entry.

The extension never breaks a turn: a classification failure, an unresolvable
model, or a model without auth all leave the session's current model in place,
with a notification.

## Quick start

1. **Install** from npm:

   ```bash
   pi install npm:@ejstembler/pi-classifier-router       # pi
   omp plugin install @ejstembler/pi-classifier-router   # omp
   ```

2. **Give it a classifier.** The default backend is Jev, which needs a TypeSafe
   API key (see [docs.typesafe.ai](https://docs.typesafe.ai)). Either store it
   in the host's credential store, or export it:

   ```bash
   /login typesafe                 # inside pi/omp: stored, no environment variable needed
   export TYPESAFE_API_KEY=...     # or: environment variable, which takes precedence
   ```

   With Jev, the text of each classified prompt is sent to TypeSafe (see
   [Privacy](#privacy)). To keep prompts on your machine, use the local
   [Laya](#laya-local-sidecar-or-remote-http) backend instead.

3. **On pi only, map categories to real models.** The built-in mapping uses omp's
   role aliases (`@smol`, `@default`, `@slow`), which pi cannot resolve, so on pi
   the extension does nothing until you name concrete models. Create
   `~/.omp/class-router.json` (the path is the same on both hosts):

   ```json
   {
     "routing": {
       "modelMapping": {
         "trivial": "fireworks/accounts/fireworks/routers/glm-5p3-fast",
         "standard": "fireworks/accounts/fireworks/routers/glm-5p3-fast",
         "hard": "fireworks/accounts/fireworks/routers/deepseek-pro-latest"
       }
     }
   }
   ```

   See [Model specs](#model-specs) for the format.

4. **Start a new session** (extensions load at session start), then run
   `/class-router status` to see the config it loaded and its last decision.

5. **Optional: try it in dry run first.** Add `"dryRun": true` to the config to
   classify and record every decision without ever switching models, then check
   `/class-router explain` or the session log to see what it would have chosen.

## Install

### From npm

```bash
pi install npm:@ejstembler/pi-classifier-router       # pi, user-wide
pi install -l npm:@ejstembler/pi-classifier-router    # pi, this project only
omp plugin install @ejstembler/pi-classifier-router   # omp
```

### From a local checkout

The package declares its own entry point (`"pi": { "extensions": ["./src/index.ts"] }`
in `package.json`), so both hosts load it directly:

```bash
pi install /path/to/pi-classifier-router
pi -e /path/to/pi-classifier-router/src/index.ts     # one run only, no install

omp install /path/to/pi-classifier-router
omp -e /path/to/pi-classifier-router/src/index.ts
```

Both hosts also accept an `extensions` array in their settings files: pi reads
`~/.pi/agent/settings.json` (user) and `.pi/settings.json` (project, after
project trust); omp reads `.omp/settings.json` (project) and its user settings
file (run `omp config path` for the directory).

```json
{ "extensions": ["/path/to/pi-classifier-router/src/index.ts"] }
```

### After installing: restart the session

Extension **modules** load at session start, so a session that was already
running when you installed this one will not have it. `/reload-plugins` refreshes
skills, slash commands and MCP servers, but not extension modules. Until you
restart, prompts run with no router and leave no trace, which looks like a broken
extension.

### Upgrading

```bash
pi update --extensions                                        # pi
omp plugin install @ejstembler/pi-classifier-router --force   # omp
```

`omp plugin upgrade <name>` is for marketplace plugins only (`name@marketplace`);
for an npm-installed plugin it refuses and names the `plugin install --force`
form instead.

## Configuration

### Where config lives

Config files are searched in this order, project before global and JSON before
YAML:

1. `<project>/.omp/class-router.json`
2. `<project>/.omp/class-router.yml`
3. `<project>/.omp/class-router.yaml`
4. `~/.omp/class-router.json`
5. `~/.omp/class-router.yml`
6. `~/.omp/class-router.yaml`

The paths are the same on both hosts, including pi. This is the extension's own
file: it is **not** omp's `~/.omp/agent/config.yml` or pi's
`~/.pi/agent/settings.json`, and the extension never reads host settings.

**Project files (1-3) are read only when the host trusts the project.** A config
can choose the executable the Laya sidecar runs and the endpoint that receives
your prompts and a bearer token, so a cloned repository must not be able to
supply one. In an untrusted project a project file is reported and skipped, and
the global files are used. Trusting the project later reloads the config on the
next prompt or `/class-router` command.

**YAML works on omp only.** YAML is parsed with the host's built-in parser,
`Bun.YAML`. omp runs on Bun; pi runs on Node, which has none, so on pi use
`class-router.json`. A YAML file on a host without a parser is reported as an
error, never silently skipped. Both formats describe the same configuration:

```yaml
# ~/.omp/class-router.yml
backend: jev
routing:
  confidenceThreshold: 0.7
  modelMapping:
    hard: "@slow"    # quote it: a bare @ is not valid YAML
```

```json
{ "backend": "jev", "routing": { "confidenceThreshold": 0.7, "modelMapping": { "hard": "@slow" } } }
```

### How files are loaded and checked

- **The first existing file that parses and validates wins,** so a project file
  overrides a global one, and a `.json` overrides a `.yml` in the same scope. No
  file anywhere is fine: built-in defaults apply.
- **A file that cannot be read or parsed** is reported, and the search continues.
- **A file that parses but has a bad value is rejected** (routing falls back to
  the defaults and the errors are shown), because silently mis-routing is worse
  than leaving the model alone. Every value is type-checked, and every question
  must be well formed: a known `type`, `instructions`, and at least two options
  or levels for `choice` and `score`.
- **An unknown key is a warning, not an error,** with a suggestion when it looks
  like a misspelling (for example `confidenceTreshold`), because otherwise the
  setting would silently keep its default. Keys starting with `$` (such as
  `$comment`) are treated as annotations and ignored.
- **Values are layered over the defaults.** The sections (`jev`, `laya`,
  `routing`, `circuitBreaker`) merge one level deep, and the `modelMapping` and
  `fallbackChains` maps merge key by key. Other values replace the default
  wholesale, and so does `routing.questions`: every question is sent to the
  classifier on every prompt, so a file that declares `questions` supplies the
  complete set.
- **Config is cached per session** and reloaded when the session's working
  directory or project trust changes. A reload resets `/class-router on`/`off`.

### Settings

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | route prompts at all; `false` sends nothing to the classifier |
| `backend` | `"jev"` | `"jev"` or `"laya"`; see [Backends](#backends) |
| `dryRun` | `false` | classify and record, but never switch models |
| `notify` | `true` | show routing notifications; errors are always shown |
| `applyTo` | `"all"` | which sessions to route: `"all"`, `"main"`, or `"subagents"` |
| `routing.questions` | one `task_complexity` choice question (`trivial`, `standard`, `hard`) | the typed questions sent to the classifier |
| `routing.primaryQuestion` | `"task_complexity"` | the `choice` question whose answer picks the model |
| `routing.modelMapping` | `{ trivial: "@smol", standard: "@default", hard: "@slow" }` | category -> model spec (omp role aliases; see [Model specs](#model-specs)) |
| `routing.fallbackChains` | `@smol` -> `@default`, `@default` -> `@slow`, `@slow` -> `@default` | spec -> ordered specs to try when its circuit is open |
| `routing.confidenceThreshold` | `0.5` | below this confidence, the model is left alone |
| `routing.defaultCategory` | `"standard"` | category to use when the answer names an unmapped category; `null` leaves the model alone |
| `routing.maxPromptChars` | `8000` | most characters of a prompt sent to the classifier; `null` for no limit |
| `circuitBreaker.failureThreshold` | `3` | consecutive failures that open a model's circuit |
| `circuitBreaker.cooldownMs` | `120000` | how long an open circuit stays open before a probe |
| `circuitBreaker.halfOpenMaxTrials` | `1` | probes allowed while a circuit is half-open |

The `jev` and `laya` sections are described under [Backends](#backends).

**`routing.primaryQuestion`** must name a `choice` question: score and noul
answers cannot name a model category. Other questions are answered, shown by
`/class-router explain`, and stored on the decision, but do not affect routing.

**`routing.maxPromptChars`** must be at least `200`. A longer prompt keeps its
first and last halves with a `[... N characters omitted ...]` marker between
them, because the actual request is usually at the start or end of a large
paste. This limits classifier cost and latency without changing what the model
itself receives.

**`routing.fallbackChains`** maps a **spec** (not a category) to the candidates
tried in order when its circuit is open; a spec with no entry falls back to
itself. If every candidate is unavailable, the decision reason is
`all-circuits-open` and the session model is left alone.

**`applyTo`** tells subagent sessions apart by their session file path, which
depends on omp's on-disk layout (see [Limits](#limits)). A path it does not
recognize counts as `main`, so `applyTo: "main"` cannot silently disable routing
everywhere.

**Slash commands are not classified.** A prompt counts as one when its first word
is a command name such as `/review` or `/class-router`. A prompt that starts with
a path, such as `/home/me/app.ts is failing`, is a normal request and is
classified.

### Model specs

Mapping values and chain entries are model specs, and what a host can resolve
differs:

- **omp** resolves specs with `ctx.models.resolve()`, which accepts the same forms
  as omp's `--model` flag: `provider/id`, a bare model id, or a role alias such
  as `@slow`. Role aliases follow whatever those roles point to in omp's
  settings, which is why they are the recommended form there.
- **pi** has no alias support, so specs must be concrete `provider/id` specs or
  bare model ids that pi's model registry knows. The built-in role-alias defaults
  resolve nothing on pi: each decision notifies
  `spec <spec> did not resolve; keeping session model` and leaves the model
  alone.

A spec is split into provider and id on the **first** slash only, because pi's
model ids themselves contain slashes. In
`fireworks/accounts/fireworks/routers/deepseek-pro-latest`, the provider is
`fireworks` and the id is `accounts/fireworks/routers/deepseek-pro-latest`. A full
pi mapping, with a fallback chain:

```json
{
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

A spec that resolves to the model already in use is recorded as applied without
switching. When the host reports no auth for a model, the extension notifies
once per session and keeps the current model, and does **not** count it as a
circuit-breaker failure, because no request was ever sent.

### Worked example

`examples/class-router.json` is a complete, valid config: Jev backend, a second
noul question, explicit mapping, chains, and breaker settings. It uses role
aliases, so it is an omp config; on pi, replace those values with concrete specs.

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
breaker settings carry over unchanged:

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

## Backends

`backend` picks the classifier. Sessions whose configs match share one
classifier; sessions with different configs each get their own.

### Jev (TypeSafe, HTTP)

| key | default | meaning |
| --- | --- | --- |
| `endpoint` | `https://api.typesafe.ai/v1/systemone` | System-One evaluation endpoint |
| `model` | `jev-latest` | model alias sent in the request body |
| `apiKeyEnvVar` | `TYPESAFE_API_KEY` | environment variable holding the bearer token |
| `credentialProvider` | `typesafe` | host credential-store provider used when `apiKeyEnvVar` is unset; blank disables the lookup |
| `timeoutMs` | `3000` | time allowed per classification |

The token is read from the named environment variable or, when that is unset,
from the host's stored credential for `credentialProvider`
(`ctx.modelRegistry.getApiKeyForProvider`, filled by `/login typesafe`). It is
sent as `Authorization: Bearer <token>`, and never logged or included in
errors. A missing token makes Jev `unavailable`, and the session keeps its model.

#### Privacy

With Jev, the text of every prompt the router classifies is sent to the TypeSafe
API (or whatever `endpoint` names). Slash commands and empty prompts are never
sent, and `routing.maxPromptChars` limits how much of a long prompt is sent. If
prompts must not leave the machine, use `backend: "laya"` with the local sidecar,
or set `enabled: false` in the projects that need it.

### Laya (local sidecar or remote HTTP)

| key | default | meaning |
| --- | --- | --- |
| `transport` | `"python"` | where inference runs: `"python"` spawns the local sidecar, `"http"` posts to `endpoint` |
| `endpoint` | `""` | full URL of a System-One-compatible endpoint; `"http"` only |
| `apiKeyEnvVar` | `""` | environment variable holding an optional bearer token for `endpoint`; blank sends no `Authorization` header |
| `pythonBin` | `python3` | interpreter that runs the sidecar |
| `workerScript` | `python/laya_worker.py` | worker path (absolute, or relative to the extension root) |
| `repo` | `convaiinnovations/laya` | Hugging Face repo bundling the checkpoints; `router: false` only |
| `subfolder` | `null` | `null` = English root, `"multilingual"`, `"typed-decisions"`; `router: false` only |
| `device` | `null` | torch device (`cpu`, `cuda`, `mps`), or `null` to detect automatically |
| `router` | `true` | serve checkpoints through `laya.Router`, which picks one per prompt by language |
| `maxLoaded` | `null` | checkpoints `laya.Router` keeps loaded; `null` keeps Laya's default (English + multilingual); `router: true` only |
| `preload` | `true` | load weights during warmup instead of on the first classification |
| `timeoutMs` | `4000` | time allowed per classification |
| `warmupTimeoutMs` | `600000` | time allowed for loading weights |
| `hfTokenEnvVar` | `HF_TOKEN` | environment variable holding the Hugging Face token |

**`router` decides how checkpoints are chosen.** `laya.Router` takes no repo or
subfolder: it always serves the `convaiinnovations/laya` checkpoints. So with the
local sidecar and `backend: "laya"`, a config that sets `repo` or `subfolder`
together with `router: true` is rejected rather than silently ignored. To load
one specific checkpoint (for example `"typed-decisions"`, or a fine-tune in your
own repo), set `router: false`. `maxLoaded` is the reverse: it only applies to
the Router, so setting it with `router: false` is rejected.

**`transport` decides which fields matter.** The sidecar-only keys (`pythonBin`,
`workerScript`, `repo`, `subfolder`, `device`, `router`, `maxLoaded`, `preload`,
`warmupTimeoutMs`, `hfTokenEnvVar`) are ignored with `"http"`, and
`endpoint`/`apiKeyEnvVar` are ignored with `"python"`. Both transports share
`timeoutMs` and speak the same protocol, so moving between them is a config
change. `"http"` requires an `http:` or `https:` `endpoint`. Credentials are
optional: a blank `apiKeyEnvVar` sends no `Authorization` header, while a named
variable that is not set fails the call as `unavailable` without sending
anything.

#### Where Laya runs

- **Local Python sidecar** (`transport: "python"`, the default). This
  repository's own `python/laya_worker.py`, run as a child process. It needs
  Python 3.10+ with the requirements installed, plus a one-time multi-GB weight
  download from Hugging Face. After preload, a prompt costs roughly 200-460 ms of
  CPU, which is why Laya's default `timeoutMs` is larger than Jev's. Nothing
  leaves the machine.
- **One shared host over HTTP** (`transport: "http"`). Point `endpoint` at a
  containerized worker, a FastAPI wrapper around it, or any endpoint speaking the
  same protocol, and clients route without a local install. Upstream measures
  roughly 33 ms per prompt on a GPU. The trade-off is a network hop: routing
  depends on that host being reachable.
- **Local without Python, via ONNX** (planned, not implemented). No ONNX export
  of Laya exists yet, because its decision heads are not part of the standard
  graph. No config value enables this.

Setup for the local sidecar:

```bash
pip install -r python/requirements.txt
export HF_TOKEN=...        # only needed for a gated repo
```

#### How the sidecar behaves

- **First run** downloads the checkpoint weights into the usual transformers
  cache, which dominates the first startup.
- **Warmup starts at session start and never blocks the session.** With
  `preload: true` the weights load in the background (bounded by
  `warmupTimeoutMs`), so a slow load does not use up the first prompt's
  `timeoutMs`. With `preload: false`, the first classification pays for the load.
- **It is started on first use, keeps the checkpoints loaded, and is restarted
  after a crash,** so a dead worker costs one prompt (`unavailable`), not the
  session.
- **Requests that expire while queued are skipped.** The worker handles one
  request at a time and cannot stop a prediction once started, so each request
  carries a deadline. A request still queued at its deadline is answered with
  `timeout` instead of being run, so one slow prediction does not make every
  request behind it time out too.
- **Latency depends on the device.** A GPU (`cuda`/`mps`) answers in tens to low
  hundreds of milliseconds; CPU-only is roughly ten times slower. An outer guard
  also bounds every call, so a stuck sidecar cannot hang a turn.

#### Accuracy

Upstream benchmarks evaluate Laya as a fine-tuned System-One model. A base
checkpoint used zero-shot is close to chance on typed decisions, so expect
near-random routing until you use a checkpoint fine-tuned for your question set.
The default `router: true` always serves the base checkpoints; to use a
fine-tuned one, set `router: false` and point `repo`/`subfolder` at it. Laya's
advantage is that inference runs where you choose, not accuracy out of the box.

## Command

`/class-router [status|on|off|reset|explain]`

- no argument or `status` - enabled/dry run, backend, config source, circuit
  states (spec, state, failure count), the last decision, and how many prompts
  were routed, skipped, or failed in this session.
- `on` / `off` - turn routing on or off for this session, until the config is
  next reloaded.
- `reset` - clear the circuit breaker (shared by every session with the same
  `circuitBreaker` settings).
- `explain` - the full last decision: category, confidence, spec, chain, apply,
  resolved model, reason, detail, backend, plus every other question's answer.
- anything else - lists the valid subcommands. Tab completion offers them too.

All output goes through the host's notifications, one line each, prefixed
`[class-router]`. No notification contains the prompt text, a token, or any
other secret.

## Dry run

With `dryRun: true` the prompt is still classified and the decision is still
shown and recorded, but the model is never switched. Use it to see what the
router would choose before letting it route.

## Circuit breaker

Each model spec has a circuit:

- `closed` - requests pass. `failureThreshold` consecutive failures open it.
- `open` - the spec is skipped (the fallback chain moves on). After `cooldownMs`
  it becomes `half_open`.
- `half_open` - up to `halfOpenMaxTrials` probe runs are allowed. A success
  closes the circuit; a failure re-opens it with a fresh cooldown.

Breakers are shared by sessions with the same `circuitBreaker` settings and
persist for the life of the process. Checking a fallback chain never uses up a
probe: a probe is claimed only for the spec that actually runs the turn, and is
handed back if the run ends without an outcome (a dry run, a spec that does not
resolve, missing auth, or a manual `/model` switch).

**Only real model outcomes count, never classifier errors.** Outcomes are
attributed only while the session is still on the model this extension chose, so
a manual `/model` switch or another extension's override is never blamed on the
router.

- **On omp**, `auto_retry_start` records a failure for the applied spec (one per
  run, so a retry storm does not open a circuit by itself), and classifies the
  error as `rate_limit`, `overloaded`, `auth`, `transport`, or `other` for the
  logs. `auto_retry_end` with `success: true` records a success. `agent_end`
  settles the run, unless it is an automatic continuation (`willContinue`).
- **On pi**, which has no retry events, `agent_end` alone decides: the run failed
  if the last assistant message ended in `"error"` or `"aborted"` (or has an
  `errorMessage`), and succeeded otherwise.

## Troubleshooting

### "It doesn't seem to do anything"

- **Started before installing?** A session started before the extension was
  installed has no router. Restart it.
- **On pi with the defaults?** The default mapping uses omp role aliases, which
  pi cannot resolve. Set concrete specs (see [Model specs](#model-specs)).
- **Already on the right model?** If the router picks the model you are already
  using, nothing visibly changes. With the defaults, `standard` maps to
  `@default`, the model you usually start on:

  ```
  trivial  -> @smol     often deliberately cheaper than your default
  standard -> @default  the model you are already using
  hard     -> @slow     your stronger model, if `modelRoles.slow` differs
  ```

  If omp's `modelRoles.default` and `modelRoles.slow` name the same model, only
  `trivial` prompts visibly move. Give `slow` a different model to see hard
  prompts routed. The decision record shows this case as `changed: false` with a
  non-null `resolved`: the router worked, and the model was already right.

### Where to look

`/class-router status` shows the config it loaded, the circuit states and the
last decision, and `/class-router explain` shows every answer behind it.

For history, every routing attempt, including failures, is recorded in the
session file:

```
~/.omp/agent/sessions/<project>/<timestamp>_<id>.jsonl    omp
~/.pi/agent/sessions/<project>/<timestamp>_<id>.jsonl     pi
```

```bash
# every routing attempt in a session, with its outcome
grep -o '"customType":"class-router.decision".\{0,200\}' ~/.omp/agent/sessions/<project>/<session>.jsonl
```

Each entry records:

| field | meaning |
| --- | --- |
| `category`, `confidence` | what the classifier answered |
| `spec`, `apply` | the spec the mapping chose, and the one picked from its fallback chain |
| `resolved` | the model id that spec resolved to, or `null` if it did not resolve |
| `changed` | `true` only when the session model actually switched |
| `reason` | why, from the table below |
| `backend`, `latencyMs` | which classifier ran and how long routing took |
| `error` | failure code, when `reason` is `classification-failed` |

| `reason` | meaning |
| --- | --- |
| `routed` | a model was picked; `changed` says whether the session actually switched to it |
| `unknown-category` | the answer named an unmapped category, so `defaultCategory`'s model was picked |
| `low-confidence` | confidence was below `confidenceThreshold`; model left alone |
| `missing-answer` | the classifier returned no usable answer to the primary question; model left alone |
| `unmapped-category` | the category is unmapped and there is no usable `defaultCategory`; model left alone |
| `all-circuits-open` | every spec in the fallback chain has an open circuit; model left alone |
| `classification-failed` | the classifier call failed (`error` says how: `timeout`, `auth`, `unavailable`, ...) |
| `backend-unavailable` | the classifier could not be created at all |

**No entry at all** for a prompt means the router never ran for it: the prompt
was a slash command, routing was off or excluded by `applyTo`, or the session
started before the extension was installed.

The host's log has the diagnostic lines:

```bash
grep -i "class-router" ~/.omp/logs/omp.*.log | tail
```

On pi, set `CLASS_ROUTER_DEBUG=1` to get the same lines on stderr.

## Hosts

One entry point loads on both **pi 0.87.x** and **Oh My Pi (omp) 18.2.x**; the
extension detects what each host offers and uses it.

| | omp 18.2.x | pi 0.87.x |
| --- | --- | --- |
| model specs | `provider/id`, bare id, or role alias (`@slow`) | `provider/id` or bare id only |
| YAML config | yes | no (runs on Node); use JSON |
| failure signal | retry events, with an error category | end of run only |
| automatic continuations | recognized | not available |

How detection, timers, logging, sharing and the wire protocols work is described
in [docs/ARCHITECTURE.md](https://gitlab.com/ejstembler/pi-classifier-router/-/blob/main/docs/ARCHITECTURE.md).

## Limits

- **Subagent detection is based on file paths.** Neither host tells an extension
  whether a session is a subagent, so `applyTo` reads the session file path. That
  depends on omp's on-disk layout, not an API guarantee. pi has no subagents.
- **Routing adds one classifier round trip before each turn.** It is bounded by
  `timeoutMs` plus a small guard, and a failure keeps the current model, but the
  latency is real.
- **Jev costs tokens on every prompt.** A higher `confidenceThreshold` keeps more
  prompts on the session model rather than risking a wrong choice.
- **Laya accuracy depends on the checkpoint.** Base checkpoints are near chance;
  routing quality needs a fine-tuned one.

## Development

```bash
npm ci
npm test               # Node test runner; the Laya tests skip without python3
npm run typecheck
npm run lint           # Biome: TypeScript lint and format check
npm run lint:python    # Ruff on the Python worker, via uvx
npm run format         # apply Biome formatting
```

The test suite needs no network access or API keys; see
[tests/README.md](https://gitlab.com/ejstembler/pi-classifier-router/-/blob/main/tests/README.md).
`scripts/smoke-live.mjs` is a separate live probe against the real Jev API and
needs `TYPESAFE_API_KEY`.

CI runs lint, typecheck and the tests on Node and Bun, plus Ruff, on every push.

**Releasing:**

1. Commit with a descriptive message body. Commit bodies become the release
   notes.
2. Bump the version: `npm version <x.y.z> --no-git-tag-version`, commit, and tag
   it `v<x.y.z>` (annotated).
3. `npm publish`, then `git push --follow-tags`.

When the tag's pipeline passes, CI creates the GitLab release automatically, with
notes generated by `scripts/release-notes.mjs`.

## Third-party

Neither backend is included in this package. The MIT license covers this
package's own source only; it does not extend to either backend or to any model
weights, none of which are redistributed here.

**Laya** is an optional, separately installed dependency. Its code and all three
checkpoints (`laya`, `laya-multilingual`, `laya-typed-decisions`) are licensed
Apache-2.0 by Convai Innovations, and the weights are downloaded from Hugging
Face on first use rather than shipped here. Install it with
`pip install -r python/requirements.txt`; the sidecar imports it as a library and
contains none of its source. Project: https://github.com/NandhaKishorM/laya

**Jev** is a hosted service, not licensed software. There is no code dependency
on it: the extension makes HTTP calls to TypeSafe's endpoint with an API key you
supply, and your use is governed by TypeSafe's own terms. See
https://docs.typesafe.ai

## License

MIT. See [LICENSE](LICENSE).
