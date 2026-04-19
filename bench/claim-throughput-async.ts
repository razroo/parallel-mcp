/**
 * Rough throughput bench for the async claim path.
 *
 * Measures claims/sec against an `AsyncParallelMcpStore` with:
 *   - one worker
 *   - N in-process workers sharing one store
 *
 * Defaults to the in-memory `MemoryParallelMcpStore`, which is useful
 * as a ceiling / regression smoke for the orchestrator/worker logic
 * itself without disk or network cost.
 *
 * Optionally targets a live Postgres when `DATABASE_URL` is set and
 * `--store=postgres` is passed — for real comparative numbers.
 *
 * Run with:
 *
 *   npm run bench:claims:async
 *
 * or
 *
 *   npx tsx bench/claim-throughput-async.ts --workers=8 --tasks=10000
 *   DATABASE_URL=postgres://... npx tsx bench/claim-throughput-async.ts --store=postgres
 *
 * Not a regression guard. Absolute numbers depend heavily on machine,
 * Node version, and the async store implementation — use this to
 * sanity-check the effect of claim-path changes on your own box.
 */

import {
  AsyncParallelMcpOrchestrator,
  type AsyncParallelMcpStore,
} from '../src/index.js'

interface BenchOptions {
  tasks: number
  workers: number
  store: 'memory' | 'postgres'
}

function parseArgs(argv: string[]): BenchOptions {
  const opts: BenchOptions = { tasks: 2_000, workers: 4, store: 'memory' }
  for (const arg of argv) {
    const match = /^--(\w+)=(.+)$/.exec(arg)
    if (!match) continue
    const key = match[1]
    const rawValue = match[2]
    if (!key || rawValue === undefined) continue
    if (key === 'store') {
      if (rawValue === 'memory' || rawValue === 'postgres') opts.store = rawValue
      continue
    }
    const value = Number(rawValue)
    if (Number.isNaN(value) || value <= 0) continue
    if (key === 'tasks') opts.tasks = Math.floor(value)
    else if (key === 'workers') opts.workers = Math.floor(value)
  }
  return opts
}

async function buildStore(
  kind: BenchOptions['store'],
): Promise<{ store: AsyncParallelMcpStore; teardown: () => Promise<void> }> {
  if (kind === 'memory') {
    const mod = await import('../adapters/memory/src/store.js')
    const store = new mod.MemoryParallelMcpStore()
    return {
      store,
      teardown: async () => {
        await store.close()
      },
    }
  }

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('--store=postgres requires DATABASE_URL to be set')
  }
  const pgMod = (await import('pg')) as unknown as {
    default: { Pool: new (cfg: { connectionString: string }) => unknown }
  }
  const pg = pgMod.default
  const pool = new pg.Pool({ connectionString: databaseUrl }) as unknown as {
    end(): Promise<void>
  }
  const adapterMod = await import('../adapters/postgres/src/store.js')
  const store = new adapterMod.PostgresParallelMcpStore({
    pool: pool as unknown as import('pg').Pool,
    autoMigrate: true,
  })
  await store.migrate()
  return {
    store,
    teardown: async () => {
      await store.close()
      await pool.end()
    },
  }
}

async function seed(orchestrator: AsyncParallelMcpOrchestrator, taskCount: number): Promise<string> {
  const run = await orchestrator.createRun({ namespace: 'bench-async' })
  for (let i = 0; i < taskCount; i++) {
    await orchestrator.enqueueTask({ runId: run.id, kind: 'bench', priority: 0 })
  }
  return run.id
}

interface RunResult {
  label: string
  durationMs: number
  tasks: number
  claimsPerSec: number
}

async function measureSingleWorker(
  options: BenchOptions,
): Promise<RunResult> {
  const { store, teardown } = await buildStore(options.store)
  try {
    const orchestrator = new AsyncParallelMcpOrchestrator(store, { defaultLeaseMs: 30_000 })
    await seed(orchestrator, options.tasks)

    const start = performance.now()
    let claimed = 0
    while (claimed < options.tasks) {
      const claim = await orchestrator.claimNextTask({ workerId: 'w-0', leaseMs: 30_000 })
      if (!claim) break
      await orchestrator.completeTask({
        taskId: claim.task.id,
        leaseId: claim.lease.id,
        workerId: claim.lease.workerId,
      })
      claimed += 1
    }
    const durationMs = performance.now() - start
    return {
      label: 'single worker',
      durationMs,
      tasks: claimed,
      claimsPerSec: (claimed / durationMs) * 1000,
    }
  } finally {
    await teardown()
  }
}

async function measureMultiWorker(
  options: BenchOptions,
): Promise<RunResult> {
  const { store, teardown } = await buildStore(options.store)
  try {
    const orchestrator = new AsyncParallelMcpOrchestrator(store, { defaultLeaseMs: 30_000 })
    await seed(orchestrator, options.tasks)

    const start = performance.now()
    const claimedPerWorker = new Array(options.workers).fill(0)
    let stopped = false

    await Promise.all(
      Array.from({ length: options.workers }, async (_unused, idx) => {
        const workerId = `w-${idx}`
        while (!stopped) {
          const claim = await orchestrator.claimNextTask({ workerId, leaseMs: 30_000 })
          if (!claim) {
            if (stopped) break
            await new Promise(resolve => setTimeout(resolve, 1))
            continue
          }
          await orchestrator.completeTask({
            taskId: claim.task.id,
            leaseId: claim.lease.id,
            workerId: claim.lease.workerId,
          })
          claimedPerWorker[idx] += 1
          const total = claimedPerWorker.reduce((a: number, b: number) => a + b, 0)
          if (total >= options.tasks) {
            stopped = true
            break
          }
        }
      }),
    )

    const durationMs = performance.now() - start
    const tasks = claimedPerWorker.reduce((a: number, b: number) => a + b, 0)
    return {
      label: `${options.workers} workers`,
      durationMs,
      tasks,
      claimsPerSec: (tasks / durationMs) * 1000,
    }
  } finally {
    await teardown()
  }
}

function formatResult(result: RunResult): string {
  return `${result.label.padEnd(14)} | ${result.tasks.toString().padStart(6)} tasks | ${result.durationMs.toFixed(0).padStart(6)} ms | ${result.claimsPerSec.toFixed(0).padStart(6)} claims/sec`
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  console.log(`parallel-mcp async claim throughput bench`)
  console.log(`  store=${options.store} tasks=${options.tasks} workers=${options.workers}`)
  console.log()

  const single = await measureSingleWorker(options)
  console.log(formatResult(single))

  const multi = await measureMultiWorker(options)
  console.log(formatResult(multi))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
