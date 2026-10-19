import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readConfig } from "../src/config.js";
import type { EvaluationResponse, RunStore } from "../src/core/contracts.js";
import { JudgmentService } from "../src/core/service.js";
import { JevError } from "../src/core/errors.js";
import { parseSuite, parseSuiteText, suiteDigest } from "../src/evaluation/suite.js";
import { compareReports, metric, parseReport } from "../src/evaluation/report.js";
import { evaluateLive, evaluatePredictions, parsePredictions, planEvaluation } from "../src/evaluation/runner.js";

const directory = new URL("../examples/evaluation/", import.meta.url);
export function fixture(name: string) { return JSON.parse(readFileSync(new URL(name, directory), "utf8")) as unknown; }
export function suite(name: string) { return parseSuiteText(readFileSync(new URL(name, directory), "utf8")); }
function offline(model = "synthetic-a") {
  return new JudgmentService({ config: readConfig({ JEV_MODEL: model }),
    provider() { throw new Error("must not construct a provider"); }, store() { throw new Error("must not open SQLite"); } });
}

test("all 36 captured benchmark responses replay offline with conservative Score review and unchanged other metrics", () => {
  const results = new URL("../docs/evaluation-results/2026-10-19-score-compatibility/", import.meta.url);
  const replays = new URL("../docs/evaluation-results/2026-10-19-probability-compatibility/", import.meta.url);
  const files = [["rank.json", "rank"], ["verify.json", "verify"], ["triage.jsonl", "triage"]] as const;
  for (const [suiteFile, prefix] of files) {
    const labeled = parseSuiteText(readFileSync(new URL(`../examples/benchmarks/${suiteFile}`, import.meta.url), "utf8"));
    const predictions: unknown = JSON.parse(readFileSync(prefix === "rank"
      ? new URL("readiness-rank-predictions.json", replays) : new URL(`${prefix}-predictions.json`, results), "utf8"));
    const expected = parseReport(JSON.parse(readFileSync(new URL(`readiness-${labeled.recipeId}.json`, replays), "utf8")));
    const original = parseReport(JSON.parse(readFileSync(new URL(`${labeled.recipeId}.json`, results), "utf8")));
    const actual = evaluatePredictions(labeled, predictions, offline("jev-latest"));
    assert.equal(actual.source, "recorded");
    assert.equal(actual.evaluatedSamples, 12);
    assert.equal(actual.failedSamples, 0);
    assert.equal(actual.recipeVersion, expected.recipeVersion);
    assert.deepEqual(actual.actualModels, ["jev-1.13.0"]);
    assert.deepEqual(actual.metrics, expected.metrics);
    assert.deepEqual(actual.metrics, original.metrics);
    if (labeled.recipeId === "rank-candidates") {
      assert.deepEqual(actual.metrics.keyItemHitRate, metric(14, 14));
      assert.deepEqual(actual.metrics.reviewRate, metric(11, 37));
      assert.deepEqual(actual.metrics.topKReviewRate, metric(6, 14));
    }
  }
});

test("JSON/JSONL suites validate exact labels, unique IDs, bounded inputs and versions without side effects", () => {
  const rank = suite("rank.json");
  const { samples, ...head } = rank;
  const jsonl = [head, ...samples].map(v => JSON.stringify(v)).join("\n");
  assert.deepEqual(parseSuiteText(`\n${jsonl}\n`), rank);
  assert.equal(suite("triage.jsonl").samples.length, 3);
  const plan = planEvaluation(rank, offline());
  assert.equal(plan.mode, "plan");
  assert.equal(plan.plannedRequests, 2);
  assert.equal(plan.questionCount, 5);
  assert.equal(Object.hasOwn(plan, "metrics"), false);
  assert.equal(plan.networkCallMade, false);
  for (const value of [
    { ...rank, samples: [] }, { ...rank, samples: [samples[0], samples[0]] },
    { ...rank, samples: [{ ...samples[0], expected: { keyIds: ["missing"], topK: 1 } }] },
    { ...rank, samples: [{ ...samples[0], expected: { keyIds: ["guide", "guide"], topK: 1 } }] },
    { ...rank, samples: [{ ...samples[0], expected: { keyIds: ["guide"], topK: 50 } }] },
    { ...rank, schemaVersion: 2 }, { ...rank, secret: "not allowed" },
  ]) assert.throws(() => parseSuite(value), { code: "INVALID_INPUT" });
  for (const text of ["", "{broken", `${JSON.stringify(rank)}\n{}`, JSON.stringify(head)]) {
    assert.throws(() => parseSuiteText(text), { code: "INVALID_INPUT" });
  }
  assert.throws(() => planEvaluation({ ...rank, recipeVersion: "future" }, offline()), { code: "INVALID_INPUT" });
  for (const max of [0, -1, 1.5, NaN, 1_001]) assert.throws(() => planEvaluation(rank, offline(), max), { code: "INVALID_INPUT" });
  const verify = suite("verify.json");
  assert.throws(() => parseSuite({ ...verify, samples: [{ ...verify.samples[0], expected: { claims: [] } }] }), { code: "INVALID_INPUT" });
});

