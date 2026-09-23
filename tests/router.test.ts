import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultConfig } from "../src/config.ts";
import { decide } from "../src/router.ts";
import type { Answers, ChoiceAnswer, RouterConfig } from "../src/types.ts";

function choice(category: string, confidence: number): ChoiceAnswer {
  return { type: "choice", choice: category, probabilities: { [category]: confidence }, confidence };
}

function routedConfig(overrides: (config: RouterConfig) => void = () => {}): RouterConfig {
  const config = defaultConfig();
  overrides(config);
  return config;
}

test("routes a confident mapped choice to its spec", () => {
  const decision = decide(routedConfig(), { task_complexity: choice("hard", 0.9) });
  assert.equal(decision.reason, "routed");
  assert.equal(decision.category, "hard");
  assert.equal(decision.confidence, 0.9);
  assert.equal(decision.spec, "@slow");
  assert.equal(decision.apply, "@slow");
  assert.deepEqual(decision.chain, ["@slow", "@default"]);
  assert.equal(decision.detail.includes("\n"), false);
});

test("a below-threshold answer still reports category and spec but applies nothing", () => {
  const decision = decide(routedConfig(), { task_complexity: choice("trivial", 0.2) });
  assert.equal(decision.reason, "low-confidence");
  assert.equal(decision.category, "trivial");
  assert.equal(decision.spec, "@smol");
  assert.equal(decision.confidence, 0.2);
  assert.equal(decision.apply, null);
  assert.match(decision.detail, /0\.20/);
});

test("an unknown category falls back to defaultCategory", () => {
  const decision = decide(routedConfig(), { task_complexity: choice("enormous", 0.9) });
  assert.equal(decision.reason, "unknown-category");
  assert.equal(decision.spec, "@default");
  assert.equal(decision.apply, "@default");
});

test("an unmapped category with no default applies nothing", () => {
  const decision = decide(
    routedConfig((config) => {
      config.routing.defaultCategory = null;
    }),
    { task_complexity: choice("enormous", 0.9) },
  );
  assert.equal(decision.reason, "unmapped-category");
  assert.equal(decision.category, "enormous");
  assert.equal(decision.spec, null);
  assert.equal(decision.apply, null);
});

test("isAvailable filtering picks the second chain entry", () => {
  const decision = decide(
    routedConfig(),
    { task_complexity: choice("hard", 0.9) },
    {
      isAvailable: (spec) => spec !== "@slow",
    },
  );
  assert.equal(decision.reason, "routed");
  assert.equal(decision.spec, "@slow");
  assert.equal(decision.apply, "@default");
  assert.deepEqual(decision.chain, ["@default"]);
});

test("every candidate unavailable yields all-circuits-open", () => {
  const decision = decide(
    routedConfig(),
    { task_complexity: choice("hard", 0.9) },
    {
      isAvailable: () => false,
    },
  );
  assert.equal(decision.reason, "all-circuits-open");
  assert.equal(decision.spec, "@slow");
  assert.equal(decision.apply, null);
  assert.deepEqual(decision.chain, []);
});

test("enabled: false short-circuits before the answers are touched", () => {
  const trapped: Answers = new Proxy({} as Answers, {
    get() {
      throw new Error("answers must not be read when routing is disabled");
    },
    ownKeys() {
      throw new Error("answers must not be read when routing is disabled");
    },
    getOwnPropertyDescriptor() {
      throw new Error("answers must not be read when routing is disabled");
    },
  });
  const decision = decide(
    routedConfig((config) => {
      config.enabled = false;
    }),
    trapped,
  );
  assert.equal(decision.reason, "disabled");
  assert.equal(decision.apply, null);
  assert.deepEqual(decision.extra, {});
});

test("an empty question set yields no-questions", () => {
  const decision = decide(
    routedConfig((config) => {
      config.routing.questions = {};
    }),
    {},
  );
  assert.equal(decision.reason, "no-questions");
  assert.equal(decision.apply, null);
});

test("a non-choice primary answer is missing-answer", () => {
  const decision = decide(routedConfig(), {
    task_complexity: { type: "noul", noul: 0.9, confidence: 0.9 },
  });
  assert.equal(decision.reason, "missing-answer");
  assert.equal(decision.category, null);
  assert.equal(decision.confidence, 0);
  assert.equal(decision.apply, null);
});

test("an absent primary answer is missing-answer", () => {
  const decision = decide(routedConfig(), {});
  assert.equal(decision.reason, "missing-answer");
  assert.equal(decision.apply, null);
});

test("extra carries the non-primary answers", () => {
  const decision = decide(
    routedConfig((config) => {
      config.routing.questions = {
        ...config.routing.questions,
        review_depth: { type: "noul", instructions: "Does this need a careful review?" },
      };
    }),
    {
      task_complexity: choice("standard", 0.8),
      review_depth: { type: "noul", noul: 0.7, confidence: 0.6 },
    },
  );
  assert.equal(decision.reason, "routed");
  assert.deepEqual(Object.keys(decision.extra), ["review_depth"]);
  assert.equal(decision.extra.review_depth?.type, "noul");
});

test("dryRun keeps apply populated and notes it in the detail", () => {
  const decision = decide(
    routedConfig((config) => {
      config.dryRun = true;
    }),
    { task_complexity: choice("standard", 0.8) },
  );
  assert.equal(decision.reason, "routed");
  assert.equal(decision.apply, "@default");
  assert.match(decision.detail, /dry run/);
});
