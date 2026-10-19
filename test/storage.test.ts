import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import type { EvaluationRecord, RunRecord } from "../src/core/contracts.js";
import { JevError } from "../src/core/errors.js";
import { SqliteRunStore } from "../src/storage/sqlite.js";
import { parseSuiteText } from "../src/evaluation/suite.js";
import { evaluatePredictions } from "../src/evaluation/runner.js";
import { JudgmentService } from "../src/core/service.js";
import { readConfig } from "../src/config.js";

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1", recipeId: "rank-candidates", recipeVersion: "1.0.0",
    requestedModel: "jev-test", actualModel: "jev-test-actual",
    startedAt: "2026-10-19T01:00:00.000Z", durationMs: 23, status: "success",
    questionCount: 2, inputTokens: 10, outputTokens: 4,
    requestId: "request-1", errorCode: null, ...overrides,
  };
}

function evaluation(overrides: Partial<EvaluationRecord> = {}): EvaluationRecord {
  return {
    id: "eval-1", suite: "synthetic", recipeId: "rank-candidates", recipeVersion: "1.0.0",
    model: "jev-test", createdAt: "2026-10-19T01:00:00.000Z", total: 3, passed: 2,
    ...overrides,
  };
}

function storageError(error: unknown): boolean {
  assert.ok(error instanceof JevError);
  assert.equal(error.code, "STORAGE");
  assert.equal(error.message, "Local metadata storage is unavailable.");
  assert.equal(error.cause, undefined);
  return true;
}

test("SQLite stores metadata in memory and returns newest entries with limits", () => {
  const store = new SqliteRunStore(":memory:");
  try {
    const first = run();
    const latest = run({ id: "run-2", startedAt: "2026-10-19T02:00:00.000Z", actualModel: null });
    store.recordRun(first);
    store.recordRun(latest);
    store.recordEvaluation(evaluation());
    const latestEvaluation = evaluation({ id: "eval-2", createdAt: "2026-10-19T02:00:00.000Z" });
    store.recordEvaluation(latestEvaluation);
    assert.deepEqual(store.listRuns(1), [latest]);
    assert.deepEqual(store.listRuns(), [latest, first]);
    assert.deepEqual(store.listEvaluations(1), [latestEvaluation]);
    assert.equal(store.listEvaluations(1_000).length, 2);
    for (const limit of [0, -1, 1_001, 1.5, NaN, Infinity]) {
      assert.throws(() => store.listRuns(limit), storageError);
      assert.throws(() => store.listEvaluations(limit), storageError);
    }
  } finally {
    store.close();
  }
});

test("SQLite creates private local directories and persists across reopening", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-storage-"));
  const path = join(directory, "nested", "metadata.sqlite");
  try {
    const store = new SqliteRunStore(path);
    store.recordRun(run());
    store.recordEvaluation(evaluation());
    store.close();
    const reopened = new SqliteRunStore(path);
    try {
      assert.deepEqual(reopened.listRuns(), [run()]);
      assert.deepEqual(reopened.listEvaluations(), [evaluation()]);
    } finally {
      reopened.close();
    }
    if (process.platform !== "win32") {
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(join(directory, "nested")).mode & 0o777, 0o700);
    }
    const database = new DatabaseSync(path);
    try {
      assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 2);
      assert.equal(database.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite ignores JS extra properties and never persists sensitive payloads", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-storage-privacy-"));
  const path = join(directory, "metadata.sqlite");
  const sentinel = "SENSITIVE_PAYLOAD_3ec83a9917";
  try {
    const store = new SqliteRunStore(path);
    const sensitive = {
      apiKey: sentinel, state: sentinel, code: sentinel, logs: sentinel,
      answers: { secret: sentinel }, rawResult: { secret: sentinel },
    };
    store.recordRun({ ...run(), ...sensitive });
    store.recordEvaluation({ ...evaluation(), ...sensitive });
    assert.deepEqual(store.listRuns(), [run()]);
    assert.deepEqual(store.listEvaluations(), [evaluation()]);
    store.close();
    assert.equal(readFileSync(path).includes(Buffer.from(sentinel)), false);
    const database = new DatabaseSync(path);
    try {
      const runColumns = database.prepare("PRAGMA table_info(runs)").all().map((row) => row.name);
      const evaluationColumns = database.prepare("PRAGMA table_info(evaluations)").all().map((row) => row.name);
      assert.deepEqual(runColumns, ["id", "recipe_id", "recipe_version", "requested_model", "actual_model", "started_at", "duration_ms", "status", "question_count", "input_tokens", "output_tokens", "request_id", "error_code"]);
      assert.deepEqual(evaluationColumns, ["id", "suite", "recipe_id", "recipe_version", "model", "created_at", "total", "passed"]);
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite uses bound values and hides raw storage errors", () => {
  const store = new SqliteRunStore(":memory:");
  try {
    const record = run({ id: "'); DROP TABLE runs; --" });
    store.recordRun(record);
    assert.deepEqual(store.listRuns(), [record]);
    assert.throws(() => store.recordRun(record), storageError);
    assert.throws(() => store.recordEvaluation(evaluation({ passed: 4 })), storageError);
    assert.equal(store.listRuns().length, 1);
  } finally {
    store.close();
  }
});