test("suite digests ignore object key order and rule version, but bind labels, inputs, order and selection", () => {
  const original = suite("rank.json");
  assert.equal(original.recipeId, "rank-candidates");
  if (original.recipeId !== "rank-candidates") throw new Error("Wrong test fixture");
  const reverseKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reverseKeys)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)])) : value;
  assert.equal(suiteDigest(original), suiteDigest(parseSuite(reverseKeys(original))));
  assert.equal(suiteDigest(original), suiteDigest({ ...original, recipeVersion: "2.0.0" }));
  assert.notEqual(suiteDigest(original), suiteDigest({ ...original, samples: [...original.samples].reverse() }));
  assert.notEqual(suiteDigest(original), suiteDigest(original, original.samples.slice(0, 1)));
  assert.notEqual(suiteDigest(original), suiteDigest({ ...original, suiteVersion: "2.0.0" }));
});

test("fixed ranking predictions retain misses and ties and expose key-hit and review denominators", () => {
  const report = evaluatePredictions(suite("rank.json"), fixture("rank-predictions.json"), offline());
  assert.equal(report.source, "synthetic");
  assert.deepEqual(report.actualModels, ["synthetic-a-fixed"]);
  assert.equal(report.evaluatedSamples, 2);
  assert.deepEqual(report.metrics.keyItemHitRate, metric(1, 3));
  assert.deepEqual(report.metrics.sampleHitRate, metric(1, 2));
  assert.deepEqual(report.metrics.reviewRate, metric(1, 5));
  assert.deepEqual(report.metrics.topKReviewRate, metric(0, 2));
});

test("fixed claim predictions report unsafe acceptances with both negative and accepted denominators", () => {
  const report = evaluatePredictions(suite("verify.json"), fixture("verify-predictions.json"), offline());
  assert.deepEqual(report.metrics.falseAcceptanceRate, metric(1, 3));
  assert.deepEqual(report.metrics.acceptanceErrorRate, metric(1, 2));
  assert.deepEqual(report.metrics.supportedAcceptanceRate, metric(1, 1));
  assert.deepEqual(report.metrics.verdictAccuracy, metric(3, 4));
  assert.deepEqual(report.metrics.reviewRate, metric(2, 4)); // Includes the forced empty-evidence review.
});

test("triage metrics preserve unknown/review, known coverage and null for a zero denominator", () => {
  const s = suite("triage.jsonl");
  const p = fixture("triage-predictions-a.json");
  const report = evaluatePredictions(s, p, offline());
  assert.deepEqual(report.metrics.categoryAccuracy, metric(1, 3));
  assert.deepEqual(report.metrics.knownCategoryAccuracy, metric(1, 2));
  assert.deepEqual(report.metrics.unknownRate, metric(1, 3));
  assert.deepEqual(report.metrics.unknownRecall, metric(0, 1));
  assert.deepEqual(report.metrics.knownCoverage, metric(1, 2));
  assert.deepEqual(report.metrics.reviewRate, metric(1, 3));
  const one = evaluatePredictions(s, p, offline(), 1);
  assert.deepEqual(one.metrics.unknownRecall, { numerator: 0, denominator: 0, rate: null });
});

test("prediction validation rejects mismatched suites, coverage, models and malformed SDK answers before scoring", () => {
  const s = suite("triage.jsonl");
  const p = parsePredictions(fixture("triage-predictions-a.json"));
  for (const value of [
    { ...p, suiteDigest: "0".repeat(64) }, { ...p, recipeVersion: "future" },
    { ...p, requestedModel: "another-model" }, { ...p, predictions: p.predictions.slice(0, 1) },
    { ...p, predictions: [p.predictions[0], p.predictions[0], p.predictions[1]] },
    { ...p, predictions: p.predictions.map((item, i) => i === 0 ? { ...item, sampleId: "wrong-id" } : item) },
  ]) assert.throws(() => evaluatePredictions(s, value, offline()), { code: "INVALID_INPUT" });
  const broken = structuredClone(p);
  broken.predictions[2]!.response.answers.category = { type: "choice", choice: "dependency", confidence: 2, probabilities: {} };
  // Even selecting the first sample cannot conceal a malformed later response.
  assert.throws(() => evaluatePredictions(s, broken, offline(), 1), { code: "INVALID_RESPONSE" });
  assert.throws(() => parsePredictions({ ...p, source: "live" }), { code: "INVALID_INPUT" });
});

