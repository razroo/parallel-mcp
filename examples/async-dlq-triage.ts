/**
 * Async fan-out + dead-letter triage demo.
 *
 * Exercises the 0.4.0 async surface end-to-end:
 *
 *   1. `AsyncParallelMcpOrchestrator` on top of `MemoryParallelMcpStore`
 *      (zero-dep, zero-setup async adapter — swap for
 *      `PostgresParallelMcpStore` in production).
 *   2. A hand-rolled async worker loop. `runWorker` is currently sync-only
 *      (see README — a `runAsyncWorker` is on the roadmap), so async
 *      callers own the claim / complete / fail cycle until then.
 *   3. Dead-letter queue. Tasks that exhaust `maxAttempts` are parked,
 *      surfaced through `listDeadTasks`, and revived with
 *      `requeueDeadTask`, which emits `task.requeued_from_dlq`.
 *
 * For a per-attempt `timeoutMs` + `AbortSignal` walkthrough, see the
 * sync `examples/retry-and-resume.ts` + `runWorker`. The async
 * equivalent is the same API on `AsyncParallelMcpOrchestrator.enqueueTask`.
 */
import {
  AsyncParallelMcpOrchestrator,
  type EventRecord,
  type JsonValue,
  type TaskLeaseRecord,
  type TaskRecord,
} from '../src/index.js'
import { MemoryParallelMcpStore } from '../adapters/memory/src/store.js'

const store = new MemoryParallelMcpStore()

// Short leases so the dead-letter demo doesn't take minutes. In real use
// prefer seconds-to-minutes; this is just a demo.
const orchestrator = new AsyncParallelMcpOrchestrator(store, {
  defaultLeaseMs: 200,
  onEvent: (event: EventRecord) => {
    if (
      event.eventType === 'task.dead_lettered' ||
      event.eventType === 'task.requeued_from_dlq' ||
      event.eventType === 'task.failed' ||
      event.eventType === 'task.completed' ||
      event.eventType === 'run.status.changed'
    ) {
      const taskId = event.taskId?.slice(0, 8) ?? '-'
      console.log(`[event] ${event.eventType} task=${taskId}`)
    }
  },
})

const run = await orchestrator.createRun({
  namespace: 'examples.async-dlq-triage',
  context: { project: 'demo' },
})

// Two happy tasks, one poison task that always throws. The poison task
// burns through its `maxAttempts` budget and lands in the DLQ.
await orchestrator.enqueueTask({
  runId: run.id,
  kind: 'render',
  key: 'render:happy-1',
  input: { label: 'happy-1' },
  maxAttempts: 3,
})

await orchestrator.enqueueTask({
  runId: run.id,
  kind: 'render',
  key: 'render:happy-2',
  input: { label: 'happy-2' },
  maxAttempts: 3,
})

await orchestrator.enqueueTask({
  runId: run.id,
  kind: 'render',
  key: 'render:poison',
  input: { label: 'poison' },
  maxAttempts: 2,
})

console.log(`Enqueued 3 tasks on run ${run.id}`)

type HandlerOutcome =
  | { kind: 'completed'; output: JsonValue }
  | { kind: 'crash' }

type Handler = (task: TaskRecord) => Promise<HandlerOutcome>

const handler: Handler = async task => {
  const input = task.input as { label?: string } | null
  if (input?.label === 'poison') {
    // Simulate a worker that claimed the task, then crashed mid-handler
    // without reporting back. The lease will expire and attempt budget
    // will get consumed. Once attempts are exhausted, the task is moved
    // to the dead-letter queue.
    return { kind: 'crash' }
  }
  await new Promise(resolve => setTimeout(resolve, 10))
  const output: JsonValue = { label: input?.label ?? null }
  return { kind: 'completed', output }
}

async function asyncWorker(workerId: string, stopRef: { stop: boolean }): Promise<void> {
  while (!stopRef.stop) {
    await orchestrator.expireLeases()
    const claim = await orchestrator.claimNextTask({ workerId, kinds: ['render'] })
    if (!claim) {
      await new Promise(resolve => setTimeout(resolve, 20))
      continue
    }
    const { task, lease }: { task: TaskRecord; lease: TaskLeaseRecord } = claim
    await orchestrator.markTaskRunning({
      taskId: task.id,
      leaseId: lease.id,
      workerId: lease.workerId,
    })
    const outcome = await handler(task)
    if (outcome.kind === 'completed') {
      await orchestrator.completeTask({
        taskId: task.id,
        leaseId: lease.id,
        workerId: lease.workerId,
        output: outcome.output,
      })
    }
    // crash path: intentionally leave the lease to expire. A dedicated
    // sweeper (`scheduleExpireLeases`-equivalent) would also work.
  }
}

const stopRef = { stop: false }
const workers = [asyncWorker('worker-1', stopRef), asyncWorker('worker-2', stopRef)]

async function waitForDeadLetters(expected: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const dead = await orchestrator.listDeadTasks({ runId: run.id })
    if (dead.length >= expected) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

await waitForDeadLetters(1, 5_000)

console.log('\n== Dead-letter queue ==')
const dead = await orchestrator.listDeadTasks({ runId: run.id })
for (const task of dead) {
  console.log(
    `  ${task.id.slice(0, 8)} kind=${task.kind} attempts=${task.attemptCount}/${
      task.maxAttempts
    } error=${task.error ?? '-'}`,
  )
}

// Operator chooses to replay the poison task once the upstream fix is
// in. `requeueDeadTask` resets attemptCount to 0 and emits
// `task.requeued_from_dlq`.
const poisonDead = dead.find(t => (t.input as { label?: string } | null)?.label === 'poison')
if (poisonDead) {
  console.log(`\nRequeueing ${poisonDead.id.slice(0, 8)} with operator note`)
  await orchestrator.requeueDeadTask({
    taskId: poisonDead.id,
    reason: 'operator replay: upstream bug fixed',
  })
}

// Drain: wait until no non-terminal, non-dead tasks remain.
const deadline = Date.now() + 5_000
while (Date.now() < deadline) {
  const tasks = await orchestrator.listRunTasks(run.id)
  const open = tasks.filter(t => !t.dead && !['completed', 'failed', 'cancelled'].includes(t.status))
  if (open.length === 0) break
  await new Promise(resolve => setTimeout(resolve, 50))
}

stopRef.stop = true
await Promise.all(workers)

console.log('\n== Run summary ==')
const tasks = await orchestrator.listRunTasks(run.id)
console.log(`tasks total:    ${tasks.length}`)
console.log(`completed:      ${tasks.filter(t => t.status === 'completed').length}`)
console.log(`failed:         ${tasks.filter(t => t.status === 'failed').length}`)
console.log(`dead-lettered:  ${tasks.filter(t => t.dead).length}`)

await store.close()
