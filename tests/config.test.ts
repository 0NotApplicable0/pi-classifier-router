import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { configPaths, defaultConfig, defaultYamlParser, loadConfig } from "../src/config.ts";
import type { YamlParser } from "../src/config.ts";

interface CleanupContext {
  after(fn: () => void): void;
}

function writeConfig(base: string, contents: string, name = "class-router.json"): void {
  const full = path.join(base, ".omp", name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

/** A scratch cwd/home pair; files are written under `<root>/<name>/.omp`. */
function workspace(
  ctx: CleanupContext,
  files: { project?: string; global?: string; projectYaml?: string; globalYaml?: string },
): { cwd: string; home: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "class-router-"));
  ctx.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  if (files.project !== undefined) writeConfig(cwd, files.project);
  if (files.global !== undefined) writeConfig(home, files.global);
  if (files.projectYaml !== undefined) writeConfig(cwd, files.projectYaml, "class-router.yml");
  if (files.globalYaml !== undefined) writeConfig(home, files.globalYaml, "class-router.yml");
  return { cwd, home };
}

test("configPaths lists project before global, JSON before YAML", () => {
  const paths = configPaths("/work/repo", "/home/me");
  assert.deepEqual(paths, [
    { path: path.join("/work/repo", ".omp", "class-router.json"), scope: "project", format: "json" },
    { path: path.join("/work/repo", ".omp", "class-router.yml"), scope: "project", format: "yaml" },
    { path: path.join("/work/repo", ".omp", "class-router.yaml"), scope: "project", format: "yaml" },
    { path: path.join("/home/me", ".omp", "class-router.json"), scope: "global", format: "json" },
    { path: path.join("/home/me", ".omp", "class-router.yml"), scope: "global", format: "yaml" },
    { path: path.join("/home/me", ".omp", "class-router.yaml"), scope: "global", format: "yaml" },
  ]);
});

test("missing config everywhere yields nulls without error", (t) => {
  const { cwd, home } = workspace(t, {});
  const result = loadConfig(cwd, home);
  assert.equal(result.config, null);
  assert.equal(result.source, null);
  assert.deepEqual(result.errors, []);
});

test("a project config overrides a global one", (t) => {
  const { cwd, home } = workspace(t, {
    project: JSON.stringify({ enabled: false }),
    global: JSON.stringify({ enabled: true, backend: "laya" }),
  });
  const result = loadConfig(cwd, home);
  assert.ok(result.config);
  assert.equal(result.config.enabled, false);
  assert.equal(result.config.backend, "jev");
  assert.equal(result.source?.scope, "project");
  assert.deepEqual(result.errors, []);
});

test("malformed project JSON reports an error and falls through to global", (t) => {
  const { cwd, home } = workspace(t, {
    project: "{ this is not json",
    global: JSON.stringify({ backend: "laya" }),
  });
  const result = loadConfig(cwd, home);
  assert.ok(result.config);
  assert.equal(result.config.backend, "laya");
  assert.equal(result.source?.scope, "global");
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /invalid JSON/);
});

test("a partial file merges over the defaults", (t) => {
  const { cwd, home } = workspace(t, { project: JSON.stringify({ backend: "laya" }) });
  const result = loadConfig(cwd, home);
  assert.ok(result.config);
  assert.equal(result.config.backend, "laya");
  assert.equal(result.config.routing.primaryQuestion, "task_complexity");
  assert.equal(result.config.routing.confidenceThreshold, 0.5);
  assert.equal(result.config.routing.modelMapping.hard, "@slow");
  assert.deepEqual(result.config.routing.fallbackChains["@smol"], ["@smol", "@default"]);
  assert.equal(result.config.circuitBreaker.failureThreshold, 3);
  const question = result.config.routing.questions.task_complexity;
  assert.ok(question);
  assert.equal(question.type, "choice");
});

