import assert from "node:assert/strict";
import test from "node:test";
import type { Answer, EvaluationRequest } from "../src/core/contracts.js";
import { validateResponse } from "../src/providers/validation.js";
import { interpret, rankCandidatesRecipe, rubric } from "../src/recipes/rank-candidates.js";

function raw(score: number, values: number[], confidence = 1) {
  return { type: "score", score, confidence,
    legend: Object.fromEntries(rubric.map((description, i) => [String(i), description])),
    probabilities: Object.fromEntries(values.map((value, i) => [String(i), value])) };
}
function validate(value: unknown) {
  const request: EvaluationRequest = { model: "synthetic", state: "offline precision regression",
    questions: { candidate_0: { type: "score", instructions: "Synthetic relevance", criteria: [...rubric] } } };
  return validateResponse({ model: "synthetic", answers: { candidate_0: value },
    usage: { input_tokens: null, output_tokens: null } }, request, undefined);
}
function scoreAnswer(value: unknown) {
  const answer = validate(value).answers.candidate_0!;
  assert.equal(answer.type, "score");
  return answer as Extract<Answer, { type: "score" }>;
}

test("four recorded Score deviations receive recomputed rounding metadata and mandatory review", () => {
  // Numeric evidence: docs/evaluation-results/2026-10-19-jev-1.13.0/response-issues.json.
  const cases: Array<[number, number[]]> = [
    [.69, [.42, .50, .07, .01, 0]], [3.94, [0, 0, 0, .04, .96]],
    [.28, [.76, .22, .02, 0, 0]], [3.89, [0, 0, .01, .07, .92]],
  ];
  for (const [score, probabilities] of cases) {
    const source = raw(score, probabilities);
    const response = validate({ ...source, consistency: { requiresReview: false, policy: "trusted" } });
    const judgment = response.answers.candidate_0!;
    assert.equal(judgment.type, "score");
    if (judgment.type !== "score") throw new Error("Wrong primitive");
    assert.deepEqual({ ...judgment, consistency: undefined }, { ...source, consistency: undefined });
    assert.equal(judgment.consistency?.policy, "rounded-2dp");
    assert.equal(judgment.consistency?.requiresReview, true);
    assert.ok(judgment.consistency!.minimumExpectation <= score + .005 + 1e-12);
    assert.ok(judgment.consistency!.maximumExpectation >= score - .005 - 1e-12);
    assert.deepEqual(validate(judgment).answers.candidate_0, judgment); // Replay is idempotent.
    const output = interpret({ task: "Synthetic task", candidates: [{ id: "a", title: "A", content: "Synthetic material" }] }, response);
    assert.equal(output.recipeVersion, "1.1.0");
    assert.equal(output.candidates[0]!.score, score / 4);
    assert.equal(output.candidates[0]!.requiresReview, true); // Even confidence=1.
    assert.equal(output.candidates[0]!.reviewReason, "score_rounding");
  }
});

test("rounding feasibility respects total probability mass and zero/one clipping", () => {
  const edge = scoreAnswer(raw(.02, [1, 0, 0, 0, 0]));
  assert.equal(edge.consistency?.minimumExpectation, 0);
  assert.ok(Math.abs(edge.consistency!.maximumExpectation - .02) < 1e-12);
  // Independent intervals without sum(q)=1 would incorrectly permit .03.
  for (const source of [raw(.03, [1, 0, 0, 0, 0]), raw(3.97, [0, 0, 0, 0, 1]),
    raw(1.98, [0, 0, 1, 0, 0]), raw(2.02, [0, 0, 1, 0, 0]),
    raw(.28, [.7601, .2199, .02, 0, 0]), raw(.2801, [.76, .22, .02, 0, 0])]) {
    assert.throws(() => validate({ ...source, consistency: { requiresReview: false } }), { code: "INVALID_RESPONSE" });
  }
});

test("strict Score responses discard forged metadata and preserve stable ranking and low-confidence review", () => {
  const input = { task: "Synthetic task", candidates: ["a", "b", "c"].map(id => ({ id, title: id, content: "Synthetic" })) };
  const prepared = rankCandidatesRecipe.prepare(input);
  const strict = raw(3.92, [0, 0, 0, .08, .92]);
  const compatible = raw(3.94, [0, 0, 0, .04, .96]);
  const response = validateResponse({ model: "synthetic", usage: { input_tokens: null, output_tokens: null }, answers: {
    candidate_0: { ...strict, consistency: { policy: "rounded-2dp", requiresReview: true } },
    candidate_1: compatible, candidate_2: { ...compatible, confidence: .1 },
  } }, { ...prepared, model: "synthetic" }, undefined);
  assert.deepEqual(response.answers.candidate_0, strict);
  const output = interpret(input, response);
  assert.deepEqual(output.candidates.map(c => c.id), ["b", "c", "a"]);
  assert.deepEqual(output.candidates.map(c => c.requiresReview), [true, true, false]);
  assert.deepEqual(output.candidates.map(c => c.judgment.score), [3.94, 3.94, 3.92]);
  const low = interpret({ ...input, candidates: [input.candidates[0]!] }, validate({ ...strict, confidence: .1 }));
  assert.equal(low.candidates[0]!.reviewReason, "low_confidence");
});