test("model/rule comparison keeps raw metrics and errors and rejects changed datasets or synthetic/live mixing", () => {
  const s = suite("triage.jsonl");
  const left = evaluatePredictions(s, fixture("triage-predictions-a.json"), offline());
  const right = evaluatePredictions(s, fixture("triage-predictions-b.json"), offline("synthetic-b"));
  const comparison = compareReports(left, { ...right, recipeVersion: "2.0.0" });
  assert.equal(comparison.left.requestedModel, "synthetic-a");
  assert.equal(comparison.right.recipeVersion, "2.0.0");
  assert.deepEqual(comparison.metrics.unknownRecall, { left: metric(0, 1), right: metric(1, 1), rateDelta: 1 });
  assert.deepEqual(comparison.metrics.unknownRate?.right, metric(2, 3));
  for (const changed of [
    { ...right, source: "live" }, { ...right, suiteDigest: "0".repeat(64) },
    { ...right, sampleDigest: "0".repeat(64) }, { ...right, evaluatorVersion: "future" },
    { ...right, metrics: { ...right.metrics, categoryAccuracy: { numerator: 1, denominator: 3, rate: 1 } } },
  ]) assert.throws(() => compareReports(left, changed), { code: "INVALID_INPUT" });
  assert.throws(() => parseReport({ ...right, failedSamples: 1 }), { code: "INVALID_INPUT" });
});

test("live evaluator enforces worst-case retry budget before any dependency or request and excludes failures from quality metrics", async () => {
  const s = suite("triage.jsonl");
  const p = parsePredictions(fixture("triage-predictions-a.json"));
  let calls = 0;
  const store: RunStore = { recordRun() {}, listRuns: () => [], recordEvaluation() {}, listEvaluations: () => [], close() {} };
  const service = new JudgmentService({ config: readConfig({ JEV_MODEL: "synthetic-a" }), store: () => store,
    provider: () => ({ async evaluate() {
      const index = calls++;
      if (index === 0) throw new JevError("CONNECTION", "Could not connect to TypeSafe.");
      return p.predictions[index]!.response as EvaluationResponse;
    } }) });
  await assert.rejects(evaluateLive(s, service, { maxSamples: 3, maxRequests: 5, maxRetries: 1 }), { code: "INVALID_INPUT" });
  assert.equal(calls, 0);
  const report = await evaluateLive(s, service, { maxSamples: 3, maxRequests: 6, maxRetries: 1 });
  assert.equal(calls, 3);
  assert.equal(report.source, "live"); // Injected transport only: this tests orchestration, not real API quality.
  assert.equal(report.evaluatedSamples, 2);
  assert.equal(report.failedSamples, 1);
  assert.deepEqual(report.errors, { CONNECTION: 1 });
  assert.deepEqual(report.metrics.errorRate, metric(1, 3));
  assert.deepEqual(report.metrics.categoryAccuracy, metric(0, 2));
  assert.deepEqual(report.metrics.unknownRate, metric(1, 2));
  const controller = new AbortController();
  controller.abort(new Error("must not leak"));
  await assert.rejects(evaluateLive(s, service, { maxSamples: 1, maxRequests: 2, maxRetries: 1, signal: controller.signal }), { code: "TIMEOUT" });
  assert.equal(calls, 3);
});

test("readiness benchmarks plan offline and cover both safety-negative claims and unknown failures", () => {
  const root = new URL("../examples/benchmarks/", import.meta.url);
  const counts: Record<string, number> = {};
  for (const file of ["rank.json", "verify.json", "triage.jsonl"]) {
    const benchmark = parseSuiteText(readFileSync(new URL(file, root), "utf8"));
    const plan = planEvaluation(benchmark, offline());
    assert.equal(plan.totalSamples, 12);
    assert.equal(plan.plannedRequests, 12);
    assert.equal(Object.hasOwn(plan, "metrics"), false);
    if (benchmark.recipeId === "rank-candidates") {
      assert.equal(plan.questionCount, 37);
      assert.equal(benchmark.samples.filter(s => s.expected.keyIds.length === 2).length, 2);
    } else if (benchmark.recipeId === "verify-claims") {
      for (const s of benchmark.samples) for (const claim of s.expected.claims) counts[claim.verdict] = (counts[claim.verdict] ?? 0) + 1;
      assert.deepEqual(counts, { supported: 4, contradicted: 4, insufficient: 4 });
      assert.equal(plan.questionCount, 12);
    } else {
      const categories: Record<string, number> = {};
      for (const s of benchmark.samples) categories[s.expected.category] = (categories[s.expected.category] ?? 0) + 1;
      assert.deepEqual(categories, { environment: 2, dependency: 2, regression: 2, flaky: 2, unknown: 4 });
      assert.equal(plan.questionCount, 24);
    }
  }
});
