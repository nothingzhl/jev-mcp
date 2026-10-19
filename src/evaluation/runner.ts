import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EvaluationResponse } from "../core/contracts.js";
import { JevError, safeError } from "../core/errors.js";
import type { JudgmentService } from "../core/service.js";
import { validateResponse } from "../providers/validation.js";
import { emptyMetrics, metric, parseReport, type EvaluationReport } from "./report.js";
import { accumulate } from "./metrics.js";
import { identifier, modelName, version, suiteDigest, type Suite } from "./suite.js";

export const predictionsSchema = z.object({
  schemaVersion: z.literal(1), source: z.enum(["synthetic", "recorded"]),
  suiteDigest: z.string().regex(/^[a-f0-9]{64}$/), recipeVersion: version, requestedModel: modelName,
  predictions: z.array(z.object({ sampleId: identifier, response: z.object({
    model: modelName, answers: z.record(z.string(), z.unknown()),
    usage: z.object({ input_tokens: z.number().int().min(0).nullable(), output_tokens: z.number().int().min(0).nullable() }).strict(),
    requestId: z.string().max(200).nullable(),
  }).strict() }).strict()).min(1).max(1_000),
}).strict().refine(p => new Set(p.predictions.map(s => s.sampleId)).size === p.predictions.length);
export type Predictions = z.infer<typeof predictionsSchema>;

export function parsePredictions(value: unknown): Predictions {
  const parsed = predictionsSchema.safeParse(value);
  if (!parsed.success) throw new JevError("INVALID_INPUT", "Invalid prediction file; use the documented versioned response format.");
  return parsed.data;
}

function selectedCount(suite: Suite, maxSamples?: number): number {
  if (maxSamples !== undefined && (!Number.isSafeInteger(maxSamples) || maxSamples < 1 || maxSamples > 1_000)) {
    throw new JevError("INVALID_INPUT", "max-samples must be an integer between 1 and 1000.");
  }
  return Math.min(maxSamples ?? suite.samples.length, suite.samples.length);
}

function plans(suite: Suite, service: JudgmentService) {
  const plans = suite.samples.map(s => service.plan(suite.recipeId, s.input));
  if (plans.some(p => p.recipeVersion !== suite.recipeVersion)) {
    throw new JevError("INVALID_INPUT", "Suite recipeVersion does not match the installed rule; explicitly review and version the suite before reevaluating.");
  }
  return plans;
}

export function planEvaluation(suite: Suite, service: JudgmentService, maxSamples?: number) {
  const count = selectedCount(suite, maxSamples);
  const selected = plans(suite, service).slice(0, count);
  return { mode: "plan" as const, suite: suite.suite, suiteVersion: suite.suiteVersion, recipeId: suite.recipeId,
    recipeVersion: suite.recipeVersion, suiteDigest: suiteDigest(suite), sampleDigest: suiteDigest(suite, suite.samples.slice(0, count)),
    requestedModel: selected[0]!.request.model, availableSamples: suite.samples.length,
    totalSamples: count, plannedRequests: count,
    questionCount: selected.reduce((n, p) => n + Object.keys(p.request.questions).length, 0), networkCallMade: false };
}

function report(suite: Suite, service: JudgmentService, source: EvaluationReport["source"], maxSamples?: number): EvaluationReport {
  const plan = planEvaluation(suite, service, maxSamples);
  return { schemaVersion: 1, evaluatorVersion: "1.0.0", id: randomUUID(),
    suite: plan.suite, suiteVersion: plan.suiteVersion, suiteDigest: plan.suiteDigest, sampleDigest: plan.sampleDigest,
    recipeId: plan.recipeId, recipeVersion: plan.recipeVersion, requestedModel: plan.requestedModel,
    actualModels: [], source, createdAt: new Date().toISOString(), totalSamples: plan.totalSamples,
    evaluatedSamples: 0, failedSamples: 0, errors: {}, metrics: emptyMetrics(suite.recipeId) };
}

export function evaluatePredictions(suite: Suite, value: unknown, service: JudgmentService, maxSamples?: number): EvaluationReport {
  const prediction = parsePredictions(value);
  const result = report(suite, service, prediction.source, maxSamples);
  if (prediction.suiteDigest !== result.suiteDigest || prediction.recipeVersion !== result.recipeVersion
    || prediction.requestedModel !== result.requestedModel || prediction.predictions.length !== suite.samples.length) {
    throw new JevError("INVALID_INPUT", "Predictions must match the labeled suite digest, rule version, requested model and all sample IDs.");
  }
  const byId = new Map(prediction.predictions.map(p => [p.sampleId, p.response]));
  // Validate the entire prediction file before scoring or persisting anything.
  const responses = plans(suite, service).map((plan, i) => {
    const response = byId.get(suite.samples[i]!.id);
    if (!response) throw new JevError("INVALID_INPUT", "Predictions must cover each suite sample exactly once.");
    return validateResponse(response, plan.request, response.requestId ?? undefined);
  });
  for (let i = 0; i < result.totalSamples; i++) {
    const response = responses[i]!;
    accumulate(result.metrics, suite, i, response);
    result.evaluatedSamples++;
    if (!result.actualModels.includes(response.model)) result.actualModels.push(response.model);
  }
  result.actualModels.sort();
  result.metrics.errorRate = metric(0, result.totalSamples);
  return parseReport(result);
}

export async function evaluateLive(suite: Suite, service: JudgmentService,
  options: { maxSamples: number; maxRequests: number; maxRetries: number; signal?: AbortSignal }): Promise<EvaluationReport> {
  if (!Number.isSafeInteger(options.maxSamples) || options.maxSamples < 1 || options.maxSamples > 1_000) {
    throw new JevError("INVALID_INPUT", "Live evaluation requires max-samples between 1 and 1000.");
  }
  const result = report(suite, service, "live", options.maxSamples);
  if (!Number.isSafeInteger(options.maxRetries) || options.maxRetries < 0 || options.maxRetries > 3
    || !Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1 || options.maxRequests > 4_000
    || result.totalSamples * (1 + options.maxRetries) > options.maxRequests) {
    throw new JevError("INVALID_INPUT", "max-requests must cover selected samples times (1 + SDK max retries), within 1..4000.");
  }
  for (let i = 0; i < result.totalSamples; i++) {
    // Cancellation stops the suite rather than marking unattempted samples as evaluated.
    if (options.signal?.aborted) throw new JevError("TIMEOUT", "Evaluation suite was cancelled.");
    let response: EvaluationResponse;
    try {
      response = (await service.run(suite.recipeId, suite.samples[i]!.input, options.signal)).judgment;
    } catch (error) {
      const code = safeError(error).code;
      result.failedSamples++;
      result.errors[code] = (result.errors[code] ?? 0) + 1;
      continue;
    }
    accumulate(result.metrics, suite, i, response);
    result.evaluatedSamples++;
    if (!result.actualModels.includes(response.model)) result.actualModels.push(response.model);
  }
  result.actualModels.sort();
  result.metrics.errorRate = metric(result.failedSamples, result.totalSamples);
  return parseReport(result);
}
