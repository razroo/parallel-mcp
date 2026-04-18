import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS, runMigrations } from '../src/migrations.js'
import { SqliteParallelMcpStore, ParallelMcpOrchestrator } from '../src/index.js'

function seedV1(db: Database.Database): void {
  const v1 = MIGRATIONS.find(migration => migration.id === 1)!
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`)
  db.transaction(() => {
    v1.up(db)
    db.prepare(`INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)`)
      .run(1, v1.name, new Date().toISOString())
  })()
}

describe('runMigrations', () => {
  it('adds retry policy columns when upgrading v1 -> v2 without dropping existing rows', () => {
    const db = new Database(':memory:')
    seedV1(db)

    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO runs (id, namespace, external_id, status, metadata, current_context_snapshot_id, created_at, updated_at)
      VALUES ('run-1', 'legacy', NULL, 'pending', NULL, NULL, ?, ?)
    `).run(now, now)
    db.prepare(`
      INSERT INTO tasks (
        id, run_id, task_key, kind, status, priority, max_attempts, attempt_count,
        input, output, metadata, error, context_snapshot_id, lease_id, leased_by, lease_expires_at,
        created_at, updated_at, started_at, completed_at
      )
      VALUES ('task-1', 'run-1', NULL, 'work', 'queued', 0, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)
    `).run(now, now)

    runMigrations(db)

    const columns = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>
    const names = columns.map(column => column.name)
    expect(names).toContain('retry_delay_ms')
    expect(names).toContain('retry_backoff')
    expect(names).toContain('retry_max_delay_ms')
    expect(names).toContain('not_before')

    const row = db.prepare(`SELECT id, kind, retry_delay_ms, not_before FROM tasks WHERE id = 'task-1'`).get() as {
      id: string
      kind: string
      retry_delay_ms: number | null
      not_before: string | null
    }
    expect(row.id).toBe('task-1')
    expect(row.kind).toBe('work')
    expect(row.retry_delay_ms).toBeNull()
    expect(row.not_before).toBeNull()

    db.close()
  })

  it('adds client_token + task_completions when upgrading v1 -> v3 without data loss', () => {
    const db = new Database(':memory:')
    seedV1(db)

    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO runs (id, namespace, external_id, status, metadata, current_context_snapshot_id, created_at, updated_at)
      VALUES ('run-1', 'legacy', NULL, 'pending', NULL, NULL, ?, ?)
    `).run(now, now)
    db.prepare(`
      INSERT INTO tasks (
        id, run_id, task_key, kind, status, priority, max_attempts, attempt_count,
        input, output, metadata, error, context_snapshot_id, lease_id, leased_by, lease_expires_at,
        created_at, updated_at, started_at, completed_at
      )
      VALUES ('task-1', 'run-1', NULL, 'work', 'queued', 0, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)
    `).run(now, now)

    runMigrations(db)

    const leaseCols = (db.prepare(`PRAGMA table_info(task_leases)`).all() as Array<{ name: string }>)
      .map(column => column.name)
    expect(leaseCols).toContain('client_token')

    const completionsExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_completions'`)
      .get()
    expect(completionsExists).toBeDefined()

    const remaining = db.prepare(`SELECT id FROM tasks`).all() as Array<{ id: string }>
    expect(remaining.map(row => row.id)).toEqual(['task-1'])

    db.close()
  })

  it('is idempotent: applying all migrations twice is a no-op', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    const firstIds = (db.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as Array<{ id: number }>)
      .map(row => row.id)

    runMigrations(db)
    const secondIds = (db.prepare(`SELECT id FROM schema_migrations ORDER BY id`).all() as Array<{ id: number }>)
      .map(row => row.id)

    expect(secondIds).toEqual(firstIds)
    expect(firstIds).toEqual(MIGRATIONS.map(migration => migration.id))
    db.close()
  })

  it('a fresh SqliteParallelMcpStore supports the v3 feature set end-to-end', () => {
    const orchestrator = new ParallelMcpOrchestrator(new SqliteParallelMcpStore({ filename: ':memory:' }))
    const run = orchestrator.createRun({ namespace: 'fresh' })
    orchestrator.enqueueTask({ runId: run.id, kind: 'work', retry: { delayMs: 10, backoff: 'exponential' } })

    const claim = orchestrator.claimNextTask({ workerId: 'w', clientToken: 'fresh-token' })
    expect(claim).not.toBeNull()
    expect(claim!.lease.clientToken).toBe('fresh-token')

    const again = orchestrator.claimNextTask({ workerId: 'w', clientToken: 'fresh-token' })
    expect(again!.lease.id).toBe(claim!.lease.id)

    orchestrator.close()
  })
})
