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
INSERT INTO runs VALUES ('legacy-run', 'rank-candidates', '1.0.0', 'requested-v1', 'actual-v1',
  '2026-10-19T01:00:00.000Z', 12, 'success', 2, 10, NULL, 'legacy-request', NULL);
INSERT INTO evaluations VALUES ('legacy-eval', 'legacy-suite', 'rank-candidates', '1.0.0',
  'legacy-model', '2026-10-19T01:00:00.000Z', 3, 2);
PRAGMA user_version = 1;
