import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const samples = "examples/evaluation/triage.jsonl";

test("evaluation CLI plans/scores/compares without key or DB and explicitly persists metadata when requested", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-eval-cli-"));
  const database = join(directory, "metadata.sqlite");
  const env = { PATH: process.env.PATH ?? "", TYPESAFE_API_KEY: "", JEV_DB_PATH: database };
  const cli = (args: string[]) => execute(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: root, env, timeout: 10_000 });
  try {
    const plan = JSON.parse((await cli(["evaluate", "--suite", samples])).stdout);
    assert.equal(plan.mode, "plan");
    assert.equal(plan.plannedRequests, 3);
    assert.equal(Object.hasOwn(plan, "metrics"), false);
    assert.equal(existsSync(database), false);
    const a = await cli(["evaluate", "--suite", samples, "--predictions", "examples/evaluation/triage-predictions-a.json"]);
    const b = await cli(["evaluate", "--suite", samples, "--predictions", "examples/evaluation/triage-predictions-b.json"]);
    assert.equal(JSON.parse(a.stdout).source, "synthetic");
    assert.equal(JSON.parse(b.stdout).requestedModel, "synthetic-b");
    assert.equal(existsSync(database), false);
    const left = join(directory, "a.json");
    const right = join(directory, "b.json");
    await writeFile(left, a.stdout);
    await writeFile(right, b.stdout);
    const compared = JSON.parse((await cli(["compare", "--left", left, "--right", right])).stdout);
    assert.equal(compared.metrics.unknownRecall.rateDelta, 1);
    assert.equal(compared.left.metrics.unknownRate.denominator, 3);
    assert.equal(existsSync(database), false);
    const saved = JSON.parse((await cli(["evaluate", "--suite", samples, "--predictions", "examples/evaluation/triage-predictions-a.json", "--save"])).stdout);
    assert.equal(existsSync(database), true);
    assert.deepEqual(JSON.parse((await cli(["evaluations", "--limit", "1"])).stdout), [saved]);
    assert.deepEqual(JSON.parse((await cli(["history"])).stdout), []); // Offline scoring is not a model call.
    assert.equal((await readFile(database)).includes(Buffer.from("command not found")), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("evaluation CLI rejects unsafe modes, missing credentials, malformed files and comparison errors without leaking materials", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-eval-errors-"));
  const database = join(directory, "metadata.sqlite");
  const env = { PATH: process.env.PATH ?? "", TYPESAFE_API_KEY: "", JEV_DB_PATH: database };
  const cli = (args: string[]) => execute(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: root, env, timeout: 10_000 });
  try {
    const bad = join(directory, "bad.json");
    await writeFile(bad, "SYNTHETIC_PRIVATE_INPUT");
    const utf8 = join(directory, "invalid-utf8.json");
    await writeFile(utf8, Buffer.from([0xff]));
    const oversized = join(directory, "oversized.json");
    await writeFile(oversized, " ".repeat(10 * 1024 * 1024 + 1));
    const cases: Array<[string[], string]> = [
      [["evaluate"], "INVALID_INPUT"],
      [["evaluate", "--suite", samples, "--live"], "INVALID_INPUT"],
      [["evaluate", "--suite", samples, "--max-samples", "-1"], "INVALID_INPUT"],
      [["evaluate", "--suite", samples, "--max-requests", "3"], "INVALID_INPUT"],
      [["evaluate", "--suite", samples, "--live", "--predictions", bad], "INVALID_INPUT"],
      [["evaluate", "--suite", samples, "--save"], "INVALID_INPUT"],
      [["evaluate", "--suite", "-", "--predictions", "-"], "INVALID_INPUT"],
      [["evaluate", "--suite", samples, "--live", "--max-samples", "1", "--max-requests", "2"], "AUTHENTICATION"],
      [["evaluate", "--suite", bad], "INVALID_INPUT"],
      [["evaluate", "--suite", utf8], "INVALID_INPUT"],
      [["evaluate", "--suite", oversized], "INVALID_INPUT"],
      [["evaluate", "--suite", samples, "--predictions", bad], "INVALID_INPUT"],
      [["compare", "--left", bad], "INVALID_INPUT"],
      [["compare", "--left", bad, "--right", bad], "INVALID_INPUT"],
      [["evaluations", "--limit", "0"], "INVALID_INPUT"],
    ];
    for (const [args, code] of cases) {
      await assert.rejects(cli(args), (error: unknown) => {
        const result = error as { code: number; stderr: string; stdout: string };
        assert.equal(result.code, 1, args.join(" "));
        assert.equal(result.stdout, "");
        assert.equal(JSON.parse(result.stderr.trim().split("\n").at(-1)!).error.code, code);
        assert.equal(result.stderr.includes("SYNTHETIC_PRIVATE_INPUT"), false);
        return true;
      });
    }
    assert.equal(existsSync(database), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("live CLI enforces the retry allowance and returns nonzero with a persisted, all-error report using injected fetch", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-eval-live-cli-"));
  const database = join(directory, "metadata.sqlite");
  const env = { PATH: process.env.PATH ?? "", TYPESAFE_API_KEY: "synthetic-test-key", JEV_DB_PATH: database, JEV_MAX_RETRIES: "1" };
  const cli = (budget: string, save = false) => execute(process.execPath,
    ["--import", "tsx", "--import", "./test/fixtures/fetch-denied.mjs", "src/cli.ts", "evaluate", "--suite", samples,
      "--live", "--max-samples", "2", "--max-requests", budget, ...(save ? ["--save"] : [])], { cwd: root, env, timeout: 8_000 });
  try {
    await assert.rejects(cli("3"), (error: unknown) => {
      const result = error as { stderr: string; stdout: string; code: number };
      assert.equal(result.code, 1);
      assert.equal(result.stderr.includes("SYNTHETIC_FETCH"), false);
      assert.equal(JSON.parse(result.stderr.trim().split("\n").at(-1)!).error.code, "INVALID_INPUT");
      return true;
    });
    assert.equal(existsSync(database), false);
    let reportId: string | undefined;
    await assert.rejects(cli("4", true), (error: unknown) => {
      const result = error as { stderr: string; stdout: string; code: number };
      assert.equal(result.code, 1);
      assert.equal(result.stderr.match(/SYNTHETIC_FETCH/g)?.length, 2);
      assert.equal(result.stderr.includes("SYNTHETIC_PRIVATE_UPSTREAM_BODY"), false);
      const report = JSON.parse(result.stdout);
      reportId = report.id;
      assert.equal(report.source, "live");
      assert.equal(report.totalSamples, 2);
      assert.equal(report.evaluatedSamples, 0);
      assert.equal(report.failedSamples, 2);
      assert.deepEqual(report.actualModels, []);
      assert.deepEqual(report.errors, { AUTHENTICATION: 2 });
      assert.deepEqual(report.metrics.categoryAccuracy, { numerator: 0, denominator: 0, rate: null });
      return true;
    });
    const history = await execute(process.execPath, ["--import", "tsx", "src/cli.ts", "evaluations"], { cwd: root, env });
    assert.equal(JSON.parse(history.stdout)[0].id, reportId);
    assert.equal((await readFile(database)).includes(Buffer.from("SYNTHETIC_PRIVATE_UPSTREAM_BODY")), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
