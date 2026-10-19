import assert from "node:assert/strict";
import test from "node:test";
import type { Answer, EvaluationResponse, JsonValue, Recipe } from "../src/core/contracts.js";
import { JevError } from "../src/core/errors.js";
import { getRecipe, listRecipes } from "../src/recipes/index.js";
import { rubric as rankRubric, thresholds as rankThresholds } from "../src/recipes/rank-candidates.js";
import { thresholds as verifyThresholds } from "../src/recipes/verify-claims.js";
import { thresholds as triageThresholds } from "../src/recipes/triage-failure.js";

function response(answers: Record<string, Answer>): EvaluationResponse {
  return { model: "synthetic-model", answers, usage: { input_tokens: null, output_tokens: null }, requestId: null };
}

function scoreAnswer(values: number[]): Extract<Answer, { type: "score" }> {
  const probabilities = Object.fromEntries(values.map((probability, index) => [String(index), probability]));
  return {
    type: "score",
    score: values.reduce((sum, probability, index) => sum + probability * index, 0),
    legend: Object.fromEntries(rankRubric.map((label, index) => [String(index), label])),
    probabilities,
    confidence: Math.max(...values),
  };
}

function choiceAnswer(choice: string, confidence: number, labels: string[]): Extract<Answer, { type: "choice" }> {
  return { type: "choice", choice, confidence,
    probabilities: Object.fromEntries(labels.map((label) => [label, label === choice ? confidence : (1 - confidence) / (labels.length - 1)])) };
}

const claimLabels = ["supported", "contradicted", "insufficient"];
const categoryLabels = ["regression", "environment", "dependency", "flaky", "unknown"];
const rankInput = {
  task: "Find the instructions for offline checks.",
  candidates: [
    { id: "first", title: "First", content: "Some instructions." },
    { id: "second", title: "Second", content: "The complete instructions." },
    { id: "third", title: "Third", content: "Some other instructions." },
  ],
};

function result<T>(value: JsonValue): T {
  return value as unknown as T;
}

function invalidInput(recipe: Recipe, input: unknown): void {
  assert.throws(() => recipe.prepare(input), (error: unknown) => error instanceof JevError && error.code === "INVALID_INPUT");
}

test("registry exposes exactly three versioned recipes and rejects unknown ids", () => {
  assert.deepEqual(listRecipes().map((recipe) => [recipe.id, recipe.version]), [
    ["rank-candidates", "1.2.0"], ["verify-claims", "1.0.0"], ["triage-failure", "1.0.0"],
  ]);
  assert.throws(() => getRecipe("made-up-recipe"), (error: unknown) => error instanceof JevError && error.code === "INVALID_INPUT");
});

test("rank uses a shared rubric, one state, stable ordering, and retains uncertain candidates and original judgments", () => {
  const recipe = getRecipe("rank-candidates");
  const prepared = recipe.prepare(rankInput);
  assert.deepEqual(prepared.state, rankInput);
  assert.equal(Object.keys(prepared.questions).length, 3);
  for (const question of Object.values(prepared.questions)) {
    assert.equal(question.type, "score");
    assert.deepEqual(question.criteria, rankRubric);
    assert.match(String(question.instructions), /Do not reduce relevance merely because code is buggy or the material is a partial fragment/);
  }
  const lowConfidence = scoreAnswer([0.2, 0.2, 0.2, 0.2, 0.2]);
  const topScore = scoreAnswer([0, 0, 0, 0, 1]);
  const tieScore = scoreAnswer([0, 0, 1, 0, 0]);
  const output = result<{ candidates: Array<{ id: string; rank: number; score: number; requiresReview: boolean; judgment: Answer }> }>(recipe.interpret(rankInput,
    response({ candidate_0: lowConfidence, candidate_1: topScore, candidate_2: tieScore })));
  assert.deepEqual(output.candidates.map((candidate) => candidate.id), ["second", "first", "third"]);
  assert.deepEqual(output.candidates.map((candidate) => candidate.rank), [1, 2, 3]);
  assert.deepEqual(output.candidates.map((candidate) => candidate.score), [1, 0.5, 0.5]);
  assert.equal(output.candidates[1]?.requiresReview, true);
  assert.deepEqual(output.candidates[1]?.judgment, lowConfidence);
  assert.deepEqual(output.candidates[0]?.judgment, topScore);
});

