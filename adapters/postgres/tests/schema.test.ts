import { describe, expect, it } from 'vitest'
import { POSTGRES_SCHEMA, PostgresParallelMcpStore } from '../src/index.js'

describe('POSTGRES_SCHEMA', () => {
  it('includes every core table', () => {
    const expected = [
      'runs',
      'tasks',
      'task_dependencies',
      'task_attempts',
      'task_leases',
      'context_snapshots',
      'events',
      'task_completions',
    ]
    for (const table of expected) {
      expect(POSTGRES_SCHEMA).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
  })

  it('uses JSONB for every JSON payload column', () => {
    expect(POSTGRES_SCHEMA).toMatch(/payload JSONB NOT NULL/)
    expect(POSTGRES_SCHEMA).toMatch(/input JSONB,/)
    expect(POSTGRES_SCHEMA).toMatch(/output JSONB,/)
  })

  it('uses BIGSERIAL for the events cursor', () => {
    expect(POSTGRES_SCHEMA).toContain('id BIGSERIAL PRIMARY KEY')
  })

  it('includes the timeout_ms and dead columns on tasks', () => {
    expect(POSTGRES_SCHEMA).toContain('timeout_ms INTEGER')
    expect(POSTGRES_SCHEMA).toContain('dead BOOLEAN NOT NULL DEFAULT FALSE')
    expect(POSTGRES_SCHEMA).toContain('pmcp_tasks_dead_idx')
  })
})

describe('PostgresParallelMcpStore (wiring)', () => {
  it('supports addEventListener attach + detach without a live pool', () => {
    const store = new PostgresParallelMcpStore({ pool: {} as never })
    let count = 0
    const detach = store.addEventListener(() => { count += 1 })
    detach()
    void store.close()
    expect(count).toBe(0)
  })
})
