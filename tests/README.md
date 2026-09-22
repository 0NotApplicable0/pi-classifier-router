# Tests

## Running

```sh
npm test           # node --test tests/*.test.ts (128 tests, all passing)
npm run typecheck  # tsc --noEmit
```

Tests execute the `.ts` files directly on Node 24 native type stripping, so there is
no build step. That constraint is binding for everything under `src/` and `tests/`:
no TS `enum`, no `namespace`, and no constructor parameter properties, because type
stripping erases types without transforming runtime syntax.

## Layout

| File | Scope |
| --- | --- |
| `config.test.ts` | Config discovery order, deep-partial merge over defaults, validation errors. |
| `breaker.test.ts` | Circuit states (closed / open / half_open), failure counting, cooldown, trials, `firstAvailable`. |
| `router.test.ts` | Pure decision table from answers to `Decision`; no I/O. |
| `jev.test.ts` | Jev HTTP classifier against a local stub server. |
| `laya.test.ts` | Laya sidecar protocol against the Python stub worker. |
| `laya-http.test.ts` | Laya HTTP transport against a local stub server. |
| `host.test.ts` | Host capability adapter: `detectHost`, `resolveModel`, `currentModel`, `hasConfiguredAuth`, `startTimer`, `log`, `registerEvent`. |
| `extension.test.ts` | Whole extension driven through a fake `ExtensionAPI`. |

## Fixtures

`fixtures/stub_jev_server.ts` is an in-process HTTP server that replies with
Jev-shaped bodies (`{ model, answers, usage }`) and records each request, so tests
can assert the bearer token and the `questions` map that was sent.
`fixtures/stub_laya_worker.py` is the sidecar process speaking the Laya wire
protocol to the spawn-based classifier. `fixtures/fake-pi.ts` provides the fake
`ExtensionAPI`/`ExtensionContext` used by `extension.test.ts` and `host.test.ts`;
its `host` option models either host flavour (`"omp"` by default, or upstream
`"pi"`).

The extension targets the upstream pi extension API
(`@earendil-works/pi-coding-agent`) and runs on both pi 0.87.x and omp 18.2.x, so
the fixtures cover both: a `"pi"` host omits `ctx.models`, the managed timers, and
`pi.logger`, and instead adds `ctx.modelRegistry`.

Nothing in this suite makes an outbound network request, and no API key is
required: the stubs bind ephemeral local ports only.

## Live probe

`../scripts/smoke-live.mjs` is the single deliberate exception. It calls the real
TypeSafe endpoint for three sample prompts and prints the resulting decisions.

```sh
TYPESAFE_API_KEY=... node scripts/smoke-live.mjs
```

It requires `TYPESAFE_API_KEY`, is run by hand, and is never part of CI or
`npm test`.