test("defaultConfig is complete and internally consistent", () => {
  const config = defaultConfig();
  assert.equal(config.backend, "jev");
  assert.equal(config.applyTo, "all");
  assert.equal(config.routing.primaryQuestion, "task_complexity");
  const question = config.routing.questions[config.routing.primaryQuestion];
  assert.ok(question);
  assert.equal(question.type, "choice");
  // A second call must not share mutable state with the first.
  assert.notEqual(defaultConfig().routing, config.routing);
});

const INVALID_INPUTS: Array<[string, unknown]> = [
  ["an unknown backend", { backend: "bogus" }],
  ["an empty question set", { routing: { questions: {} } }],
  ["a non-object question set", { routing: { questions: [] } }],
  ["a primaryQuestion absent from questions", { routing: { primaryQuestion: "nope" } }],
  [
    "a primaryQuestion that is not a choice question",
    { routing: { questions: { task_complexity: { type: "noul", instructions: "yes or no?" } } } },
  ],
  ["an empty modelMapping", { routing: { modelMapping: {} } }],
  ["a non-string modelMapping value", { routing: { modelMapping: { trivial: 42 } } }],
  ["a confidenceThreshold above 1", { routing: { confidenceThreshold: 2 } }],
  ["a negative confidenceThreshold", { routing: { confidenceThreshold: -0.1 } }],
  ["a circuit breaker failureThreshold below 1", { circuitBreaker: { failureThreshold: 0 } }],
  ["a negative circuit breaker cooldownMs", { circuitBreaker: { cooldownMs: -1 } }],
  ["a circuit breaker halfOpenMaxTrials below 1", { circuitBreaker: { halfOpenMaxTrials: 0 } }],
  ["a non-positive jev timeoutMs", { jev: { timeoutMs: 0 } }],
  ["a non-positive laya timeoutMs", { laya: { timeoutMs: 0 } }],
  ["a fallback chain that is not an array", { routing: { fallbackChains: { "@smol": "@smol" } } }],
  ["a fallback chain containing an empty entry", { routing: { fallbackChains: { "@smol": ["@smol", "  "] } } }],
  ["a fallback chain containing a non-string", { routing: { fallbackChains: { "@smol": ["@smol", 7] } } }],
];

for (const [label, input] of INVALID_INPUTS) {
  test(`rejects ${label}`, (t) => {
    const { cwd, home } = workspace(t, { project: JSON.stringify(input) });
    const result = loadConfig(cwd, home);
    assert.equal(result.config, null);
    assert.equal(result.source, null);
    assert.ok(result.errors.length > 0);
  });
}

test("rejects a primaryQuestion pointing at a noul question even when other questions exist", (t) => {
  const { cwd, home } = workspace(t, {
    project: JSON.stringify({
      routing: {
        primaryQuestion: "is_hard",
        questions: {
          is_hard: { type: "noul", instructions: "Is this hard?" },
          task_complexity: { type: "choice", instructions: "Complexity?", criteria: { trivial: null, hard: null } },
        },
        modelMapping: { trivial: "@smol", hard: "@slow" },
      },
    }),
  });
  const result = loadConfig(cwd, home);
  assert.equal(result.config, null);
  assert.match(result.errors.join("\n"), /is_hard/);
});

test("a valid file with per-key routing overrides keeps sibling defaults", (t) => {
  const { cwd, home } = workspace(t, {
    project: JSON.stringify({
      routing: {
        modelMapping: { hard: "@review" },
        fallbackChains: { "@review": ["@review", "@slow"] },
      },
    }),
  });
  const result = loadConfig(cwd, home);
  assert.ok(result.config);
  assert.equal(result.config.routing.modelMapping.hard, "@review");
  assert.equal(result.config.routing.modelMapping.trivial, "@smol");
  assert.deepEqual(result.config.routing.fallbackChains["@review"], ["@review", "@slow"]);
  assert.deepEqual(result.config.routing.fallbackChains["@smol"], ["@smol", "@default"]);
});

