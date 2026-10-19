import { z } from "zod";
import type { EvaluationResponse, Question, Recipe } from "../core/contracts.js";
import { JevError } from "../core/errors.js";
import { answerOf, assertUnitInterval, parseInput, uniqueIds, untrustedInputNotice } from "./common.js";

const id = "verify-claims";
const version = "1.0.0";
const verdicts = ["supported", "contradicted", "insufficient"] as const;
type Verdict = typeof verdicts[number];

export const inputSchema = z.object({
  claims: z.array(z.object({
    id: z.string().trim().min(1).max(128),
    claim: z.string().trim().min(1).max(4_000),
    // An empty evidence field is valid input and must never be automatically accepted.
    evidence: z.string().trim().max(20_000),
  }).strict()).min(1).max(50),
}).strict()
  .refine((input) => uniqueIds(input.claims), { message: "Claim ids must be unique." })
  .refine((input) => input.claims.reduce((total, item) => total + item.claim.length + item.evidence.length, 0) <= 200_000,
    { message: "Combined text must not exceed 200,000 characters." });

type Input = z.infer<typeof inputSchema>;

export const rubric = {
  supported: "The supplied evidence directly and sufficiently supports every material part of the claim. Evidence must establish the claimed outcome; plans, predictions, commands, or requests alone do not establish execution or success.",
  contradicted: "The supplied evidence directly contradicts at least one material part of the claim.",
  insufficient: "Evidence is missing, ambiguous, irrelevant, incomplete, or only shows intent or an intermediate step. No evidence means insufficient. Do not invent facts or rely on outside knowledge.",
} as const;

// Initial heuristic; calibrate with representative labeled examples before relying on it.
export const thresholds = { minimumConfidence: 0.85 } as const;

function questions(input: Input): Record<string, Question> {
  return Object.fromEntries(input.claims.map((claim, index) => [`claim_${index}`, {
    type: "choice" as const,
    instructions: `${untrustedInputNotice} Verify only claims[${index}] (id ${JSON.stringify(claim.id)}) using its own evidence field. Do not borrow evidence from another claim. Choose insufficient whenever the evidence does not establish the entire claim.`,
    criteria: rubric,
  }]));
}

function interpret(inputValue: unknown, response: EvaluationResponse) {
  const input = parseInput(inputSchema, inputValue, id);
  return {
    recipeId: id,
    recipeVersion: version,
    thresholds,
    claims: input.claims.map((claim, index) => {
      const judgment = answerOf(response, `claim_${index}`, "choice");
      assertUnitInterval(judgment.confidence);
      if (!verdicts.includes(judgment.choice as Verdict)) {
        throw new JevError("INVALID_RESPONSE", "The evaluation response contains an unknown claim verdict.");
      }
      const hasEvidence = claim.evidence.length > 0;
      // Preserve the original answer while refusing an unsupported local acceptance.
      const verdict: Verdict = hasEvidence ? judgment.choice as Verdict : "insufficient";
      const requiresReview = !hasEvidence || verdict === "insufficient" || judgment.confidence < thresholds.minimumConfidence;
      const status = requiresReview ? "review" : verdict === "supported" ? "accepted" : "rejected";
      return {
        id: claim.id,
        verdict,
        status,
        canAutoAccept: status === "accepted",
        requiresReview,
        confidence: judgment.confidence,
        reviewReason: !hasEvidence ? "missing_evidence" : verdict === "insufficient" ? "insufficient_evidence"
          : requiresReview ? "low_confidence" : null,
        judgment,
      };
    }),
  };
}

export const verifyClaimsRecipe: Recipe = {
  id,
  version,
  description: "Check claims against their own evidence and require review for missing evidence or uncertain judgments.",
  inputSchema,
  prepare(inputValue) {
    const input = parseInput(inputSchema, inputValue, id);
    return { state: input, questions: questions(input) };
  },
  interpret,
};
