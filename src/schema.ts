export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  namespace TEXT,
  external_id TEXT,
  status TEXT NOT NULL,
  metadata TEXT,
  current_context_snapshot_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_key TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL,
  max_attempts INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  retry_delay_ms INTEGER,
  retry_backoff TEXT,
  retry_max_delay_ms INTEGER,
  timeout_ms INTEGER,
  not_before TEXT,
  input TEXT,
  output TEXT,
  metadata TEXT,
  error TEXT,
  context_snapshot_id TEXT,
  lease_id TEXT,
  leased_by TEXT,
  lease_expires_at TEXT,
  dead INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS tasks_run_key_unique
  ON tasks(run_id, task_key)
  WHERE task_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS tasks_run_status_idx ON tasks(run_id, status);
CREATE INDEX IF NOT EXISTS tasks_claim_idx ON tasks(status, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS tasks_dead_idx ON tasks(dead) WHERE dead = 1;

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY(task_id, depends_on_task_id)
);

CREATE INDEX IF NOT EXISTS task_dependencies_task_idx ON task_dependencies(task_id);

CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL,
  leased_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  lease_expires_at TEXT NOT NULL,
  error TEXT,
  output TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS task_attempts_task_idx ON task_attempts(task_id);

CREATE TABLE IF NOT EXISTS task_leases (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  heartbeat_at TEXT,
  released_at TEXT,
  client_token TEXT
);

CREATE INDEX IF NOT EXISTS task_leases_task_idx ON task_leases(task_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS task_leases_client_token_unique
  ON task_leases(client_token)
  WHERE client_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_completions (
  client_token TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS task_completions_task_idx ON task_completions(task_id);

CREATE TABLE IF NOT EXISTS context_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  scope TEXT NOT NULL,
  parent_snapshot_id TEXT REFERENCES context_snapshots(id) ON DELETE SET NULL,
  label TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS context_snapshots_run_idx ON context_snapshots(run_id, created_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_run_idx ON events(run_id, id);
`
