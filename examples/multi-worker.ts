/**
 * multi-worker — a realistic multi-process setup in one script:
 *
 *   - One shared SQLite file (not `:memory:`) so every worker sees the same
 *     durable state. If you cared about running this across actual separate
 *     processes, each process would just open its own SqliteParallelMcpStore
 *     at the same filename.
 *   - Eight concurrent workers for two task kinds (`image` and `summary`).
 *     Only the `image` workers declare `kinds: ['image']`; the generic ones
 *     accept any kind.
 *   - One dedicated `scheduleExpireLeases` maintenance loop so the other
 *     workers can pass `expireLeasesOnPoll: false` and stay on the hot path.
 *   - A single shutdown controller wires `Ctrl-C` through to every worker
 *     plus the sweeper, and we drain them all concurrently.
 *
 * The script enqueues 40 tasks, prints a small progress report as they
 * complete, and exits cleanly when the run reaches a terminal status.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ParallelMcpOrchestrator,
  SqliteParallelMcpStore,
  runWorker,
  scheduleExpireLeases,
  type EventRecord,
  type WorkerHandle,
} from '../src/index.js'

const tmp = mkdtempSync(join(tmpdir(), 'parallel-mcp-multi-'))
const dbPath = join(tmp, 'run.sqlite')

const store = new SqliteParallelMcpStore({ filename: dbPath })
const orchestrator = new ParallelMcpOrchestrator(store, {
  defaultLeaseMs: 1_500,
  onEvent: (event: EventRecord) => {
    if (event.eventType === 'task.completed' || event.eventType === 'task.failed') {
      console.log(`[event] ${event.eventType} task=${event.taskId?.slice(0, 8)}`)
    } else if (event.eventType === 'run.status.changed') {
      const payload = event.payload as { from: string; to: string }
      console.log(`[event] run ${event.runId.slice(0, 8)} ${payload.from} → ${payload.to}`)
    }
  },
})

const run = orchestrator.createRun({ namespace: 'examples.multi-worker' })

const TOTAL = 40
for (let i = 0; i < TOTAL; i += 1) {
  const kind = i % 4 === 0 ? 'summary' : 'image'
  orchestrator.enqueueTask({
    runId: run.id,
    kind,
    input: { idx: i },
    maxAttempts: 3,
    retry: { delayMs: 50, backoff: 'exponential', maxDelayMs: 500 },
  })
}

console.log(`Enqueued ${TOTAL} tasks on run ${run.id} (db=${dbPath})`)

const shutdown = new AbortController()
process.once('SIGINT', () => shutdown.abort())
process.once('SIGTERM', () => shutdown.abort())

const sweeper = scheduleExpireLeases({
  orchestrator,
  intervalMs: 250,
  signal: shutdown.signal,
  onError: error => console.error('[sweeper]', error),
  onTick: result => {
    if (result.count > 0) {
      console.log(`[sweeper] expired ${result.count} lease(s)`)
    }
  },
})

const workers: WorkerHandle[] = []
const IMAGE_WORKERS = 4
const GENERIC_WORKERS = 4

const sharedOpts = {
  orchestrator,
  signal: shutdown.signal,
  pollIntervalMs: 5,
  idleBackoffMs: 20,
  idleMaxBackoffMs: 200,
  drainTimeoutMs: 500,
  expireLeasesOnPoll: false,
} as const

for (let i = 0; i < IMAGE_WORKERS; i += 1) {
  const workerId = `image-${i + 1}`
  workers.push(runWorker({
    ...sharedOpts,
    workerId,
    kinds: ['image'],
    handler: async ({ task }) => {
      const latency = 10 + Math.floor(Math.random() * 40)
      await new Promise(resolve => setTimeout(resolve, latency))
      if (Math.random() < 0.1) {
        return { status: 'failed', error: 'transient image error' }
      }
      return { status: 'completed', output: { idx: (task.input as { idx: number }).idx, workerId } }
    },
    onError: (error, task) =>
      console.error(`[${workerId}] error on task=${task?.id.slice(0, 8) ?? '-'}:`, error),
  }))
}

for (let i = 0; i < GENERIC_WORKERS; i += 1) {
  const workerId = `generic-${i + 1}`
  workers.push(runWorker({
    ...sharedOpts,
    workerId,
    handler: async ({ task }) => {
      const latency = 5 + Math.floor(Math.random() * 25)
      await new Promise(resolve => setTimeout(resolve, latency))
      return { status: 'completed', output: { idx: (task.input as { idx: number }).idx, workerId } }
    },
    onError: (error, task) =>
      console.error(`[${workerId}] error on task=${task?.id.slice(0, 8) ?? '-'}:`, error),
  }))
}

async function waitForTerminal(): Promise<void> {
  while (!shutdown.signal.aborted) {
    const current = orchestrator.getRun(run.id)
    if (current && ['completed', 'failed', 'cancelled'].includes(current.status)) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

await waitForTerminal()

for (const worker of workers) worker.stop()
await Promise.all(workers.map(worker => worker.stopped))
sweeper.stop()
await sweeper.stopped

const tasks = orchestrator.listRunTasks(run.id)
const byWorker = new Map<string, number>()
for (const task of tasks) {
  if (task.status !== 'completed' || !task.output) continue
  const workerId = (task.output as { workerId?: string }).workerId ?? '?'
  byWorker.set(workerId, (byWorker.get(workerId) ?? 0) + 1)
}

console.log('\n== Per-worker completions ==')
for (const [workerId, count] of [...byWorker.entries()].sort()) {
  console.log(`  ${workerId.padEnd(12)} ${count}`)
}

console.log('\n== Run summary ==')
const finalRun = orchestrator.getRun(run.id)
console.log(`run status:        ${finalRun?.status}`)
console.log(`tasks completed:   ${tasks.filter(t => t.status === 'completed').length}/${tasks.length}`)
console.log(`tasks failed:      ${tasks.filter(t => t.status === 'failed').length}`)

orchestrator.close()
rmSync(tmp, { recursive: true, force: true })
