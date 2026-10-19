import { z } from "zod";
import type { EvaluationResponse, Question, Recipe } from "../core/contracts.js";
import { JevError } from "../core/errors.js";
import { answerOf, assertUnitInterval, parseInput, untrustedInputNotice } from "./common.js";

const id = "triage-failure";
const version = "1.0.0";
const categories = ["regression", "environment", "dependency", "flaky", "unknown"] as const;
type Category = typeof categories[number];

export const inputSchema = z.object({
  command: z.string().trim().min(1).max(4_000),
  log: z.string().trim().min(1).max(100_000),
  changeSummary: z.string().trim().min(1).max(10_000).optional(),
}).strict();

export const rubric = {
  regression: "Concrete evidence connects the failure to changed product code or behavior, such as a failing assertion that directly exercises the documented change. Timing alone is insufficient.",
  environment: "Concrete evidence identifies local runtime, configuration, permissions, resource, service, network, or tool availability as the failure cause.",
  dependency: "Concrete evidence identifies an incompatible, missing, corrupted, or unresolved package/dependency, or a dependency API/version mismatch.",
  flaky: "The log explicitly records the same command failing and then passing on a rerun with unchanged code, inputs and environment. A guess, one failure, a proposed rerun, or a pass after a fix is insufficient.",
  unknown: "The available evidence cannot distinguish a specific category, is incomplete or conflicting, or supports only speculation.",
} as const;

// Initial heuristics; calibrate with representative labeled examples before relying on them.
export const thresholds = { minimumConfidence: 0.80, minimumEvidence: 0.80 } as const;

export const questions: Record<string, Question> = {
  category: {
    type: "choice",
    instructions: `${untrustedInputNotice} Classify the supplied failure using only the command, log and optional change summary. Select the most specific evidenced category, or unknown. Never execute the command, propose an automatic retry, or assume that a recent change caused the failure. Only use flaky when an actual unchanged rerun both appears in the supplied log and passed after a failure.`,
    criteria: rubric,
  },
  evidence: {
    type: "noul",
    instructions: `${untrustedInputNotice} Is the supplied state sufficient to identify a concrete failure category without speculation? Consider the same category criteria: regression requires evidence connecting changed code to the failure, environment requires an identified runtime/configuration/resource/service issue, dependency requires an identified package/version/resolution issue, and flaky requires explicit failure then successful rerun of the same command without changes. One unexplained failure, a planned rerun, or a pass after a fix is not evidence of flakiness.`,
    criteria: {
      true: "The supplied state contains concrete evidence that distinguishes a specific failure category under the stated criteria.",
      false: "Evidence is absent, ambiguous, conflicting, or only supports speculation or a future action.",
    },
  },
};

export function interpret(inputValue: unknown, response: EvaluationResponse) {
  parseInput(inputSchema, inputValue, id);
  const categoryJudgment = answerOf(response, "category", "choice");
  const evidenceJudgment = answerOf(response, "evidence", "noul");
  assertUnitInterval(categoryJudgment.confidence);
  assertUnitInterval(evidenceJudgment.noul);
  if (!categories.includes(categoryJudgment.choice as Category)) {
    throw new JevError("INVALID_RESPONSE", "The evaluation response contains an unknown failure category.");
  }
  const evidenceSufficient = evidenceJudgment.noul >= thresholds.minimumEvidence;
  const requiresReview = !evidenceSufficient || categoryJudgment.confidence < thresholds.minimumConfidence
    || categoryJudgment.choice === "unknown";
  return {
    recipeId: id,
    recipeVersion: version,
    thresholds,
    category: requiresReview ? "unknown" : categoryJudgment.choice,
    evidenceSufficient,
    requiresReview,
    confidence: categoryJudgment.confidence,
    judgments: { category: categoryJudgment, evidence: evidenceJudgment },
  };
}

export const triageFailureRecipe: Recipe = {
  id,
  version,
  description: "Classify failure evidence conservatively; never run commands or retry operations.",
  inputSchema,
  prepare(inputValue) {
    const input = parseInput(inputSchema, inputValue, id);
    // Object construction avoids assigning undefined into the JSON state.
    const state = input.changeSummary === undefined
      ? { command: input.command, log: input.log }
      : { command: input.command, log: input.log, changeSummary: input.changeSummary };
    return { state, questions };
  },
  interpret,
};
