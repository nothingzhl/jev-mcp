import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dryRunResult, parseInput } from "../hooks/jev-failure-triage.mjs";

test("failure hook defaults to a review signal without running a command", async () => {
  assert.deepEqual(parseInput(JSON.stringify({ command: "npm test", log: "failed assertion", changeSummary: "changed parser" })), {
    command: "npm test", log: "failed assertion", changeSummary: "changed parser",
  });
  assert.deepEqual(dryRunResult(), {
    category: "unknown", evidenceSufficient: false, requiresReview: true,
    reviewReason: "dry_run_requires_explicit_live_flag",
  });
});

test("failure hook rejects missing explicit material", async () => {
  assert.throws(() => parseInput(JSON.stringify({ command: "npm test" })), /log is required/);
});

test("failure hook has no hidden repository or credential reads", async () => {
  const source = await readFile(new URL("../hooks/jev-failure-triage.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /TYPESAFE_API_KEY\s*=/);
  assert.doesNotMatch(source, /git\s+(status|diff|log|show)/);
});