test("laya transport defaults to python with blank endpoint and token variable", () => {
  const config = defaultConfig();
  assert.equal(config.laya.transport, "python");
  assert.equal(config.laya.endpoint, "");
  assert.equal(config.laya.apiKeyEnvVar, "");
});

test("a partial file without laya.transport keeps the python default", (t) => {
  const { cwd, home } = workspace(t, { project: JSON.stringify({ backend: "laya", laya: { device: "cpu" } }) });
  const result = loadConfig(cwd, home);
  assert.ok(result.config);
  assert.equal(result.config.laya.transport, "python");
  assert.equal(result.config.laya.device, "cpu");
  assert.equal(result.config.laya.endpoint, "");
});

const INVALID_TRANSPORT_INPUTS: Array<[string, unknown]> = [
  ["an unknown transport", { laya: { transport: "grpc" } }],
  ["a non-string transport", { laya: { transport: 7 } }],
  [
    "an http transport with no endpoint",
    { laya: { transport: "http" } },
  ],
  [
    "an http transport with a blank endpoint",
    { laya: { transport: "http", endpoint: "   " } },
  ],
  [
    "an http transport with a non-http endpoint",
    { laya: { transport: "http", endpoint: "ftp://gpu.example/classify" } },
  ],
  [
    "an http transport with a relative endpoint",
    { laya: { transport: "http", endpoint: "/classify" } },
  ],
];

for (const [label, input] of INVALID_TRANSPORT_INPUTS) {
  test(`rejects ${label}`, (t) => {
    const { cwd, home } = workspace(t, { project: JSON.stringify(input) });
    const result = loadConfig(cwd, home);
    assert.equal(result.config, null);
    assert.equal(result.source, null);
    assert.ok(result.errors.length > 0);
  });
}

test("accepts an http transport with a valid endpoint and keeps python-only defaults", (t) => {
  const { cwd, home } = workspace(t, {
    project: JSON.stringify({
      backend: "laya",
      laya: { transport: "http", endpoint: "https://gpu.example/v1/systemone" },
    }),
  });
  const result = loadConfig(cwd, home);
  assert.ok(result.config);
  assert.equal(result.config.laya.transport, "http");
  assert.equal(result.config.laya.endpoint, "https://gpu.example/v1/systemone");
  assert.equal(result.config.laya.pythonBin, "python3");
  assert.equal(result.config.laya.workerScript, "python/laya_worker.py");
  assert.equal(result.config.laya.repo, "convaiinnovations/laya");
  assert.equal(result.config.laya.preload, true);
  assert.equal(result.config.laya.warmupTimeoutMs, 600000);
  assert.equal(result.config.laya.hfTokenEnvVar, "HF_TOKEN");
  // A blank token variable is allowed; it just means no Authorization header.
  assert.equal(result.config.laya.apiKeyEnvVar, "");
});

test("an http transport endpoint may be http or https and needs no token variable", (t) => {
  const { cwd, home } = workspace(t, {
    project: JSON.stringify({
      backend: "laya",
      laya: { transport: "http", endpoint: "http://127.0.0.1:8080/classify" },
    }),
  });
  const result = loadConfig(cwd, home);
  assert.ok(result.config);
  assert.equal(result.config.laya.endpoint, "http://127.0.0.1:8080/classify");
  assert.equal(result.config.laya.apiKeyEnvVar, "");
});
// ---------------------------------------------------------------------------
// YAML config files
//
// Only Bun ships a YAML parser, so the tests that exercise the real parser skip
// on Node. The precedence and error-path tests inject a stub parser, so the
// candidate selection logic they cover runs on every host.
// ---------------------------------------------------------------------------

/** A stub standing in for the host parser; records what it was handed. */
function stubYaml(value: unknown): { parse: YamlParser; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    parse: (text: string) => {
      seen.push(text);
      return value;
    },
  };
}

