/**
 * Shared System-One HTTP client.
 *
 * Both backends speak the same wire format, so this is the single transport:
 * `POST <endpoint>` with `Authorization: Bearer <token>` (only when a token is
 * configured and present), `Content-Type: application/json`, and body
 * `{ state, model?, questions }`; response `{ model?, answers, usage? }`.
 *
 * The bearer token is read from the configured environment variable and is
 * never logged or embedded in errors. Every request is bounded by `timeoutMs`,
 * composed with the caller's own signal so either side can abort, and the
 * timer is always cleared.
 */

import { ClassifierError } from "../types.ts";
import type {
  Answers,
  ClassificationResult,
  Classifier,
  ClassifierErrorCode,
  ClassifierState,
  ClassifyOptions,
  Questions,
} from "../types.ts";
import type { ClassifierDeps } from "./index.ts";

/** Body snippet length kept for diagnostics; long bodies are never echoed. */
const SNIPPET_LIMIT = 200;

export interface HttpClassifierOptions {
  /** Backend id reported on `Classifier.name` and on `ClassifierError.backend`. */
  name: string;
  endpoint: string;
  /** Value for the request body's `model` field; omitted from the body when null. */
  model: string | null;
  /** Env var holding the bearer token; when unset or empty, no Authorization header is sent. */
  apiKeyEnvVar: string;
  timeoutMs: number;
}

export function createHttpClassifier(options: HttpClassifierOptions, deps: ClassifierDeps = {}): Classifier {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const backend = options.name;

  function token(): string {
    const envVar = options.apiKeyEnvVar;
    if (envVar.trim() === "") return "";
    const fromDeps = deps.env?.[envVar];
    const value = fromDeps ?? process.env[envVar];
    return (value ?? "").trim();
  }

  return {
    name: backend,

    /**
     * Uniform no-op: probing the endpoint would spend tokens for no signal, and
     * `classify` works without a prior warmup.
     */
    async warmup(): Promise<void> {},

    async classify(
      state: ClassifierState,
      questions: Questions,
      classifyOptions?: ClassifyOptions,
    ): Promise<ClassificationResult> {
      const bearer = token();
      const envVar = options.apiKeyEnvVar;
      if (bearer === "" && envVar.trim() !== "") {
        throw new ClassifierError(backend, "unavailable", `${envVar} is not set; ${backend} is unavailable`);
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (bearer !== "") headers["Authorization"] = `Bearer ${bearer}`;

      const body: Record<string, unknown> = { state, questions };
      if (options.model !== null) body["model"] = options.model;

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs);
      const caller = classifyOptions?.signal;
      const onCallerAbort = (): void => controller.abort();
      if (caller) {
        if (caller.aborted) controller.abort();
        else caller.addEventListener("abort", onCallerAbort, { once: true });
      }

      try {
        const response = await fetchImpl(options.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        const bodyText = await response.text();
        if (!response.ok) {
          const code: ClassifierErrorCode =
            response.status === 401 || response.status === 403
              ? "auth"
              : response.status === 429 || response.status >= 500
                ? "unavailable"
                : "protocol";
          const collapsed = bodyText.replace(/\s+/g, " ").trim().slice(0, SNIPPET_LIMIT);
          throw new ClassifierError(backend, code, `${backend} endpoint returned ${response.status}: ${collapsed}`);
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(bodyText);
        } catch (error) {
          throw new ClassifierError(backend, "protocol", `${backend} response was not JSON`, {
            cause: error,
          });
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new ClassifierError(backend, "protocol", `${backend} response was not a JSON object`);
        }

        const record = parsed as Record<string, unknown>;
        const answers = record["answers"];
        if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
          throw new ClassifierError(backend, "protocol", `${backend} response has no answers object`);
        }

        const result: ClassificationResult = { answers: answers as Answers };
        if (typeof record["model"] === "string") result.model = record["model"];
        const usage = record["usage"];
        if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) {
          result.usage = usage as ClassificationResult["usage"];
        }
        return result;
      } catch (error) {
        if (error instanceof ClassifierError) throw error;
        if (controller.signal.aborted) {
          if (caller?.aborted) {
            throw new ClassifierError(backend, "aborted", `${backend} request aborted by caller`, {
              cause: error,
            });
          }
          if (timedOut) {
            throw new ClassifierError(backend, "timeout", `${backend} request exceeded ${options.timeoutMs}ms`, {
              cause: error,
            });
          }
        }
        throw new ClassifierError(
          backend,
          "transport",
          `${backend} request failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      } finally {
        clearTimeout(timer);
        if (caller) caller.removeEventListener("abort", onCallerAbort);
      }
    },

    async dispose(): Promise<void> {},
  };
}
