/**
 * Postgres schema for `@razroo/parallel-mcp`. Port of the SQLite schema at
 * `../../src/schema.ts` with the expected idiomatic differences:
 *
 *   - `TEXT` stays `TEXT` (Postgres has no `VARCHAR(255)` performance hit).
 *   - `JSON` columns become `JSONB`.
 *   - `BIGSERIAL` for `events.id` (monotonic event cursor).
 *   - `TIMESTAMPTZ` for every timestamp.
 *   - Indexes named with a `pmcp_` prefix so they're easy to find.
 *
 * This file is intentionally a single string constant so consumers can do
 * `await pool.query(POSTGRES_SCHEMA)` during bootstrapping, or pipe it
 * through a migration tool. For production you will almost certainly want
 * something like `node-pg-migrate` or `drizzle-kit` managing this, but the
 * canonical shape lives here.
 *
 * Columns track the current SQLite schema exactly, including `timeout_ms`
 * and `dead` on `tasks` added in core v0.4.
 */
export const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  namespace TEXT,
  external_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','active','waiting','completed','failed','cancelled')),
  metadata JSONB,
  current_context_snapshot_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS pmcp_runs_namespace_status_idx
  ON runs (namespace, status);

CREATE INDEX IF NOT EXISTS pmcp_runs_updated_at_idx
  ON runs (updated_at);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_key TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'queued','leased','running','blocked','waiting_input',
    'completed','failed','cancelled'
  )),
  priority INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  retry_delay_ms INTEGER,
  retry_backoff TEXT CHECK (retry_backoff IN ('fixed','exponential')),
  retry_max_delay_ms INTEGER,
  timeout_ms INTEGER,
  not_before TIMESTAMPTZ,
  input JSONB,
  output JSONB,
  metadata JSONB,
  error TEXT,
  context_snapshot_id TEXT,
  lease_id TEXT,
  leased_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  dead BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (run_id, task_key)
);

CREATE INDEX IF NOT EXISTS pmcp_tasks_run_status_idx
  ON tasks (run_id, status);

CREATE INDEX IF NOT EXISTS pmcp_tasks_status_kind_idx
  ON tasks (status, kind);

CREATE INDEX IF NOT EXISTS pmcp_tasks_not_before_idx
  ON tasks (status, not_before);

CREATE INDEX IF NOT EXISTS pmcp_tasks_claim_idx
  ON tasks (status, priority DESC, created_at ASC);

CREATE INDEX IF NOT EXISTS pmcp_tasks_dead_idx
  ON tasks (dead) WHERE dead;

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE INDEX IF NOT EXISTS pmcp_task_dependencies_dep_idx
  ON task_dependencies (depends_on_task_id);

CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'leased','running','completed','failed','expired','released','cancelled'
  )),
  leased_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  error TEXT,
  output JSONB,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS pmcp_task_attempts_task_idx
  ON task_attempts (task_id, leased_at DESC);

CREATE TABLE IF NOT EXISTS task_leases (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','expired','released','cancelled')),
  acquired_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  client_token TEXT
);

CREATE INDEX IF NOT EXISTS pmcp_task_leases_active_idx
  ON task_leases (task_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS pmcp_task_leases_expires_idx
  ON task_leases (expires_at) WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS pmcp_task_leases_client_token_unique
  ON task_leases (client_token) WHERE client_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_completions (
  client_token TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed','failed')),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS pmcp_task_completions_task_idx
  ON task_completions (task_id);

CREATE TABLE IF NOT EXISTS context_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('run','task')),
  parent_snapshot_id TEXT REFERENCES context_snapshots(id) ON DELETE SET NULL,
  label TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS pmcp_context_snapshots_run_idx
  ON context_snapshots (run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES task_attempts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS pmcp_events_run_id_idx
  ON events (run_id, id);

CREATE INDEX IF NOT EXISTS pmcp_events_id_idx
  ON events (id);
`
