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
  private readonly queue: Array<() => void> = [];

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
    const plan = this.plan(recipeId, input);
    // Resolve local dependencies before spending any API tokens.
    const store = this.options.store();
    const provider = this.options.provider();
    await this.acquire();
    const started = performance.now();
    const record: RunRecord = {
      id: randomUUID(), recipeId: plan.recipeId, recipeVersion: plan.recipeVersion,
      requestedModel: plan.request.model, actualModel: null,
      startedAt: new Date().toISOString(), durationMs: 0, status: "error",
      questionCount: Object.keys(plan.request.questions).length,
      inputTokens: null, outputTokens: null, requestId: null, errorCode: null,
    };
    try {
      let response: EvaluationResponse;
      let result: JsonValue;
      try {
        response = await provider.evaluate(plan.request, signal);
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

  private async acquire(): Promise<void> {
    if (this.active < 4) { this.active++; return; }
    if (this.queue.length >= 64) throw new JevError("RATE_LIMIT", "Local inference queue is full; retry later.");
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
}
