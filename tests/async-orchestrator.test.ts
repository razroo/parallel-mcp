import { afterEach, describe, expect, it } from 'vitest'
import {
  AsyncParallelMcpOrchestrator,
  SqliteParallelMcpStore,
  toAsyncStore,
} from '../src/index.js'

function createAsyncOrchestrator(): AsyncParallelMcpOrchestrator {
  return new AsyncParallelMcpOrchestrator(toAsyncStore(new SqliteParallelMcpStore({ filename: ':memory:' })), {
    defaultLeaseMs: 1_000,
  })
}

describe('AsyncParallelMcpOrchestrator against the sync-to-async bridge', () => {
  const instances: AsyncParallelMcpOrchestrator[] = []

  afterEach(async () => {
    while (instances.length > 0) {
      await instances.pop()?.close()
    }
  })

  it('creates a run and enqueues a task', async () => {
    const orchestrator = createAsyncOrchestrator()
    instances.push(orchestrator)

    const run = await orchestrator.createRun({ namespace: 'async' })
    const task = await orchestrator.enqueueTask({ runId: run.id, kind: 'work', input: { n: 1 } })

    expect(await orchestrator.getRun(run.id)).not.toBeNull()
    expect((await orchestrator.getTask(task.id))?.kind).toBe('work')
  })

  it('claims, completes, and surfaces the final task/run state', async () => {
    const orchestrator = createAsyncOrchestrator()
    instances.push(orchestrator)

    const run = await orchestrator.createRun({ namespace: 'async-claim' })
    const task = await orchestrator.enqueueTask({ runId: run.id, kind: 'work' })

    const claim = await orchestrator.claimNextTask({ workerId: 'w', leaseMs: 10_000 })
    expect(claim).not.toBeNull()
    await orchestrator.markTaskRunning({ taskId: task.id, leaseId: claim!.lease.id, workerId: 'w' })
    await orchestrator.completeTask({
      taskId: task.id,
      leaseId: claim!.lease.id,
      workerId: 'w',
      output: { done: true },
    })

    const final = await orchestrator.getTask(task.id)
    expect(final?.status).toBe('completed')
    expect((await orchestrator.getRun(run.id))?.status).toBe('completed')
  })

  it('dispatches events to async listeners', async () => {
    const orchestrator = createAsyncOrchestrator()
    instances.push(orchestrator)

    const seen: string[] = []
    const detach = orchestrator.addEventListener(async event => {
      await Promise.resolve()
      seen.push(event.eventType)
    })

    const run = await orchestrator.createRun({ namespace: 'async-events' })
    await orchestrator.enqueueTask({ runId: run.id, kind: 'w' })

    await new Promise(resolve => setImmediate(resolve))
    expect(seen).toContain('run.created')
    expect(seen).toContain('task.enqueued')

    detach()
  })

  it('exposes the new DLQ methods through the async surface', async () => {
    const orchestrator = createAsyncOrchestrator()
    instances.push(orchestrator)

    const run = await orchestrator.createRun({ namespace: 'async-dlq' })
    const task = await orchestrator.enqueueTask({ runId: run.id, kind: 'w', maxAttempts: 1 })
    await orchestrator.claimNextTask({ workerId: 'w', leaseMs: 10, now: '2026-04-01T00:00:00.000Z' })
    await orchestrator.expireLeases('2026-04-01T00:00:02.000Z')

    const dead = await orchestrator.listDeadTasks()
    expect(dead.map(t => t.id)).toEqual([task.id])

    const requeued = await orchestrator.requeueDeadTask({ taskId: task.id })
    expect(requeued.status).toBe('queued')
    expect(requeued.dead).toBe(false)
  })
})
