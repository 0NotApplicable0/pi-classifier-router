#!/usr/bin/env node
/**
 * Live smoke probe for the classifier router.
 *
 * Runs the REAL classifier (`createClassifier`) and the REAL decision function
 * (`decide`) against the production TypeSafe Jev endpoint, for three sample
 * prompts, so a human can judge whether the classifier's categories actually
 * line up with the model mapping. It deliberately does not load omp: only the
 * routing core is exercised, which is where mis-routing would come from.
 *
 * Usage: TYPESAFE_API_KEY=... node scripts/smoke-live.mjs
 * The key is never printed, echoed, or written to the config file.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createClassifier } from "../src/classify/index.ts";
import { loadConfig } from "../src/config.ts";
import { decide } from "../src/router.ts";

const API_KEY_ENV_VAR = "TYPESAFE_API_KEY";
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

if (!process.env[API_KEY_ENV_VAR]) {
  console.error(`smoke-live: ${API_KEY_ENV_VAR} is not set.`);
  console.error("smoke-live: export a TypeSafe API key and re-run: TYPESAFE_API_KEY=... node scripts/smoke-live.mjs");
  process.exit(1);
}

const SAMPLES = [
  { label: "trivial", prompt: "Rename the variable `foo` to `bar` in src/utils.ts." },
  {
    label: "large refactor",
    prompt:
      "Rewrite the entire authentication subsystem to support OAuth2, SSO, and multi-tenant session " +
      "isolation, migrating every caller and adding integration tests.",
  },
  { label: "ambiguous", prompt: "Can you take a look at the build and see if anything seems off?" },
];

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "class-router-smoke-"));
fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
fs.writeFileSync(
  path.join(cwd, ".omp", "class-router.json"),
  JSON.stringify(
    {
      backend: "jev",
      jev: { endpoint: ENDPOINT, model: "jev-latest", apiKeyEnvVar: API_KEY_ENV_VAR, timeoutMs: 30000 },
      dryRun: true,
      notify: false,
    },
    null,
    2,
  ),
);

const { config, source, errors } = loadConfig(cwd);
if (config === null) {
  console.error(`smoke-live: could not load a valid config: ${errors.join("; ") || "unknown error"}`);
  fs.rmSync(cwd, { recursive: true, force: true });
  process.exit(1);
}

console.log(`smoke-live: config ${source?.path ?? "<defaults>"} | backend ${config.backend} | endpoint ${config.jev.endpoint}`);
console.log(`smoke-live: primary question ${config.routing.primaryQuestion} | mapping ${JSON.stringify(config.routing.modelMapping)}`);

const classifier = createClassifier(config);
let failures = 0;

try {
  for (const sample of SAMPLES) {
    console.log(`\n=== ${sample.label} ===`);
    console.log(`prompt: ${sample.prompt}`);
    try {
      const result = await classifier.classify(sample.prompt, config.routing.questions);
      const decision = decide(config, result.answers);
      console.log(`decision: category=${decision.category ?? "none"} confidence=${decision.confidence.toFixed(2)} reason=${decision.reason}`);
      console.log(`would route to: ${decision.apply ?? "(leave session model alone)"}`);
      console.log(`chain: ${decision.chain.length === 0 ? "none" : decision.chain.join(" -> ")}`);
      console.log("raw answers:");
      console.log(JSON.stringify(result.answers, null, 2));
      if (result.usage) console.log(`usage: ${JSON.stringify(result.usage)}`);
    } catch (error) {
      failures += 1;
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error(`smoke-live: classification failed for ${sample.label}: ${detail}`);
      if (error && typeof error === "object" && "code" in error) {
        console.error(`smoke-live: error code ${String(error.code)}; backend ${String(error.backend ?? "unknown")}`);
      }
    }
  }
} finally {
  await classifier.dispose();
  fs.rmSync(cwd, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nsmoke-live: ${failures} of ${SAMPLES.length} samples failed.`);
  process.exit(1);
}
console.log("\nsmoke-live: ok");
