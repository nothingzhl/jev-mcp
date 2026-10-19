import { z } from "zod";
import { JevError } from "../core/errors.js";
import { identifier, modelName, version, type RecipeId } from "./suite.js";

export const errorCodeSchema = z.enum(["INVALID_INPUT", "CONFIGURATION", "AUTHENTICATION", "RATE_LIMIT", "TIMEOUT",
  "CONNECTION", "UPSTREAM", "INVALID_RESPONSE", "STORAGE", "INTERNAL"]);
export const metricNames = {
  "rank-candidates": ["keyItemHitRate", "sampleHitRate", "reviewRate", "topKReviewRate", "errorRate"],
  "verify-claims": ["falseAcceptanceRate", "acceptanceErrorRate", "supportedAcceptanceRate", "verdictAccuracy", "reviewRate", "errorRate"],
  "triage-failure": ["categoryAccuracy", "knownCategoryAccuracy", "unknownRate", "unknownRecall", "knownCoverage", "reviewRate", "errorRate"],
} as const;
export interface Metric { numerator: number; denominator: number; rate: number | null }
export function metric(numerator: number, denominator: number): Metric {
  return { numerator, denominator, rate: denominator === 0 ? null : numerator / denominator };
}
const count = z.number().int().min(0).max(1_000_000);
const metricSchema = z.object({ numerator: count, denominator: count, rate: z.number().min(0).max(1).nullable() }).strict()
  .refine(m => m.numerator <= m.denominator && (m.denominator === 0 ? m.rate === null
    : m.rate !== null && Math.abs(m.rate - m.numerator / m.denominator) < 1e-12));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const reportSchema = z.object({
  schemaVersion: z.literal(1), evaluatorVersion: z.literal("1.0.0"), id: identifier,
  suite: identifier, suiteVersion: version, suiteDigest: digest, sampleDigest: digest,
  recipeId: z.enum(["rank-candidates", "verify-claims", "triage-failure"]), recipeVersion: version,
  requestedModel: modelName, actualModels: z.array(modelName).max(1_000),
  source: z.enum(["synthetic", "recorded", "live"]), createdAt: z.iso.datetime(),
  totalSamples: count, evaluatedSamples: count, failedSamples: count,
  metrics: z.record(z.string(), metricSchema), errors: z.partialRecord(errorCodeSchema, count),
}).strict().refine(report => {
  const names: readonly string[] = metricNames[report.recipeId];
  return report.totalSamples > 0 && report.totalSamples <= 1_000
    && report.evaluatedSamples + report.failedSamples === report.totalSamples
    && Object.values(report.errors).reduce((sum, value) => sum + value, 0) === report.failedSamples
    && new Set(report.actualModels).size === report.actualModels.length
    && (report.evaluatedSamples === 0 ? report.actualModels.length === 0 : report.actualModels.length > 0)
    && report.actualModels.length <= report.evaluatedSamples
    && Object.keys(report.metrics).length === names.length && names.every(name => Object.hasOwn(report.metrics, name))
    && report.metrics.errorRate?.numerator === report.failedSamples
    && report.metrics.errorRate?.denominator === report.totalSamples;
});
export type EvaluationReport = z.infer<typeof reportSchema>;

export interface EvaluationReportStore {
  recordReport(report: EvaluationReport): void;
  listReports(limit?: number): EvaluationReport[];
}

export function parseReport(value: unknown): EvaluationReport {
  const result = reportSchema.safeParse(value);
  if (!result.success) throw new JevError("INVALID_INPUT", "Invalid evaluation report; check versions, counts and metric denominators.");
  return result.data;
}

export function compareReports(leftValue: unknown, rightValue: unknown) {
  const left = parseReport(leftValue);
  const right = parseReport(rightValue);
  if (left.recipeId !== right.recipeId || left.suite !== right.suite || left.suiteVersion !== right.suiteVersion
    || left.suiteDigest !== right.suiteDigest || left.sampleDigest !== right.sampleDigest
    || left.totalSamples !== right.totalSamples || left.evaluatorVersion !== right.evaluatorVersion
    || (left.source === "synthetic") !== (right.source === "synthetic")) {
    throw new JevError("INVALID_INPUT", "Comparison requires the same labeled suite, selected samples and evaluator version; synthetic and non-synthetic reports cannot be mixed.");
  }
  return { left, right, metrics: Object.fromEntries(metricNames[left.recipeId].map(name => {
    const a = left.metrics[name]!;
    const b = right.metrics[name]!;
    return [name, { left: a, right: b, rateDelta: a.rate === null || b.rate === null ? null : b.rate - a.rate }];
  })) };
}

export function emptyMetrics(recipeId: RecipeId): Record<string, Metric> {
  return Object.fromEntries(metricNames[recipeId].map(name => [name, metric(0, 0)]));
}
