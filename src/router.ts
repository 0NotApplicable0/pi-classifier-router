/**
 * Pure routing decision: config + classifier answers -> what model to apply.
 *
 * No I/O and no clock: the extension owns availability (circuit breaker),
 * `dryRun`, and `setModel`. Every early exit returns a reportable decision
 * (category/spec kept where known, `apply: null`) plus a single-line detail.
 */

import type { Answer, Answers, Decision, DecisionReason, RouterConfig } from "./types.ts";

export interface DecideOptions {
  isAvailable?: (spec: string) => boolean;
}

export function decide(config: RouterConfig, answers: Answers, options: DecideOptions = {}): Decision {
  const routing = config.routing;

  if (!config.enabled) {
    return {
      category: null,
      confidence: 0,
      spec: null,
      chain: [],
      apply: null,
      reason: "disabled",
      detail: "routing disabled (confidence 0.00); model unchanged",
      extra: {},
    };
  }

  if (Object.keys(routing.questions).length === 0) {
    return {
      category: null,
      confidence: 0,
      spec: null,
      chain: [],
      apply: null,
      reason: "no-questions",
      detail: "no routing questions configured (confidence 0.00); model unchanged",
      extra: {},
    };
  }

  const extra: Record<string, Answer> = {};
  for (const [id, answer] of Object.entries(answers)) {
    if (id !== routing.primaryQuestion) extra[id] = answer;
  }

  const primary = answers[routing.primaryQuestion];
  if (primary === undefined || primary.type !== "choice") {
    return {
      category: null,
      confidence: 0,
      spec: null,
      chain: [],
      apply: null,
      reason: "missing-answer",
      detail: `no choice answer for question ${JSON.stringify(routing.primaryQuestion)} (confidence 0.00); model unchanged`,
      extra,
    };
  }

  // `choice` is the only answer type that names a model category.
  const category = primary.choice;
  const confidence = primary.confidence;
  const isAvailable = options.isAvailable ?? (() => true);

  if (confidence < routing.confidenceThreshold) {
    const spec = routing.modelMapping[category] ?? null;
    const chain = spec === null ? [] : (routing.fallbackChains[spec] ?? [spec]).filter((entry) => isAvailable(entry));
    return {
      category,
      confidence,
      spec,
      chain,
      apply: null,
      reason: "low-confidence",
      detail:
        `category ${JSON.stringify(category)} (confidence ${confidence.toFixed(2)}) is below threshold ` +
        `${routing.confidenceThreshold.toFixed(2)}; model unchanged${spec === null ? "" : `; preferred spec ${spec}`}`,
      extra,
    };
  }

  let chosenCategory = category;
  let spec = routing.modelMapping[category];
  let reason: DecisionReason = "routed";

  if (spec === undefined) {
    const fallbackCategory = routing.defaultCategory;
    const mapped = fallbackCategory === null ? undefined : routing.modelMapping[fallbackCategory];
    if (fallbackCategory === null || mapped === undefined) {
      return {
        category,
        confidence,
        spec: null,
        chain: [],
        apply: null,
        reason: "unmapped-category",
        detail: `category ${JSON.stringify(category)} (confidence ${confidence.toFixed(2)}) is unmapped with no usable default; model unchanged`,
        extra,
      };
    }
    chosenCategory = fallbackCategory;
    spec = mapped;
    reason = "unknown-category";
  }

  const chain = (routing.fallbackChains[spec] ?? [spec])
    .filter((entry) => typeof entry === "string" && entry.trim() !== "")
    .filter((entry) => isAvailable(entry));

  if (chain.length === 0) {
    return {
      category: chosenCategory,
      confidence,
      spec,
      chain,
      apply: null,
      reason: "all-circuits-open",
      detail: `category ${JSON.stringify(chosenCategory)} (confidence ${confidence.toFixed(2)}) -> spec ${spec} but every candidate is unavailable`,
      extra,
    };
  }

  const apply = chain[0]!;
  const dryRunNote = config.dryRun ? "; dry run: model unchanged" : "";
  const detail =
    reason === "routed"
      ? `routed category ${JSON.stringify(chosenCategory)} (confidence ${confidence.toFixed(2)}) -> ${apply}${dryRunNote}`
      : `category ${JSON.stringify(category)} is unknown (confidence ${confidence.toFixed(2)}); using default ` +
        `${JSON.stringify(chosenCategory)} -> ${apply}${dryRunNote}`;

  return { category: chosenCategory, confidence, spec, chain, apply, reason, detail, extra };
}
