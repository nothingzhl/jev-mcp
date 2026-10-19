import { closeSync, chmodSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EvaluationRecord, RunRecord, RunStore } from "../core/contracts.js";
import { JevError } from "../core/errors.js";

const STORAGE_MESSAGE = "Local metadata storage is unavailable.";
const SCHEMA_VERSION = 1;
const RUN_COLUMNS = `id, recipe_id AS recipeId, recipe_version AS recipeVersion,
  requested_model AS requestedModel, actual_model AS actualModel,
  started_at AS startedAt, duration_ms AS durationMs, status,
  question_count AS questionCount, input_tokens AS inputTokens,
  output_tokens AS outputTokens, request_id AS requestId, error_code AS errorCode`;
const EVALUATION_COLUMNS = `id, suite, recipe_id AS recipeId,
  recipe_version AS recipeVersion, model, created_at AS createdAt, total, passed`;

function storageOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    // SQLite exceptions can include SQL values or local paths. Do not retain causes.
    throw new JevError("STORAGE", STORAGE_MESSAGE);
  }
}

function checkedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Invalid metadata limit");
  }
  return limit;
}

/** Stores only allowlisted metadata; never serialize requests, answers or errors. */
export class SqliteRunStore implements RunStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    this.database = storageOperation(() => {
      if (typeof path !== "string" || path.trim() === "") {
        throw new Error("Invalid metadata path");
      }
      if (path !== ":memory:") {
        mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
        // Create the file with private permissions before SQLite can create sidecars.
        const descriptor = openSync(path, "a", 0o600);
        closeSync(descriptor);
        chmodSync(path, 0o600);
      }
      const database = new DatabaseSync(path);
      try {
        database.exec("PRAGMA busy_timeout = 5000");
        const version = database.prepare("PRAGMA user_version").get()?.user_version;
        if (version !== 0 && version !== SCHEMA_VERSION) {
          throw new Error("Unsupported metadata schema");
        }
        database.exec("PRAGMA journal_mode = WAL");
        if (version === 0) {
          database.exec(`
            BEGIN IMMEDIATE;
            CREATE TABLE runs (
              id TEXT PRIMARY KEY NOT NULL,
              recipe_id TEXT NOT NULL,
              recipe_version TEXT NOT NULL,
              requested_model TEXT NOT NULL,
              actual_model TEXT,
              started_at TEXT NOT NULL,
              duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
              status TEXT NOT NULL CHECK (status IN ('success', 'error')),
              question_count INTEGER NOT NULL CHECK (question_count >= 0),
              input_tokens INTEGER CHECK (input_tokens >= 0),
              output_tokens INTEGER CHECK (output_tokens >= 0),
              request_id TEXT,
              error_code TEXT
            ) STRICT;
            CREATE INDEX runs_started_at ON runs (started_at DESC, id DESC);
            CREATE TABLE evaluations (
              id TEXT PRIMARY KEY NOT NULL,
              suite TEXT NOT NULL,
              recipe_id TEXT NOT NULL,
              recipe_version TEXT NOT NULL,
              model TEXT NOT NULL,
              created_at TEXT NOT NULL,
              total INTEGER NOT NULL CHECK (total >= 0),
              passed INTEGER NOT NULL CHECK (passed >= 0 AND passed <= total)
            ) STRICT;
            CREATE INDEX evaluations_created_at ON evaluations (created_at DESC, id DESC);
            PRAGMA user_version = ${SCHEMA_VERSION};
            COMMIT;
          `);
        }
        return database;
      } catch (error) {
        database.close();
        throw error;
      }
    });
  }

  recordRun(record: RunRecord): void {
    storageOperation(() => {
      this.assertOpen();
      this.database.prepare(`INSERT INTO runs (
        id, recipe_id, recipe_version, requested_model, actual_model, started_at,
        duration_ms, status, question_count, input_tokens, output_tokens, request_id, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        record.id, record.recipeId, record.recipeVersion, record.requestedModel,
        record.actualModel, record.startedAt, record.durationMs, record.status,
        record.questionCount, record.inputTokens, record.outputTokens,
        record.requestId, record.errorCode,
      );
    });
  }

  listRuns(limit = 20): RunRecord[] {
    return storageOperation(() => {
      this.assertOpen();
      return this.database.prepare(`SELECT ${RUN_COLUMNS} FROM runs
        ORDER BY started_at DESC, id DESC LIMIT ?`).all(checkedLimit(limit))
        .map((row) => ({ ...row })) as unknown as RunRecord[];
    });
  }

  recordEvaluation(record: EvaluationRecord): void {
    storageOperation(() => {
      this.assertOpen();
      this.database.prepare(`INSERT INTO evaluations (
        id, suite, recipe_id, recipe_version, model, created_at, total, passed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        record.id, record.suite, record.recipeId, record.recipeVersion,
        record.model, record.createdAt, record.total, record.passed,
      );
    });
  }

  listEvaluations(limit = 20): EvaluationRecord[] {
    return storageOperation(() => {
      this.assertOpen();
      return this.database.prepare(`SELECT ${EVALUATION_COLUMNS} FROM evaluations
        ORDER BY created_at DESC, id DESC LIMIT ?`).all(checkedLimit(limit))
        .map((row) => ({ ...row })) as unknown as EvaluationRecord[];
    });
  }

  close(): void {
    storageOperation(() => {
      if (!this.closed) {
        this.database.close();
        this.closed = true;
      }
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Metadata store is closed");
  }
}