test("rank confidence threshold is inclusive and normalized score stays in 0..1", () => {
  const recipe = getRecipe("rank-candidates");
  const input = { task: "Pick a guide.", candidates: [rankInput.candidates[0]] };
  const exact = scoreAnswer([1 - rankThresholds.minimumConfidence, 0, 0, 0, rankThresholds.minimumConfidence]);
  const output = result<{ candidates: Array<{ score: number; requiresReview: boolean }> }>(recipe.interpret(input, response({ candidate_0: exact })));
  assert.equal(output.candidates[0]?.requiresReview, false);
  assert.equal(output.candidates[0]?.score, 0.7);
  const minimum = result<{ candidates: Array<{ score: number }> }>(recipe.interpret(input, response({ candidate_0: scoreAnswer([1, 0, 0, 0, 0]) })));
  assert.equal(minimum.candidates[0]?.score, 0);
});

test("rank rejects duplicate/blank ids, extra properties, oversized text and empty/oversized lists", () => {
  const recipe = getRecipe("rank-candidates");
  const candidate = { id: "example", title: "Guide", content: "Run the check." };
  invalidInput(recipe, { task: "Task", candidates: [candidate, { ...candidate, id: " example " }] });
  invalidInput(recipe, { task: "Task", candidates: [{ ...candidate, id: " " }] });
  invalidInput(recipe, { task: "Task", candidates: [{ ...candidate, ignored: true }] });
  invalidInput(recipe, { task: "Task", candidates: [{ ...candidate, content: "x".repeat(10_001) }] });
  invalidInput(recipe, { task: "Task", candidates: [] });
  invalidInput(recipe, { task: "Task", candidates: Array.from({ length: 51 }, (_, index) => ({ ...candidate, id: String(index) })) });
  assert.equal(Object.keys(recipe.prepare({ task: "Task", candidates: Array.from({ length: 50 }, (_, index) => ({ ...candidate, id: String(index) })) }).questions).length, 50);
  invalidInput(recipe, { task: "Task", candidates: Array.from({ length: 50 }, (_, index) => ({ ...candidate, id: String(index), content: "x".repeat(4_001) })) });
});

test("verify never auto-accepts insufficient, contradicted, or below-threshold judgments", () => {
  const recipe = getRecipe("verify-claims");
  const input = { claims: [
    { id: "accepted", claim: "The test passed.", evidence: "Test passed, exit code 0." },
    { id: "uncertain", claim: "The test passed.", evidence: "A partial result." },
    { id: "plan", claim: "Deployment succeeded.", evidence: "A plan says to deploy next week." },
    { id: "contradiction", claim: "No tests failed.", evidence: "2 tests failed." },
  ] };
  const accepted = choiceAnswer("supported", verifyThresholds.minimumConfidence, claimLabels);
  const output = result<{ claims: Array<{ status: string; canAutoAccept: boolean; requiresReview: boolean; judgment: Answer }> }>(recipe.interpret(input, response({
    claim_0: accepted,
    claim_1: choiceAnswer("supported", verifyThresholds.minimumConfidence - 0.001, claimLabels),
    claim_2: choiceAnswer("insufficient", 0.99, claimLabels),
    claim_3: choiceAnswer("contradicted", 0.99, claimLabels),
  })));
  assert.deepEqual(output.claims.map((claim) => claim.status), ["accepted", "review", "review", "rejected"]);
  assert.deepEqual(output.claims.map((claim) => claim.canAutoAccept), [true, false, false, false]);
  assert.deepEqual(output.claims.map((claim) => claim.requiresReview), [false, true, true, false]);
  assert.deepEqual(output.claims[0]?.judgment, accepted);
  const prepared = recipe.prepare(input);
  assert.equal(Object.keys(prepared.questions).length, 4);
  assert.deepEqual(prepared.state, input);
  assert.match(JSON.stringify(prepared.questions), /plans, predictions, commands, or requests alone/);
});

test("verify overrides a supported answer with absent evidence and preserves the original answer", () => {
  const recipe = getRecipe("verify-claims");
  const input = { claims: [{ id: "empty", claim: "The service was released.", evidence: "  " }] };
  const judgment = choiceAnswer("supported", 0.99, claimLabels);
  const output = result<{ claims: Array<{ verdict: string; status: string; canAutoAccept: boolean; reviewReason: string; judgment: Answer }> }>(recipe.interpret(input, response({ claim_0: judgment })));
  assert.equal(output.claims[0]?.verdict, "insufficient");
  assert.equal(output.claims[0]?.status, "review");
  assert.equal(output.claims[0]?.canAutoAccept, false);
  assert.equal(output.claims[0]?.reviewReason, "missing_evidence");
  assert.deepEqual(output.claims[0]?.judgment, judgment);
});

