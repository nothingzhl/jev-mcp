import { closeSync, chmodSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EvaluationRecord, RunRecord, RunStore } from "../core/contracts.js";
import { JevError } from "../core/errors.js";
import { parseReport, type EvaluationReport, type EvaluationReportStore } from "../evaluation/report.js";

const STORAGE_MESSAGE = "Local metadata storage is unavailable.";
const SCHEMA_VERSION = 2;
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
export class SqliteRunStore implements RunStore, EvaluationReportStore {
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
        // Take the writer lock BEFORE reading user_version. Another connection may
        // have initialized/migrated this file while we waited for that lock.
        database.exec("BEGIN IMMEDIATE");
        const version = database.prepare("PRAGMA user_version").get()?.user_version;
        if (version !== 0 && version !== 1 && version !== SCHEMA_VERSION) {
          throw new Error("Unsupported metadata schema");
        }
        if (version === 0) {
          database.exec(`
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
          `);
        }
        if (version === 0 || version === 1) {
          // Additive migration: retain v1 runs/evaluations verbatim. Old summaries
          // lack the new dimensions and are never relabeled as v2 quality reports.
          database.exec(`
            CREATE TABLE evaluation_reports (
              id TEXT PRIMARY KEY NOT NULL,
              schema_version INTEGER NOT NULL CHECK (schema_version = 1),
              evaluator_version TEXT NOT NULL,
              suite TEXT NOT NULL,
              suite_version TEXT NOT NULL,
              suite_digest TEXT NOT NULL,
              sample_digest TEXT NOT NULL,
              recipe_id TEXT NOT NULL,
              recipe_version TEXT NOT NULL,
              requested_model TEXT NOT NULL,
              actual_models TEXT NOT NULL CHECK (json_valid(actual_models)),
              source TEXT NOT NULL CHECK (source IN ('synthetic', 'recorded', 'live')),
              created_at TEXT NOT NULL,
              total_samples INTEGER NOT NULL CHECK (total_samples > 0),
              evaluated_samples INTEGER NOT NULL CHECK (evaluated_samples >= 0),
              failed_samples INTEGER NOT NULL CHECK (failed_samples >= 0),
              metrics TEXT NOT NULL CHECK (json_valid(metrics)),
              errors TEXT NOT NULL CHECK (json_valid(errors)),
              CHECK (evaluated_samples + failed_samples = total_samples)
            ) STRICT;
            CREATE INDEX evaluation_reports_created_at ON evaluation_reports (created_at DESC, id DESC);
            PRAGMA user_version = ${SCHEMA_VERSION};
          `);
        }
        database.exec("COMMIT");
        database.exec("PRAGMA journal_mode = WAL");
        return database;
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
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

  recordReport(record: EvaluationReport): void {
    storageOperation(() => {
      this.assertOpen();
      // Explicit whitelist; extra JS properties can never become a JSON payload.
      const report = parseReport({ schemaVersion: record.schemaVersion, evaluatorVersion: record.evaluatorVersion,
        id: record.id, suite: record.suite, suiteVersion: record.suiteVersion, suiteDigest: record.suiteDigest,
        sampleDigest: record.sampleDigest, recipeId: record.recipeId, recipeVersion: record.recipeVersion,
        requestedModel: record.requestedModel, actualModels: record.actualModels, source: record.source,
        createdAt: record.createdAt, totalSamples: record.totalSamples, evaluatedSamples: record.evaluatedSamples,
        failedSamples: record.failedSamples, metrics: record.metrics, errors: record.errors });
      this.database.prepare(`INSERT INTO evaluation_reports (
        id, schema_version, evaluator_version, suite, suite_version, suite_digest, sample_digest,
        recipe_id, recipe_version, requested_model, actual_models, source, created_at,
        total_samples, evaluated_samples, failed_samples, metrics, errors
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        report.id, report.schemaVersion, report.evaluatorVersion, report.suite, report.suiteVersion,
        report.suiteDigest, report.sampleDigest, report.recipeId, report.recipeVersion, report.requestedModel,
        JSON.stringify(report.actualModels), report.source, report.createdAt, report.totalSamples,
        report.evaluatedSamples, report.failedSamples, JSON.stringify(report.metrics), JSON.stringify(report.errors),
      );
    });
  }

  listReports(limit = 20): EvaluationReport[] {
    return storageOperation(() => {
      this.assertOpen();
      return this.database.prepare(`SELECT id, schema_version AS schemaVersion, evaluator_version AS evaluatorVersion,
        suite, suite_version AS suiteVersion, suite_digest AS suiteDigest, sample_digest AS sampleDigest,
        recipe_id AS recipeId, recipe_version AS recipeVersion, requested_model AS requestedModel,
        actual_models AS actualModels, source, created_at AS createdAt, total_samples AS totalSamples,
        evaluated_samples AS evaluatedSamples, failed_samples AS failedSamples, metrics, errors
        FROM evaluation_reports ORDER BY created_at DESC, id DESC LIMIT ?`).all(checkedLimit(limit)).map(row =>
          parseReport({ ...row, actualModels: JSON.parse(row.actualModels as string) as unknown,
            metrics: JSON.parse(row.metrics as string) as unknown, errors: JSON.parse(row.errors as string) as unknown }));
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
