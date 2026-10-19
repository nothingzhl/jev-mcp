import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readConfig } from "../src/config.js";
import { JudgmentService } from "../src/core/service.js";
import { planEvaluation } from "../src/evaluation/runner.js";
import { parseSuiteText } from "../src/evaluation/suite.js";

const root = new URL("../examples/benchmarks/", import.meta.url);
const files = ["rank.json", "verify.json", "triage.jsonl"];
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const service = new JudgmentService({ config: readConfig({ JEV_MODEL: "jev-latest" }),
  provider() { throw new Error("Offline challenge preparation must not construct a provider"); },
  store() { throw new Error("Offline challenge preparation must not open SQLite"); } });

test("new challenge plans match frozen digests, batch independent questions and send no labels", () => {
  const saved = JSON.parse(readFileSync(new URL("../docs/evaluation-results/2026-10-19-probability-compatibility/challenge-plan.json", import.meta.url), "utf8")) as {
    status: string; networkCallsMade: number; qualityEvaluationPerformed: boolean; independentHumanReview: boolean;
    totals: { samples: number; plannedRequests: number; questions: number };
    suites: Array<{ file: string; plan: ReturnType<typeof planEvaluation>; goldCounts: Record<string, number> }>;
  };
  assert.equal(saved.status, "plan-only");
  assert.equal(saved.networkCallsMade, 0);
  assert.equal(saved.qualityEvaluationPerformed, false);
  assert.equal(saved.independentHumanReview, false);
  assert.equal(saved.suites.length, files.length);
  const totals = { samples: 0, plannedRequests: 0, questions: 0 };
  for (const [i, file] of files.entries()) {
    const suite = parseSuiteText(read(`challenge-v1/${file}`));
    const plan = planEvaluation(suite, service);
    assert.equal(saved.suites[i]!.file, `examples/benchmarks/challenge-v1/${file}`);
    assert.deepEqual(plan, saved.suites[i]!.plan);
    assert.equal(plan.totalSamples, 12);
    assert.equal(plan.plannedRequests, 12);
    assert.equal(plan.networkCallMade, false);
    assert.equal(Object.hasOwn(plan, "metrics"), false);
    totals.samples += plan.totalSamples;
    totals.plannedRequests += plan.plannedRequests;
    totals.questions += plan.questionCount;
    for (const sample of suite.samples) {
      const { request } = service.plan(suite.recipeId, sample.input);
      assert.deepEqual(Object.keys(request).sort(), ["model", "questions", "state"]);
      assert.deepEqual(request.state, sample.input); // Labels and annotation reasons stay outside the request.
    }
    if (suite.recipeId === "rank-candidates") {
      assert.equal(plan.questionCount, 48);
      assert.ok(suite.samples.every(s => s.input.candidates.length === 4));
      assert.equal(suite.samples.filter(s => s.expected.keyIds.length === 2).length, 4);
      assert.deepEqual(saved.suites[i]!.goldCounts, { candidates: 48, keyItems: 16, topKSlots: 16, multiComponentSamples: 4 });
      assert.equal(suite.samples.reduce((n, s) => n + s.expected.keyIds.length, 0), 16);
      assert.equal(suite.samples.reduce((n, s) => n + s.expected.topK, 0), 16);
      const keyPositions = new Set(suite.samples.flatMap(s => s.expected.keyIds.map(id => s.input.candidates.findIndex(c => c.id === id))));
      assert.deepEqual([...keyPositions].sort(), [0, 1, 2, 3]);
    } else if (suite.recipeId === "verify-claims") {
      assert.equal(plan.questionCount, 17);
      const counts: Record<string, number> = {};
      for (const sample of suite.samples) for (const claim of sample.expected.claims) counts[claim.verdict] = (counts[claim.verdict] ?? 0) + 1;
      assert.deepEqual(counts, { supported: 4, contradicted: 4, insufficient: 9 });
      assert.deepEqual(saved.suites[i]!.goldCounts, { ...counts, negativeClaims: 13, batchedSamples: 4 });
      assert.equal(suite.samples.filter(s => s.input.claims.length > 1).length, 4);
      const isolated = suite.samples.find(s => s.id === "sibling-evidence-isolation")!;
      assert.equal(isolated.input.claims.length, 3);
      assert.ok(isolated.input.claims[1]!.evidence.length > 0); // Tests borrowing without the empty-evidence override hiding it.
      assert.equal(isolated.input.claims[2]!.evidence, "");
      assert.deepEqual(isolated.expected.claims.map(c => c.verdict), ["supported", "insufficient", "insufficient"]);
    } else {
      assert.equal(plan.questionCount, 24);
      const counts: Record<string, number> = {};
      for (const sample of suite.samples) counts[sample.expected.category] = (counts[sample.expected.category] ?? 0) + 1;
      assert.deepEqual(counts, { environment: 2, dependency: 2, regression: 2, flaky: 2, unknown: 4 });
      assert.deepEqual(saved.suites[i]!.goldCounts, counts);
    }
  }
  assert.deepEqual(totals, { samples: 36, plannedRequests: 36, questions: 89 });
  assert.deepEqual(totals, saved.totals);
});

test("each new challenge has a complete annotation and reuses no first-benchmark sample or input", () => {
  const notes = JSON.parse(read("challenge-v1/annotations.json")) as {
    dataset: string; status: string; independentHumanReview: boolean;
    suites: Array<{ file: string; recipeId: string; annotations: Array<{ sampleId: string; tags: string[]; rationale: string }> }>;
  };
  assert.equal(notes.dataset, "challenge-v1");
  assert.equal(notes.status, "prelabeled-before-model-evaluation");
  assert.equal(notes.independentHumanReview, false);
  assert.deepEqual(notes.suites.map(s => s.file).sort(), [...files].sort());
  const previous = files.map(file => parseSuiteText(read(file)));
  const oldIds = new Set(previous.flatMap(s => s.samples.map(sample => sample.id)));
  const oldInputs = new Set(previous.flatMap(s => s.samples.map(sample => JSON.stringify(sample.input))));
  const newIds = new Set<string>();
  const newInputs = new Set<string>();
  const tags = new Set<string>();
  for (const file of files) {
    const suite = parseSuiteText(read(`challenge-v1/${file}`));
    const note = notes.suites.find(s => s.file === file)!;
    assert.equal(note.recipeId, suite.recipeId);
    assert.equal(note.annotations.length, suite.samples.length);
    assert.deepEqual(note.annotations.map(a => a.sampleId).sort(), suite.samples.map(s => s.id).sort());
    for (const sample of suite.samples) {
      assert.equal(oldIds.has(sample.id), false);
      assert.equal(newIds.has(sample.id), false);
      newIds.add(sample.id);
      const input = JSON.stringify(sample.input);
      assert.equal(oldInputs.has(input), false);
      assert.equal(newInputs.has(input), false);
      newInputs.add(input);
      const annotation = note.annotations.find(a => a.sampleId === sample.id)!;
      assert.ok(annotation.rationale.trim(), `Missing annotation rationale: ${sample.id}`);
      assert.ok(annotation.tags.length > 0);
      for (const tag of annotation.tags) { assert.ok(tag.trim()); tags.add(tag); }
    }
  }
  assert.equal(newIds.size, 36);
  for (const tag of ["multi-component", "missing-evidence", "cross-claim-isolation", "untrusted-instructions",
    "changed-rerun", "changed-input", "conflicting-evidence", "multilingual"]) assert.ok(tags.has(tag));
});
