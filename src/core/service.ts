import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Config } from "../config.js";
import { getRecipe, listRecipes } from "../recipes/index.js";
import type { EvaluationProvider, EvaluationRequest, EvaluationResponse, JsonValue, RunRecord, RunStore } from "./contracts.js";
import { JevError, safeError } from "./errors.js";

export interface Plan {
  recipeId: string;
  recipeVersion: string;
  request: EvaluationRequest;
}

export interface RunResult {
  run: RunRecord;
  result: JsonValue;
  judgment: EvaluationResponse;
}

export class JudgmentService {
  private active = 0;
  private readonly queue: Array<{ enter: () => void; cancel: () => void }> = [];

  constructor(private readonly options: {
    config: Config;
    provider: () => EvaluationProvider;
    store: () => RunStore;
  }) {}

  recipes() { return listRecipes(); }

  plan(recipeId: string, input: unknown): Plan {
    const recipe = getRecipe(recipeId);
    const parsed = recipe.inputSchema.safeParse(input);
    if (!parsed.success) {
      throw new JevError("INVALID_INPUT", "Input does not match the recipe schema; inspect recipes or the matching example JSON.");
    }
    const { state, questions } = recipe.prepare(parsed.data);
    const request = { model: this.options.config.model, state, questions };
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > 1024 * 1024) {
      throw new JevError("INVALID_INPUT", "Prepared request exceeds the local 1 MiB limit; provide smaller excerpts.");
    }
    return { recipeId: recipe.id, recipeVersion: recipe.version, request };
  }

  async run(recipeId: string, input: unknown, signal?: AbortSignal): Promise<RunResult> {
    if (signal?.aborted) throw this.cancelled();
    const plan = this.plan(recipeId, input);
    await this.acquire(signal);
    try {
      // Cancelled/overflowed waiters never construct local dependencies or call the API.
      if (signal?.aborted) throw this.cancelled();
      const provider = this.options.provider();
      const store = this.options.store();
      const started = performance.now();
      const record: RunRecord = {
        id: randomUUID(), recipeId: plan.recipeId, recipeVersion: plan.recipeVersion,
        requestedModel: plan.request.model, actualModel: null,
        startedAt: new Date().toISOString(), durationMs: 0, status: "error",
        questionCount: Object.keys(plan.request.questions).length,
        inputTokens: null, outputTokens: null, requestId: null, errorCode: null,
      };
      let response: EvaluationResponse;
      let result: JsonValue;
      try {
        response = await provider.evaluate(plan.request, signal);
        if (signal?.aborted) throw this.cancelled();
        record.actualModel = response.model;
        record.inputTokens = response.usage.input_tokens;
        record.outputTokens = response.usage.output_tokens;
        record.requestId = response.requestId;
        result = getRecipe(recipeId).interpret(input, response);
      } catch (error) {
        const safe = safeError(error);
        record.durationMs = Math.round(performance.now() - started);
        record.errorCode = safe.code;
        store.recordRun(record);
        throw new JevError(safe.code, safe.message);
      }
      record.status = "success";
      record.durationMs = Math.round(performance.now() - started);
      // A storage failure after inference must be visible, never retried as inference.
      store.recordRun(record);
      return { run: record, result, judgment: response };
    } finally {
      this.release();
    }
  }

  private cancelled(): JevError {
    return new JevError("TIMEOUT", "Evaluation was cancelled.");
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw this.cancelled();
    if (this.active < 4) { this.active++; return; }
    if (this.queue.length >= 64) throw new JevError("RATE_LIMIT", "Local inference queue is full; retry later.");
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        enter: () => { signal?.removeEventListener("abort", waiter.cancel); resolve(); },
        cancel: () => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) this.queue.splice(index, 1);
          signal?.removeEventListener("abort", waiter.cancel);
          reject(this.cancelled());
        },
      };
      this.queue.push(waiter);
      signal?.addEventListener("abort", waiter.cancel, { once: true });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next.enter();
    else this.active--;
  }
}
