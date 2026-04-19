import type Database from 'better-sqlite3'
import { SCHEMA_SQL } from './schema.js'

export interface Migration {
  id: number
  name: string
  up: (db: Database.Database) => void
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial_schema',
    up: db => {
      db.exec(SCHEMA_SQL)
    },
  },
  {
    id: 2,
    name: 'tasks_retry_policy_columns',
    up: db => {
      const columns = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>
      const existing = new Set(columns.map(column => column.name))
      const additions: Array<[string, string]> = [
        ['retry_delay_ms', 'INTEGER'],
        ['retry_backoff', 'TEXT'],
        ['retry_max_delay_ms', 'INTEGER'],
        ['not_before', 'TEXT'],
      ]
      for (const [name, type] of additions) {
        if (!existing.has(name)) {
          db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`)
        }
      }
    },
  },
  {
    id: 3,
    name: 'leases_client_token_idempotency',
    up: db => {
      const leaseCols = db.prepare(`PRAGMA table_info(task_leases)`).all() as Array<{ name: string }>
      if (!leaseCols.some(column => column.name === 'client_token')) {
        db.exec(`ALTER TABLE task_leases ADD COLUMN client_token TEXT`)
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS task_leases_client_token_unique
          ON task_leases(client_token)
          WHERE client_token IS NOT NULL
      `)

      const completionsExists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_completions'`)
        .get()
      if (!completionsExists) {
        db.exec(`
          CREATE TABLE task_completions (
            client_token TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            outcome TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS task_completions_task_idx ON task_completions(task_id);
        `)
      }
    },
  },
  {
    id: 4,
    name: 'tasks_timeout_and_dead_letter',
    up: db => {
      const columns = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>
      const existing = new Set(columns.map(column => column.name))
      if (!existing.has('timeout_ms')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN timeout_ms INTEGER`)
      }
      if (!existing.has('dead')) {
        db.exec(`ALTER TABLE tasks ADD COLUMN dead INTEGER NOT NULL DEFAULT 0`)
      }
      db.exec(`CREATE INDEX IF NOT EXISTS tasks_dead_idx ON tasks(dead) WHERE dead = 1`)
    },
  },
]

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `)

  const applied = new Set(
    (db.prepare(`SELECT id FROM schema_migrations`).all() as Array<{ id: number }>).map(row => row.id),
  )

  const record = db.prepare(`
    INSERT INTO schema_migrations (id, name, applied_at)
    VALUES (?, ?, ?)
  `)

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue
    db.transaction(() => {
      migration.up(db)
      record.run(migration.id, migration.name, new Date().toISOString())
    })()
  }
}
