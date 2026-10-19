import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readConfig } from "../src/config.js";
import type { EvaluationResponse, RunRecord, RunStore } from "../src/core/contracts.js";
import { JudgmentService } from "../src/core/service.js";
import { parseReport } from "../src/evaluation/report.js";
import { evaluateLive } from "../src/evaluation/runner.js";
import { parseSuiteText, suiteDigest } from "../src/evaluation/suite.js";
import { validateResponse } from "../src/providers/validation.js";
import { interpret as rank } from "../src/recipes/rank-candidates.js";
import { interpret as verify } from "../src/recipes/verify-claims.js";

const root = new URL("../docs/evaluation-results/2026-10-19-challenge-v1/", import.meta.url);
const replays = new URL("../docs/evaluation-results/2026-10-19-probability-compatibility/", import.meta.url);
type Capture = { file: string; suiteDigest: string; recipeVersion: string; requestedModel: string;
  samples: Array<{ sampleId: string; attempt: number; httpStatus: number; response: EvaluationResponse }> };

test("36 captured challenge responses replay with bounded Score mass review and preserved historical errors", async () => {
  const captured = JSON.parse(readFileSync(new URL("captures.json", root), "utf8")) as {
    source: string; suites: Capture[];
  };
  assert.equal(captured.source, "live-http-capture");
  assert.equal(captured.suites.length, 3);
  const attempts = new Set<number>();
  const runs: RunRecord[] = [];
  const store: RunStore = { recordRun: record => { runs.push(record); }, listRuns: () => [],
    recordEvaluation() { throw new Error("Offline replay must not persist reports"); }, listEvaluations: () => [], close() {} };
  let compatibleScores = 0;
  let compatibleMass = 0;
  for (const capture of captured.suites) {
    const suite = parseSuiteText(readFileSync(new URL(`../${capture.file}`, import.meta.url), "utf8"));
    const original = parseReport(JSON.parse(readFileSync(new URL(`${suite.recipeId}.json`, root), "utf8")));
    const expected = parseReport(JSON.parse(readFileSync(new URL(`challenge-${suite.recipeId}.json`, replays), "utf8")));
    assert.equal(capture.suiteDigest, suiteDigest(suite));
    assert.equal(capture.recipeVersion, original.recipeVersion);
    assert.equal(expected.recipeVersion, suite.recipeVersion);
    if (suite.recipeId === "rank-candidates") {
      assert.equal(original.failedSamples, 1);
      assert.equal(expected.failedSamples, 0);
    } else assert.deepEqual(expected.metrics, original.metrics);
    assert.equal(capture.samples.length, suite.samples.length);
    let index = 0;
    const service = new JudgmentService({ config: readConfig({ JEV_MODEL: capture.requestedModel, JEV_MAX_RETRIES: "0" }),
      store: () => store,
      provider: () => ({ async evaluate(request) {
        const sample = suite.samples[index]!;
        const item = capture.samples[index++]!;
        assert.equal(item.sampleId, sample.id);
        assert.equal(item.httpStatus, 200);
        assert.equal(attempts.has(item.attempt), false);
        attempts.add(item.attempt);
        // Pure local validation of stored responses; no SDK or fetch is constructed.
        const response = validateResponse(item.response, request, item.response.requestId ?? undefined);
        if (suite.recipeId === "rank-candidates") {
          for (const candidate of rank(sample.input, response).candidates) if (candidate.judgment.consistency) {
            compatibleScores++;
            assert.equal(candidate.requiresReview, true);
            if (candidate.judgment.consistency.reportedProbabilitySum !== undefined) {
              compatibleMass++;
              assert.equal(candidate.reviewReason, "probability_rounding");
              assert.ok(Math.abs(candidate.judgment.consistency.reportedProbabilitySum - .99) < 1e-12);
              assert.deepEqual(candidate.judgment.probabilities, { "0": .28, "1": .67, "2": .04, "3": 0, "4": 0 });
            } else assert.equal(candidate.reviewReason, "score_rounding");
          }
        } else if (suite.recipeId === "verify-claims" && sample.id === "copy-started-not-completed") {
          const claim = verify(sample.input, response).claims[0]!;
          assert.equal(claim.verdict, "contradicted"); // Preserve the model's mistake against the insufficient label.
          assert.equal(claim.status, "review");
          assert.equal(claim.canAutoAccept, false);
          assert.equal(claim.reviewReason, "low_confidence");
        }
        return response;
      } }),
    });
    // Reuse orchestration with a captured-response provider; this makes no live calls.
    const actual = await evaluateLive(suite, service, { maxSamples: 12, maxRequests: 12, maxRetries: 0 });
    assert.equal(index, 12);
    assert.deepEqual(actual.metrics, expected.metrics);
    assert.deepEqual(actual.errors, expected.errors);
    assert.deepEqual(actual.actualModels, ["jev-1.13.0"]);
    assert.equal(actual.evaluatedSamples, expected.evaluatedSamples);
    assert.equal(actual.failedSamples, expected.failedSamples);
  }
  assert.deepEqual([...attempts].sort((a, b) => a - b), Array.from({ length: 36 }, (_, i) => i + 1));
  assert.equal(compatibleScores, 5);
  assert.equal(compatibleMass, 1);
  assert.equal(runs.length, 36);
  const errors = runs.filter(r => r.status === "error");
  assert.equal(errors.length, 0);
});
