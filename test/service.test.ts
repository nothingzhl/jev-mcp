import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../src/config.js";
import type { EvaluationProvider, EvaluationRequest, EvaluationResponse, RunRecord, RunStore } from "../src/core/contracts.js";
import { JevError } from "../src/core/errors.js";
import { JudgmentService } from "../src/core/service.js";

const input = { task: "find token validation", candidates: [{ id: "a", title: "session.ts", content: "validateToken(token)" }] };
const config = readConfig({ JEV_DB_PATH: ":memory:" });
function response(request: EvaluationRequest): EvaluationResponse {
  return { model: "jev-test-fixed", requestId: "request-test", usage: { input_tokens: 12, output_tokens: null },
    answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      assert.equal(question.type, "score");
      if (question.type !== "score") throw new Error("unexpected question");
      return [id, { type: "score", score: 4, confidence: 0.9,
        legend: Object.fromEntries(question.criteria.map((level, i) => [String(i), level])),
        probabilities: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 1 } }];
    })) };
}
function memoryStore(records: RunRecord[]): RunStore {
  return { recordRun(record) { records.push({ ...record }); }, listRuns: () => records,
    recordEvaluation() {}, listEvaluations: () => [], close() {} };
}

test("dry run validates and batches without constructing provider or store", () => {
  const service = new JudgmentService({ config, provider() { throw new Error("network"); }, store() { throw new Error("storage"); } });
  const plan = service.plan("rank-candidates", { ...input, candidates: [...input.candidates, { id: "b", title: "b", content: "b" }] });
  assert.deepEqual(Object.keys(plan.request).sort(), ["model", "questions", "state"]);
  assert.equal(Object.keys(plan.request.questions).length, 2);
  assert.throws(() => service.plan("missing", input), { code: "INVALID_INPUT" });
  assert.throws(() => service.plan("rank-candidates", { ...input, secret: "not a valid field" }), { code: "INVALID_INPUT" });
});

test("live service composes one batch and persists only metadata", async () => {
  const records: RunRecord[] = [];
  let calls = 0;
  const service = new JudgmentService({ config, store: () => memoryStore(records),
    provider: () => ({ async evaluate(request) { calls++; return response(request); } }) });
  const result = await service.run("rank-candidates", input);
  assert.equal(calls, 1);
  assert.equal(result.run.status, "success");
  assert.equal(result.run.actualModel, "jev-test-fixed");
  assert.equal(result.run.outputTokens, null);
  assert.equal(result.run.requestId, "request-test");
  assert.equal(records.length, 1);
  assert.equal(JSON.stringify(records).includes("validateToken"), false);
  assert.equal(JSON.stringify(records).includes("answers"), false);
});

test("failure is recorded safely without application retries", async () => {
  const records: RunRecord[] = [];
  let calls = 0;
  const service = new JudgmentService({ config, store: () => memoryStore(records),
    provider: () => ({ async evaluate() { calls++; throw new Error("synthetic-secret-code-and-key"); } }) });
  await assert.rejects(service.run("rank-candidates", input), { code: "INTERNAL" });
  assert.equal(calls, 1);
  assert.equal(records[0]?.status, "error");
  assert.equal(records[0]?.errorCode, "INTERNAL");
  assert.equal(JSON.stringify(records).includes("synthetic-secret"), false);
});

test("storage failure after inference does not rerun the model", async () => {
  let calls = 0;
  const service = new JudgmentService({ config, store: () => ({ ...memoryStore([]), recordRun() { throw new JevError("STORAGE", "Metadata unavailable."); } }),
    provider: () => ({ async evaluate(request) { calls++; return response(request); } }) });
  await assert.rejects(service.run("rank-candidates", input), { code: "STORAGE" });
  assert.equal(calls, 1);
});

test("service limits concurrent inference to four", async () => {
  let active = 0;
  let max = 0;
  const provider: EvaluationProvider = { async evaluate(request) {
    active++; max = Math.max(max, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return response(request);
  } };
  const service = new JudgmentService({ config, provider: () => provider, store: () => memoryStore([]) });
  await Promise.all(Array.from({ length: 9 }, () => service.run("rank-candidates", input)));
  assert.equal(max, 4);
});

test("configuration rejects invalid retry/deadline budgets", () => {
  for (const env of [{ JEV_TIMEOUT_MS: "0" }, { JEV_MAX_RETRIES: "4" }, { JEV_MAX_RETRIES: "NaN" }, { JEV_MODEL: "" }]) {
    assert.throws(() => readConfig(env), { code: "CONFIGURATION" });
  }
});
