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

test("pre-aborted and just-granted cancellation never initializes dependencies and does not leak permits", async () => {
  let calls = 0;
  const service = new JudgmentService({ config, store: () => memoryStore([]),
    provider: () => { calls++; return { async evaluate(request) { return response(request); } }; } });
  const aborted = new AbortController();
  aborted.abort(new Error("private-abort-reason"));
  await assert.rejects(service.run("rank-candidates", input, aborted.signal), { code: "TIMEOUT", message: "Evaluation was cancelled." });
  const granted = new AbortController();
  const run = service.run("rank-candidates", input, granted.signal);
  granted.abort();
  await assert.rejects(run, { code: "TIMEOUT" });
  assert.equal(calls, 0);
  await Promise.all(Array.from({ length: 4 }, () => service.run("rank-candidates", input)));
  assert.equal(calls, 4);
});

test("full queue cancels immediately, frees capacity and preserves a surviving waiter", { timeout: 3_000 }, async () => {
  const records: RunRecord[] = [];
  const finish: Array<() => void> = [];
  let started!: () => void;
  const saturated = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const service = new JudgmentService({ config, store: () => memoryStore(records),
    provider: () => ({ async evaluate(request) {
      calls++;
      if (calls <= 4) await new Promise<void>(resolve => { finish.push(resolve); if (finish.length === 4) started(); });
      return response(request);
    } }) });
  const running = Array.from({ length: 4 }, () => service.run("rank-candidates", input));
  await saturated;
  const controllers = Array.from({ length: 64 }, () => new AbortController());
  const pending = controllers.map(c => service.run("rank-candidates", input, c.signal));
  const settled = Promise.allSettled(pending); // Handle rejection before delivering cancellation.
  await assert.rejects(service.run("rank-candidates", input), { code: "RATE_LIMIT" });
  controllers[0]!.abort(new Error("do not retain this reason"));
  await assert.rejects(pending[0]!, { code: "TIMEOUT" }); // No running work has completed.
  const survivor = service.run("rank-candidates", input);
  for (const controller of controllers) controller.abort();
  assert.equal((await settled).filter(r => r.status === "rejected").length, 64);
  assert.equal(calls, 4);
  for (const resolve of finish) resolve();
  await Promise.all([...running, survivor]);
  assert.equal(calls, 5);
  assert.equal(records.length, 5);
});

test("active cancellation is forwarded and recorded safely; dependency failure releases capacity", { timeout: 3_000 }, async () => {
  const controller = new AbortController();
  const records: RunRecord[] = [];
  const service = new JudgmentService({ config, store: () => memoryStore(records), provider: () => ({
    async evaluate(request, signal) {
      assert.equal(signal, controller.signal);
      controller.abort(new Error("private-reason"));
      return response(request); // A provider ignoring cancellation still cannot produce success.
    },
  }) });
  await assert.rejects(service.run("rank-candidates", input, controller.signal), { code: "TIMEOUT" });
  assert.equal(records[0]?.status, "error");
  assert.equal(records[0]?.errorCode, "TIMEOUT");
  assert.equal(JSON.stringify(records).includes("private-reason"), false);
  let fail = true;
  const recover = new JudgmentService({ config, store: () => memoryStore([]), provider: () => {
    if (fail) throw new JevError("AUTHENTICATION", "Missing key.");
    return { async evaluate(request) { return response(request); } };
  } });
  await Promise.all(Array.from({ length: 8 }, () => assert.rejects(recover.run("rank-candidates", input), { code: "AUTHENTICATION" })));
  fail = false;
  await Promise.all(Array.from({ length: 5 }, () => recover.run("rank-candidates", input)));
});