test("a YAML candidate is used when no JSON file exists", (t) => {
  const { cwd, home } = workspace(t, { globalYaml: "backend: laya\n" });
  const stub = stubYaml({ enabled: false });
  const result = loadConfig(cwd, home, process.env, stub.parse);
  assert.ok(result.config, `errors: ${JSON.stringify(result.errors)}`);
  assert.equal(result.config.enabled, false);
  assert.equal(result.source?.format, "yaml");
  assert.equal(result.source?.scope, "global");
  assert.deepEqual(stub.seen, ["backend: laya\n"]);
  assert.deepEqual(result.errors, []);
});

test("JSON wins over YAML within the same scope", (t) => {
  const { cwd, home } = workspace(t, {
    global: JSON.stringify({ enabled: true }),
    globalYaml: "enabled: false\n",
  });
  const stub = stubYaml({ enabled: false });
  const result = loadConfig(cwd, home, process.env, stub.parse);
  assert.ok(result.config);
  assert.equal(result.source?.format, "json");
  assert.equal(result.config.enabled, true);
  assert.deepEqual(stub.seen, [], "the YAML candidate must not be parsed once JSON wins");
});

test("a project YAML file beats a global JSON file", (t) => {
  const { cwd, home } = workspace(t, {
    projectYaml: "enabled: false\n",
    global: JSON.stringify({ enabled: true, backend: "laya" }),
  });
  const stub = stubYaml({ enabled: false, backend: "laya" });
  const result = loadConfig(cwd, home, process.env, stub.parse);
  assert.ok(result.config);
  assert.equal(result.source?.scope, "project");
  assert.equal(result.source?.format, "yaml");
  assert.equal(result.config.enabled, false);
});

test("a YAML file with no parser available reports an error rather than being ignored", (t) => {
  const { cwd, home } = workspace(t, { globalYaml: "enabled: false\n" });
  const result = loadConfig(cwd, home, process.env, null);
  assert.equal(result.config, null);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /YAML config needs a YAML parser/);
  assert.match(result.errors[0]!, /class-router\.yml/);
});

test("invalid YAML reports an error and falls through to the next candidate", (t) => {
  const { cwd, home } = workspace(t, {
    projectYaml: "!!! not: valid: yaml\n",
    global: JSON.stringify({ enabled: false }),
  });
  const throwing: YamlParser = () => {
    throw new Error("bad document");
  };
  const result = loadConfig(cwd, home, process.env, throwing);
  assert.ok(result.config, `errors: ${JSON.stringify(result.errors)}`);
  assert.equal(result.source?.scope, "global");
  assert.equal(result.config.enabled, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /invalid YAML/);
});

test("a YAML scalar at the top level is rejected", (t) => {
  const { cwd, home } = workspace(t, { globalYaml: "just a string\n" });
  const stub = stubYaml("just a string");
  const result = loadConfig(cwd, home, process.env, stub.parse);
  assert.equal(result.config, null);
  assert.match(result.errors[0]!, /expected a YAML object at the top level/);
});

const hostYaml = defaultYamlParser();

test(
  "the host parser reads a real YAML document",
  hostYaml === null ? { skip: "host has no YAML parser (Bun provides one; Node does not)" } : {},
  (t) => {
    const { cwd, home } = workspace(t, {
      globalYaml: [
        "backend: laya",
        "enabled: false",
        "routing:",
        "  confidenceThreshold: 0.8",
        "  modelMapping:",
        "    hard: fireworks/accounts/fireworks/routers/deepseek-pro-latest",
        "",
      ].join("\n"),
    });
    const result = loadConfig(cwd, home);
    assert.ok(result.config, `errors: ${JSON.stringify(result.errors)}`);
    assert.equal(result.config.backend, "laya");
    assert.equal(result.config.enabled, false);
    assert.equal(result.config.routing.confidenceThreshold, 0.8);
    assert.equal(
      result.config.routing.modelMapping["hard"],
      "fireworks/accounts/fireworks/routers/deepseek-pro-latest",
    );
    assert.equal(result.source?.format, "yaml");
  },
);

