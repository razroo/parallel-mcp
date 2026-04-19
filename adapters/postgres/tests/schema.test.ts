import { describe, expect, it } from 'vitest'
import { POSTGRES_SCHEMA, PostgresParallelMcpStore, NotImplementedError } from '../src/index.js'

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
      'client_completions',
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
})

describe('PostgresParallelMcpStore (alpha scaffold)', () => {
  it('throws NotImplementedError from every unfinished method', () => {
    const store = new PostgresParallelMcpStore({
      // Not a real pool — we never actually call it in this assertion
      // because every op throws before touching the pool.
      pool: {} as never,
    })

    expect(() => store.createRun({})).toThrow(NotImplementedError)
    expect(() => store.getRun('x')).toThrow(NotImplementedError)
    expect(() => store.listRuns()).toThrow(NotImplementedError)
    expect(() => store.transaction(() => 1)).toThrow(NotImplementedError)
  })

  it('supports addEventListener wiring regardless of method stubs', () => {
    const store = new PostgresParallelMcpStore({ pool: {} as never })
    let count = 0
    const detach = store.addEventListener(() => { count += 1 })
    detach()
    store.close()
    expect(count).toBe(0)
  })
})