test("verify validates ids, count and evidence limits with strict fields", () => {
  const recipe = getRecipe("verify-claims");
  const claim = { id: "claim", claim: "The test passed.", evidence: "A test result." };
  invalidInput(recipe, { claims: [claim, claim] });
  invalidInput(recipe, { claims: [{ ...claim, id: "" }] });
  invalidInput(recipe, { claims: [{ ...claim, evidence: "x".repeat(20_001) }] });
  invalidInput(recipe, { claims: [claim], extra: true });
  invalidInput(recipe, { claims: [] });
  invalidInput(recipe, { claims: Array.from({ length: 51 }, (_, index) => ({ ...claim, id: String(index) })) });
  assert.equal(Object.keys(recipe.prepare({ claims: Array.from({ length: 50 }, (_, index) => ({ ...claim, id: String(index) })) }).questions).length, 50);
});

test("triage needs both confidence and evidence thresholds and retains raw judgments", () => {
  const recipe = getRecipe("triage-failure");
  const input = { command: "npm test", log: "Synthetic fixture: a package cannot be resolved." };
  const category = choiceAnswer("dependency", triageThresholds.minimumConfidence, categoryLabels);
  const evidence: Answer = { type: "noul", noul: triageThresholds.minimumEvidence };
  const output = result<{ category: string; evidenceSufficient: boolean; requiresReview: boolean; judgments: { category: Answer; evidence: Answer } }>(recipe.interpret(input, response({ category, evidence })));
  assert.equal(output.category, "dependency");
  assert.equal(output.evidenceSufficient, true);
  assert.equal(output.requiresReview, false);
  assert.deepEqual(output.judgments, { category, evidence });
  for (const answers of [
    { category, evidence: { type: "noul" as const, noul: triageThresholds.minimumEvidence - 0.001 } },
    { category: choiceAnswer("dependency", triageThresholds.minimumConfidence - 0.001, categoryLabels), evidence },
    { category: choiceAnswer("unknown", 0.99, categoryLabels), evidence },
  ]) {
    const uncertain = result<{ category: string; requiresReview: boolean }>(recipe.interpret(input, response(answers)));
    assert.equal(uncertain.category, "unknown");
    assert.equal(uncertain.requiresReview, true);
  }
  assert.deepEqual(recipe.prepare(input).state, input);
});

test("triage explicitly requires a completed unchanged rerun for flaky and blocks it when evidence is insufficient", () => {
  const recipe = getRecipe("triage-failure");
  const input = { command: "npm test", log: "One synthetic failure; no rerun occurred." };
  const prepared = recipe.prepare(input);
  assert.deepEqual(Object.values(prepared.questions).map((question) => question.type), ["choice", "noul"]);
  assert.match(JSON.stringify(prepared.questions), /unchanged code, inputs and environment/);
  assert.match(JSON.stringify(prepared.questions), /planned rerun, or a pass after a fix is not evidence of flakiness/);
  const judgment = choiceAnswer("flaky", 0.99, categoryLabels);
  const output = result<{ category: string; requiresReview: boolean; judgments: { category: Answer } }>(recipe.interpret(input,
    response({ category: judgment, evidence: { type: "noul", noul: 0.1 } })));
  assert.equal(output.category, "unknown");
  assert.equal(output.requiresReview, true);
  assert.deepEqual(output.judgments.category, judgment);
});

test("triage rejects unknown fields, empty required texts, and oversized logs", () => {
  const recipe = getRecipe("triage-failure");
  invalidInput(recipe, { command: " ", log: "Failure" });
  invalidInput(recipe, { command: "npm test", log: "" });
  invalidInput(recipe, { command: "npm test", log: "x".repeat(100_001) });
  invalidInput(recipe, { command: "npm test", log: "Failure", execute: true });
});

test("recipes reject missing/mismatched judgments and out-of-bounds response values", () => {
  const rank = getRecipe("rank-candidates");
  assert.throws(() => rank.interpret(rankInput, response({})), (error: unknown) => error instanceof JevError && error.code === "INVALID_RESPONSE");
  const oneCandidate = { task: "Task", candidates: [rankInput.candidates[0]] };
  assert.throws(() => rank.interpret(oneCandidate, response({ candidate_0: { ...scoreAnswer([0, 0, 0, 0, 1]), score: 5 } })), JevError);
  assert.throws(() => rank.interpret(oneCandidate, response({ candidate_0: { ...scoreAnswer([0, 0, 0, 0, 1]), confidence: Number.NaN } })), JevError);
  const verify = getRecipe("verify-claims");
  assert.throws(() => verify.interpret({ claims: [{ id: "a", claim: "A claim", evidence: "Evidence" }] },
    response({ claim_0: choiceAnswer("invented", 0.99, claimLabels) })), JevError);
  const triage = getRecipe("triage-failure");
  assert.throws(() => triage.interpret({ command: "npm test", log: "A failure" }, response({
    category: choiceAnswer("dependency", 0.99, categoryLabels), evidence: { type: "noul", noul: 1.1 },
  })), JevError);
});