test("SQLite refuses newer schemas without changing the schema version", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-storage-version-"));
  const path = join(directory, "metadata.sqlite");
  try {
    const database = new DatabaseSync(path);
    database.exec("PRAGMA user_version = 3");
    database.close();
    assert.throws(() => new SqliteRunStore(path), storageError);
    const reopened = new DatabaseSync(path);
    try {
      assert.equal(reopened.prepare("PRAGMA user_version").get()?.user_version, 3);
      assert.deepEqual(reopened.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all(), []);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite close is idempotent and all operations fail safely after closing", () => {
  const store = new SqliteRunStore(":memory:");
  store.close();
  store.close();
  assert.throws(() => store.recordRun(run()), storageError);
  assert.throws(() => store.recordEvaluation(evaluation()), storageError);
  assert.throws(() => store.listRuns(), storageError);
  assert.throws(() => store.listEvaluations(), storageError);
  assert.throws(() => store.listReports(), storageError);
  assert.throws(() => new SqliteRunStore(""), storageError);
});

function fixedReport() {
  const root = new URL("../examples/evaluation/", import.meta.url);
  const suite = parseSuiteText(readFileSync(new URL("triage.jsonl", root), "utf8"));
  const predictions = JSON.parse(readFileSync(new URL("triage-predictions-a.json", root), "utf8")) as unknown;
  const service = new JudgmentService({ config: readConfig({ JEV_MODEL: "synthetic-a" }),
    provider() { throw new Error("network not allowed"); }, store() { throw new Error("no store required"); } });
  return evaluatePredictions(suite, predictions, service);
}

test("v1 migration preserves every old row, reopens v2 reports, and stores only allowlisted aggregates", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-migration-"));
  const path = join(directory, "metadata.sqlite");
  const sentinel = "SENSITIVE_RAW_INPUT_SENTINEL";
  try {
    const v1 = new DatabaseSync(path);
    v1.exec(readFileSync(new URL("fixtures/schema-v1.sql", import.meta.url), "utf8"));
    const oldRuns = v1.prepare("SELECT * FROM runs").all();
    const oldEvaluations = v1.prepare("SELECT * FROM evaluations").all();
    v1.close();
    const report = fixedReport();
    const store = new SqliteRunStore(path);
    assert.deepEqual(store.listReports(), []); // No fabricated dimensions for legacy summaries.
    store.recordReport({ ...report, state: sentinel, apiKey: sentinel, answers: sentinel } as typeof report);
    assert.throws(() => store.recordReport({ ...report, id: "bad", metrics: { ...report.metrics, secret: sentinel } } as unknown as typeof report), storageError);
    store.close();
    const reopened = new SqliteRunStore(path);
    assert.deepEqual(reopened.listReports(), [report]);
    assert.equal(reopened.listRuns()[0]?.id, "legacy-run");
    assert.equal(reopened.listEvaluations()[0]?.model, "legacy-model");
    for (const limit of [0, 1_001, 1.5, NaN]) assert.throws(() => reopened.listReports(limit), storageError);
    reopened.close();
    const database = new DatabaseSync(path);
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 2);
    assert.deepEqual(database.prepare("SELECT * FROM runs").all(), oldRuns);
    assert.deepEqual(database.prepare("SELECT * FROM evaluations").all(), oldEvaluations);
    database.close();
    assert.equal(readFileSync(path).includes(Buffer.from(sentinel)), false);
    assert.equal(JSON.stringify(report).includes("command not found"), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("failed migration rolls back atomically without altering v1 data or version", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-migration-fail-"));
  const path = join(directory, "metadata.sqlite");
  try {
    const database = new DatabaseSync(path);
    database.exec(readFileSync(new URL("fixtures/schema-v1.sql", import.meta.url), "utf8"));
    // Fail after CREATE TABLE succeeds, so this verifies a real partial migration rollback.
    database.exec("CREATE INDEX evaluation_reports_created_at ON runs (id)");
    database.close();
    assert.throws(() => new SqliteRunStore(path), storageError);
    const reopened = new DatabaseSync(path);
    assert.equal(reopened.prepare("PRAGMA user_version").get()?.user_version, 1);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM runs").get()?.count, 1);
    assert.deepEqual(reopened.prepare("PRAGMA table_info(evaluation_reports)").all(), []);
    assert.equal(reopened.prepare("SELECT tbl_name FROM sqlite_schema WHERE name = 'evaluation_reports_created_at'").get()?.tbl_name, "runs");
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("independent SQLite connections initialize and migrate simultaneously without losing rows", { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-multi-connection-"));
  try {
    for (const existing of [false, true]) {
      const path = join(directory, existing ? "v1.sqlite" : "new.sqlite");
      if (existing) {
        const database = new DatabaseSync(path);
        database.exec(readFileSync(new URL("fixtures/schema-v1.sql", import.meta.url), "utf8"));
        database.close();
      }
      const children = Array.from({ length: 6 }, () => fork(new URL("fixtures/sqlite-worker.ts", import.meta.url), [path], {
        execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"],
      }));
      try {
        let stderr = "";
        for (const child of children) child.stderr?.on("data", chunk => { stderr += String(chunk); });
        const exits = children.map(child => once(child, "exit"));
        await Promise.all(children.map(child => once(child, "message")));
        for (const child of children) child.send("start");
        assert.deepEqual((await Promise.all(exits)).map(([code]) => code), Array(6).fill(0), stderr);
        const reopened = new SqliteRunStore(path);
        assert.equal(reopened.listRuns(100).length, existing ? 7 : 6);
        assert.equal(reopened.listEvaluations().length, existing ? 1 : 0);
        reopened.close();
      } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
