import type { EvaluationResponse } from "../core/contracts.js";
import { interpret as rank } from "../recipes/rank-candidates.js";
import { interpret as verify } from "../recipes/verify-claims.js";
import { interpret as triage } from "../recipes/triage-failure.js";
import { metric, type Metric } from "./report.js";
import type { Suite } from "./suite.js";

/** Score the same conservative local decisions the CLI/MCP expose. */
export function accumulate(metrics: Record<string, Metric>, suite: Suite, index: number, response: EvaluationResponse): void {
  const add = (name: string, numerator: number, denominator: number) => {
    const old = metrics[name]!;
    metrics[name] = metric(old.numerator + numerator, old.denominator + denominator);
  };
  switch (suite.recipeId) {
    case "rank-candidates": {
      const sample = suite.samples[index]!;
      const result = rank(sample.input, response);
      const top = result.candidates.slice(0, sample.expected.topK);
      const hits = sample.expected.keyIds.filter(id => top.some(c => c.id === id)).length;
      add("keyItemHitRate", hits, sample.expected.keyIds.length);
      add("sampleHitRate", Number(hits > 0), 1);
      add("reviewRate", result.candidates.filter(c => c.requiresReview).length, result.candidates.length);
      add("topKReviewRate", top.filter(c => c.requiresReview).length, top.length);
      break;
    }
    case "verify-claims": {
      const sample = suite.samples[index]!;
      const result = verify(sample.input, response);
      for (const claim of result.claims) {
        const expected = sample.expected.claims.find(c => c.id === claim.id)!.verdict;
        const supported = expected === "supported";
        const accepted = claim.canAutoAccept;
        add("falseAcceptanceRate", Number(!supported && accepted), Number(!supported));
        add("acceptanceErrorRate", Number(!supported && accepted), Number(accepted));
        add("supportedAcceptanceRate", Number(supported && accepted), Number(supported));
        add("verdictAccuracy", Number(claim.verdict === expected), 1);
        add("reviewRate", Number(claim.requiresReview), 1);
      }
      break;
    }
    case "triage-failure": {
      const sample = suite.samples[index]!;
      const result = triage(sample.input, response);
      const expectedUnknown = sample.expected.category === "unknown";
      const unknown = result.category === "unknown";
      const correct = result.category === sample.expected.category;
      add("categoryAccuracy", Number(correct), 1);
      add("knownCategoryAccuracy", Number(!expectedUnknown && correct), Number(!expectedUnknown));
      add("unknownRate", Number(unknown), 1);
      add("unknownRecall", Number(expectedUnknown && unknown), Number(expectedUnknown));
      add("knownCoverage", Number(!expectedUnknown && !unknown), Number(!expectedUnknown));
      add("reviewRate", Number(result.requiresReview), 1);
      break;
    }
  }
}