// ---------------------------------------------------------------------------
// Mapping keys must name categories the primary question can actually emit. A
// typo is otherwise dead config that looks identical to the router not running.
// ---------------------------------------------------------------------------

test("a declared mapping key the primary question cannot emit is rejected", (t) => {
  const { cwd, home } = workspace(t, {
    global: JSON.stringify({ routing: { modelMapping: { trivail: "@smol" } } }),
  });
  const result = loadConfig(cwd, home);
  assert.equal(result.config, null);
  assert.ok(
    result.errors.some((message) => /trivail/.test(message) && /not a category/.test(message)),
    `expected a not-a-category error, got ${JSON.stringify(result.errors)}`,
  );
});

test("inherited mapping keys are not held against a custom question set", (t) => {
  const { cwd, home } = workspace(t, {
    global: JSON.stringify({
      routing: {
        questions: {
          effort: { type: "choice", instructions: "How much effort?", criteria: { small: "quick", big: "slow" } },
        },
        primaryQuestion: "effort",
        modelMapping: { small: "@smol", big: "@slow" },
      },
    }),
  });
  const result = loadConfig(cwd, home);
  assert.ok(result.config, `expected acceptance, got errors ${JSON.stringify(result.errors)}`);
  assert.equal(result.config.routing.modelMapping["small"], "@smol");
  // The defaults' own keys survive the merge and are simply not re-validated.
  assert.equal(result.config.routing.modelMapping["trivial"], "@smol");
});

test("a defaultCategory that is not mapped is rejected", (t) => {
  const { cwd, home } = workspace(t, {
    global: JSON.stringify({ routing: { defaultCategory: "nonexistent" } }),
  });
  const result = loadConfig(cwd, home);
  assert.equal(result.config, null);
  assert.ok(
    result.errors.some((message) => /defaultCategory/.test(message) && /never be applied/.test(message)),
    `expected a defaultCategory error, got ${JSON.stringify(result.errors)}`,
  );
});

test("an untrusted project's config is skipped, reported, and the global one used", (t) => {
  const { cwd, home } = workspace(t, {
    project: JSON.stringify({ backend: "laya", laya: { pythonBin: "/tmp/not-python" } }),
    global: JSON.stringify({ enabled: false }),
  });
  const result = loadConfig(cwd, home, process.env, null, { projectTrusted: false });
  assert.ok(result.config);
  assert.equal(result.source?.scope, "global");
  assert.equal(result.config.backend, "jev");
  assert.equal(result.config.laya.pythonBin, "python3");
  assert.equal(result.config.enabled, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /project config .*class-router\.json: ignored because this project is not trusted/);
});

test("an untrusted project with no config of its own reports nothing", (t) => {
  const { cwd, home } = workspace(t, { global: JSON.stringify({ enabled: false }) });
  const result = loadConfig(cwd, home, process.env, null, { projectTrusted: false });
  assert.equal(result.source?.scope, "global");
  assert.deepEqual(result.errors, []);
});

test("an untrusted project YAML config is skipped too", (t) => {
  const { cwd, home } = workspace(t, { projectYaml: "backend: laya\n" });
  const parse: YamlParser = () => ({ backend: "laya" });
  const result = loadConfig(cwd, home, process.env, parse, { projectTrusted: false });
  assert.equal(result.config, null);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /class-router\.yml: ignored because this project is not trusted/);
});

test("run from the home directory, the global file loads as global even when untrusted", (t) => {
  const { home } = workspace(t, { global: JSON.stringify({ enabled: false }) });
  const result = loadConfig(home, home, process.env, null, { projectTrusted: false });
  assert.equal(result.source?.scope, "global");
  assert.equal(result.config?.enabled, false);
  assert.deepEqual(result.errors, []);
});
