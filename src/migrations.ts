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
