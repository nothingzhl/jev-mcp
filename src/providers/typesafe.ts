import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  score,
  TypeSafeClient,
  TypeSafeError,
  type Questions,
} from "@typesafe-ai/sdk";
import type { Config } from "../config.js";
import type { EvaluationProvider, EvaluationRequest, EvaluationResponse } from "../core/contracts.js";
import { JevError } from "../core/errors.js";
import { validateResponse } from "./validation.js";

export interface TypeSafeProviderOptions {
  /** Test-only dependency injection. Production credentials come from TYPESAFE_API_KEY. */
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}

// SDK debug logging includes request bodies. Keep every log method silent, independent of env settings.
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function upstreamError(error: unknown, budgetExpired: boolean): JevError {
  if (error instanceof JevError) return error;
  if (budgetExpired || error instanceof APITimeoutError) {
    return new JevError("TIMEOUT", "TypeSafe evaluation exceeded its time budget.");
  }
  if (error instanceof APIUserAbortError) return new JevError("TIMEOUT", "TypeSafe evaluation was cancelled.");
  if (error instanceof APIConnectionError) return new JevError("CONNECTION", "Could not connect to TypeSafe.");
  if (error instanceof APIError) {
    if (error.status === 401 || error.status === 403) {
      return new JevError("AUTHENTICATION", "TypeSafe authentication failed; check TYPESAFE_API_KEY and account access.");
    }
    if (error.status === 429) return new JevError("RATE_LIMIT", "TypeSafe rate limit reached; try again later.");
    if ([400, 413, 422].includes(error.status)) {
      return new JevError("INVALID_INPUT", "TypeSafe rejected the evaluation input.");
    }
    return new JevError("UPSTREAM", "TypeSafe could not complete the evaluation.");
  }
  if (error instanceof TypeSafeError) return new JevError("INVALID_INPUT", "TypeSafe could not validate the evaluation input.");
  return new JevError("UPSTREAM", "TypeSafe could not complete the evaluation.");
}

export class TypeSafeProvider implements EvaluationProvider {
  private readonly client: TypeSafeClient;
  private readonly timeoutMs: number;

  constructor(config: Config, options: TypeSafeProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
    if (!apiKey?.trim()) throw new JevError("AUTHENTICATION", "Set TYPESAFE_API_KEY before running a live evaluation.");
    this.timeoutMs = config.timeoutMs;
    try {
      this.client = new TypeSafeClient({
        apiKey: apiKey.trim(),
        // Explicitly override TYPESAFE_BASE_URL so credentials always go to the official service.
        baseURL: "https://api.typesafe.ai",
        defaultModel: config.model,
        timeout: config.timeoutMs,
        retry: { maxRetries: config.maxRetries },
        logLevel: "warn",
        logger: silentLogger,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    } catch {
      throw new JevError("CONFIGURATION", "Could not configure the TypeSafe client.");
    }
  }

  async evaluate(request: EvaluationRequest, signal?: AbortSignal): Promise<EvaluationResponse> {
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
    try {
      // The SDK's score() overload accepts runtime arrays while preserving the native JSON shape.
      const questions: Questions = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [
        id, question.type === "score" ? score(question.instructions, question.criteria) : question,
      ]));
      // Recipe metadata and local bookkeeping never cross the provider boundary.
      const { data, requestId } = await this.client.systemOne({
        model: request.model,
        state: request.state,
        questions,
      }, { signal: combinedSignal }).withResponse();
      return validateResponse(data, request, requestId);
    } catch (error) {
      throw upstreamError(error, budget.signal.aborted);
    } finally {
      clearTimeout(timer);
    }
  }
}
