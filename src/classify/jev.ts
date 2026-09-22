/**
 * TypeSafe Jev (System One) classifier.
 *
 * Jev speaks the shared System-One HTTP wire format, so this is a thin wrapper
 * over `createHttpClassifier` pinned to the `jev` backend id.
 */

import type { Classifier, JevBackendConfig } from "../types.ts";
import { createHttpClassifier } from "./http.ts";
import type { ClassifierDeps } from "./index.ts";

export function createJevClassifier(config: JevBackendConfig, deps: ClassifierDeps = {}): Classifier {
  return createHttpClassifier(
    {
      name: "jev",
      endpoint: config.endpoint,
      model: config.model,
      apiKeyEnvVar: config.apiKeyEnvVar,
      timeoutMs: config.timeoutMs,
    },
    deps,
  );
}
