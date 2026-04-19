import { AsyncParallelMcpOrchestrator } from '@razroo/parallel-mcp'
import { runAsyncConformanceSuite } from '@razroo/parallel-mcp-testkit'
import { describe, it } from 'vitest'
import pg from 'pg'
import { PostgresParallelMcpStore } from '../src/index.js'

/**
 * Live Postgres conformance run. Only executes when `DATABASE_URL` is set
 * so CI without a pg service can still pass. To run locally:
 *
 *   docker run --rm -d --name pmcp-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:postgres
 *
 * Each test gets its own schema so cases cannot contaminate one another.
 */
const url = process.env.DATABASE_URL

if (url) {
  runAsyncConformanceSuite({
    label: 'postgres (live adapter)',
    createOrchestrator: async () => {
      const schema = `pmcp_test_${Math.random().toString(36).slice(2, 10)}`
      const admin = new pg.Pool({ connectionString: url, max: 1 })
      await admin.query(`CREATE SCHEMA ${schema}`)
      await admin.end()

      const pool = new pg.Pool({ connectionString: url, max: 4 })
      pool.on('connect', client => {
        void client.query(`SET search_path TO ${schema}, public`)
      })

      const store = new PostgresParallelMcpStore({ pool, autoMigrate: true })
      await store.migrate()

      const orchestrator = new AsyncParallelMcpOrchestrator(store, { defaultLeaseMs: 500 })

      return {
        orchestrator,
        async cleanup() {
          await orchestrator.close()
          await pool.end()
          const dropper = new pg.Pool({ connectionString: url, max: 1 })
          await dropper.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
          await dropper.end()
        },
      }
    },
  })
} else {
  describe.skip('postgres live conformance (DATABASE_URL not set)', () => {
    it('skipped', () => { /* no-op */ })
  })
}
