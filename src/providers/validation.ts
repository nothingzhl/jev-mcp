import { isDeepStrictEqual } from "node:util";
import type { Answer, Content, EvaluationRequest, EvaluationResponse, Question, ScoreConsistency } from "../core/contracts.js";
import { JevError } from "../core/errors.js";

const invalid = (): never => {
  throw new JevError("INVALID_RESPONSE", "TypeSafe returned an invalid evaluation response.");
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function sameKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) invalid();
}

function probability(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return invalid();
  return value;
}

function distribution(value: unknown, keys: string[]): Record<string, number> {
  const probabilities = record(value);
  sameKeys(probabilities, keys);
  const entries = keys.map((key) => [key, probability(probabilities[key])] as const);
  // The API may round decimal probabilities; accept only a small rounding difference.
  if (Math.abs(entries.reduce((total, [, p]) => total + p, 0) - 1) > 0.001) invalid();
  return Object.fromEntries(entries);
}

function roundedScoreConsistency(score: number, probabilities: number[], expected: number): ScoreConsistency {
  const epsilon = 1e-12;
  // This is a local compatibility profile, not an API precision contract. Only
  // cent-grid values qualify; extra precision must satisfy the original check.
  if ([score, ...probabilities].some(value => Math.abs(value - Math.round(value * 100) / 100) > epsilon)) invalid();
  const lower = probabilities.map(p => Math.max(0, p - 0.005));
  const upper = probabilities.map(p => Math.min(1, p + 0.005));
  const remaining = 1 - lower.reduce((sum, p) => sum + p, 0);
  if (remaining < -epsilon || upper.reduce((sum, p) => sum + p, 0) < 1 - epsilon) invalid();
  // Tight extrema under sum(q)=1: fill each probability interval from lowest
  // level upward for the minimum, and highest downward for the maximum.
  const extremum = (descending: boolean) => {
    let mass = Math.max(0, remaining);
    let value = lower.reduce((sum, p, level) => sum + level * p, 0);
    for (let i = 0; i < lower.length; i++) {
      const level = descending ? lower.length - 1 - i : i;
      const added = Math.min(mass, upper[level]! - lower[level]!);
      value += level * added;
      mass = Math.max(0, mass - added);
    }
    if (mass > epsilon) invalid();
    return value;
  };
  const minimumExpectation = extremum(false);
  const maximumExpectation = extremum(true);
  if (score + 0.005 < minimumExpectation - epsilon || score - 0.005 > maximumExpectation + epsilon) invalid();
  return { policy: "rounded-2dp", requiresReview: true, reportedExpectation: expected,
    minimumExpectation, maximumExpectation };
}

function answer(value: unknown, question: Question): Answer {
  const result = record(value);
  if (result.type !== question.type) return invalid();
  if (question.type === "noul") return { type: "noul", noul: probability(result.noul) };

  const confidence = probability(result.confidence);
  if (question.type === "choice") {
    const keys = Object.keys(question.criteria);
    const probabilities = distribution(result.probabilities, keys);
    const choice = result.choice;
    if (typeof choice !== "string" || !Object.hasOwn(probabilities, choice)) return invalid();
    const chosen = probabilities[choice]!;
    if (Object.values(probabilities).some((p) => p > chosen + 0.001)) return invalid();
    return { type: "choice", choice, probabilities, confidence };
  }

  const keys = question.criteria.map((_, index) => String(index));
  const probabilities = distribution(result.probabilities, keys);
  const sourceLegend = record(result.legend);
  sameKeys(sourceLegend, keys);
  const legend = Object.fromEntries(keys.map((key, index) => {
    if (!isDeepStrictEqual(sourceLegend[key], question.criteria[index])) invalid();
    return [key, question.criteria[index]!] as const;
  })) as Record<string, Content>;
  const score = result.score;
  const topLevel = question.criteria.length - 1;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > topLevel) return invalid();
  const expected = keys.reduce((total, key) => total + Number(key) * probabilities[key]!, 0);
  // Keep the inclusive 0.01 rounding tolerance despite binary floating-point
  // subtraction (e.g. 3.91 - 3.92 is -0.010000000000000231).
  const consistency = Math.abs(score - expected) > 0.01 + 1e-12
    ? roundedScoreConsistency(score, keys.map(key => probabilities[key]!), expected) : undefined;
  // Recompute local metadata; never trust annotations supplied in the response.
  return { type: "score", score, legend, probabilities, confidence, ...(consistency ? { consistency } : {}) };
}

function tokenCount(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}

export function validateResponse(
  value: unknown,
  request: EvaluationRequest,
  requestId: string | undefined,
): EvaluationResponse {
  const result = record(value);
  if (typeof result.model !== "string" || !result.model.trim()) return invalid();
  const sourceAnswers = record(result.answers);
  const keys = Object.keys(request.questions);
  sameKeys(sourceAnswers, keys);
  const answers = Object.fromEntries(keys.map((key) => [key, answer(sourceAnswers[key], request.questions[key]!)]));
  const usage = record(result.usage);
  return {
    model: result.model,
    answers,
    usage: { input_tokens: tokenCount(usage.input_tokens), output_tokens: tokenCount(usage.output_tokens) },
    requestId: requestId ?? null,
  };
}
