/**
 * Rough throughput bench for the claim path.
 *
 * Measures:
 *   - claims/sec with a single worker against a disk-backed sqlite file
 *   - claims/sec with N in-process workers sharing the same file
 *
 * Not a regression guard. This is here so you can sanity-check the effect of
 * changes to the claim path on your machine. Run with:
 *
 *   npm run bench:claims
 *
 * or
 *
 *   npx tsx bench/claim-throughput.ts --workers=4 --tasks=5000
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ParallelMcpOrchestrator,
  SqliteParallelMcpStore,
} from '../src/index.js'

interface BenchOptions {
  tasks: number
  workers: number
  busyTimeoutMs: number
}

function parseArgs(argv: string[]): BenchOptions {
  const opts: BenchOptions = { tasks: 2_000, workers: 4, busyTimeoutMs: 5_000 }
  for (const arg of argv) {
    const match = /^--(\w+)=(.+)$/.exec(arg)
    if (!match) continue
    const key = match[1]
    const rawValue = match[2]
    if (!key || rawValue === undefined) continue
    const value = Number(rawValue)
    if (Number.isNaN(value) || value <= 0) continue
    if (key === 'tasks') opts.tasks = Math.floor(value)
    else if (key === 'workers') opts.workers = Math.floor(value)
    else if (key === 'busyTimeoutMs') opts.busyTimeoutMs = Math.floor(value)
  }
  return opts
}

function seed(orchestrator: ParallelMcpOrchestrator, taskCount: number): string {
  const run = orchestrator.createRun({ namespace: 'bench' })
  orchestrator.transaction(() => {
    for (let i = 0; i < taskCount; i++) {
      orchestrator.enqueueTask({ runId: run.id, kind: 'bench', priority: 0 })
    }
  })
  return run.id
}

interface RunResult {
  label: string
  durationMs: number
  tasks: number
  claimsPerSec: number
}

function measureSingleWorker(dbPath: string, options: BenchOptions): RunResult {
  const store = new SqliteParallelMcpStore({ filename: dbPath, busyTimeoutMs: options.busyTimeoutMs })
  const orchestrator = new ParallelMcpOrchestrator(store, { defaultLeaseMs: 30_000 })
  seed(orchestrator, options.tasks)

  const start = performance.now()
  let claimed = 0
  while (claimed < options.tasks) {
    const claim = orchestrator.claimNextTask({ workerId: 'w-0', leaseMs: 30_000 })
    if (!claim) break
    orchestrator.completeTask({
      taskId: claim.task.id,
      leaseId: claim.lease.id,
      workerId: claim.lease.workerId,
    })
    claimed += 1
  }
  const durationMs = performance.now() - start
  orchestrator.close()

  return {
    label: 'single worker',
    durationMs,
    tasks: claimed,
    claimsPerSec: (claimed / durationMs) * 1000,
  }
}

async function measureMultiWorker(dbPath: string, options: BenchOptions): Promise<RunResult> {
  const seedStore = new SqliteParallelMcpStore({ filename: dbPath, busyTimeoutMs: options.busyTimeoutMs })
  const seedOrch = new ParallelMcpOrchestrator(seedStore, { defaultLeaseMs: 30_000 })
  seed(seedOrch, options.tasks)
  seedOrch.close()

  const workers = Array.from({ length: options.workers }, (_, i) => {
    const store = new SqliteParallelMcpStore({ filename: dbPath, busyTimeoutMs: options.busyTimeoutMs })
    const orchestrator = new ParallelMcpOrchestrator(store, { defaultLeaseMs: 30_000 })
    return { id: `w-${i}`, orchestrator }
  })

  const start = performance.now()
  const claimedPerWorker = new Array(options.workers).fill(0)
  let stopped = false

  await Promise.all(
    workers.map(async (worker, idx) => {
      while (!stopped) {
        try {
          const claim = worker.orchestrator.claimNextTask({ workerId: worker.id, leaseMs: 30_000 })
          if (!claim) {
            if (stopped) break
            await new Promise(resolve => setTimeout(resolve, 1))
            continue
          }
          worker.orchestrator.completeTask({
            taskId: claim.task.id,
            leaseId: claim.lease.id,
            workerId: claim.lease.workerId,
          })
          claimedPerWorker[idx] += 1
          const total = claimedPerWorker.reduce((a, b) => a + b, 0)
          if (total >= options.tasks) {
            stopped = true
            break
          }
        } catch (err) {
          if (err instanceof Error && /SQLITE_BUSY/.test(err.message)) continue
          throw err
        }
      }
    }),
  )

  const durationMs = performance.now() - start

  for (const worker of workers) worker.orchestrator.close()

  const tasks = claimedPerWorker.reduce((a, b) => a + b, 0)
  return {
    label: `${options.workers} workers`,
    durationMs,
    tasks,
    claimsPerSec: (tasks / durationMs) * 1000,
    ...({ perWorker: claimedPerWorker } as object),
  }
}

function formatResult(result: RunResult): string {
  return `${result.label.padEnd(14)} | ${result.tasks.toString().padStart(6)} tasks | ${result.durationMs.toFixed(0).padStart(6)} ms | ${result.claimsPerSec.toFixed(0).padStart(6)} claims/sec`
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  console.log(`parallel-mcp claim throughput bench`)
  console.log(`  tasks=${options.tasks} workers=${options.workers} busyTimeoutMs=${options.busyTimeoutMs}`)
  console.log()

  const tmp = mkdtempSync(join(tmpdir(), 'parallel-mcp-bench-'))

  try {
    const singleDb = join(tmp, 'single.sqlite')
    const single = measureSingleWorker(singleDb, options)
    console.log(formatResult(single))

    const multiDb = join(tmp, 'multi.sqlite')
    const multi = await measureMultiWorker(multiDb, options)
    console.log(formatResult(multi))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
