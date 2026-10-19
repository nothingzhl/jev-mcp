import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { EvaluationRecord, RunRecord } from "../src/core/contracts.js";
import { JevError } from "../src/core/errors.js";
import { SqliteRunStore } from "../src/storage/sqlite.js";

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
      assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 1);
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
    database.exec("PRAGMA user_version = 2");
    database.close();
    assert.throws(() => new SqliteRunStore(path), storageError);
    const reopened = new DatabaseSync(path);
    try {
      assert.equal(reopened.prepare("PRAGMA user_version").get()?.user_version, 2);
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
  assert.throws(() => new SqliteRunStore(""), storageError);
});
