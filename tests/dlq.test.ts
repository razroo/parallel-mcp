import { afterEach, describe, expect, it } from 'vitest'
import { ParallelMcpOrchestrator, SqliteParallelMcpStore } from '../src/index.js'

function createOrchestrator(): ParallelMcpOrchestrator {
  return new ParallelMcpOrchestrator(new SqliteParallelMcpStore({ filename: ':memory:' }), {
    defaultLeaseMs: 1_000,
  })
}

describe('dead-letter queue', () => {
  const instances: ParallelMcpOrchestrator[] = []

  afterEach(() => {
    while (instances.length > 0) {
      instances.pop()?.close()
    }
  })

  it('moves a task to the DLQ when maxAttempts is exhausted via lease expiry', () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'dlq' })
    const task = orchestrator.enqueueTask({
      runId: run.id,
      kind: 'work',
      maxAttempts: 1,
    })

    orchestrator.claimNextTask({
      workerId: 'w1',
      leaseMs: 10,
      now: '2026-03-01T00:00:00.000Z',
    })
    orchestrator.expireLeases('2026-03-01T00:00:01.000Z')

    const final = orchestrator.getTask(task.id)
    expect(final?.status).toBe('failed')
    expect(final?.dead).toBe(true)
    expect(final?.error).toBe('max_attempts_exceeded')

    const dead = orchestrator.listDeadTasks()
    expect(dead.map(t => t.id)).toEqual([task.id])
  })

  it('does not place a task in the DLQ when retries remain', () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'dlq-retry' })
    const task = orchestrator.enqueueTask({
      runId: run.id,
      kind: 'work',
      maxAttempts: 3,
    })

    orchestrator.claimNextTask({
      workerId: 'w1',
      leaseMs: 10,
      now: '2026-03-02T00:00:00.000Z',
    })
    orchestrator.expireLeases('2026-03-02T00:00:01.000Z')

    const requeued = orchestrator.getTask(task.id)
    expect(requeued?.status).toBe('queued')
    expect(requeued?.dead).toBe(false)
    expect(orchestrator.listDeadTasks().length).toBe(0)
  })

  it('requeues a dead-letter task back to queued with a fresh attempt budget', () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'dlq-requeue' })
    const task = orchestrator.enqueueTask({
      runId: run.id,
      kind: 'work',
      maxAttempts: 1,
    })

    orchestrator.claimNextTask({
      workerId: 'w1',
      leaseMs: 10,
      now: '2026-03-03T00:00:00.000Z',
    })
    orchestrator.expireLeases('2026-03-03T00:00:01.000Z')
    expect(orchestrator.getTask(task.id)?.dead).toBe(true)

    const requeued = orchestrator.requeueDeadTask({
      taskId: task.id,
      reason: 'operator replay',
      now: '2026-03-03T00:00:02.000Z',
    })
    expect(requeued.status).toBe('queued')
    expect(requeued.dead).toBe(false)
    expect(requeued.attemptCount).toBe(0)
    expect(requeued.error).toBeNull()

    const events = orchestrator.listRunEvents(run.id).map(e => e.eventType)
    expect(events).toContain('task.dead_lettered')
    expect(events).toContain('task.requeued_from_dlq')

    const claim = orchestrator.claimNextTask({
      workerId: 'w-retry',
      leaseMs: 10_000,
      now: '2026-03-03T00:00:03.000Z',
    })
    expect(claim).not.toBeNull()
    expect(claim!.task.attemptCount).toBe(1)
  })

  it('preserves attempt count when resetAttempts is false', () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'dlq-no-reset' })
    const task = orchestrator.enqueueTask({
      runId: run.id,
      kind: 'work',
      maxAttempts: 1,
    })

    orchestrator.claimNextTask({
      workerId: 'w1',
      leaseMs: 10,
      now: '2026-03-04T00:00:00.000Z',
    })
    orchestrator.expireLeases('2026-03-04T00:00:01.000Z')
    const dead = orchestrator.getTask(task.id)!
    expect(dead.attemptCount).toBe(1)

    const requeued = orchestrator.requeueDeadTask({
      taskId: task.id,
      resetAttempts: false,
      now: '2026-03-04T00:00:02.000Z',
    })
    expect(requeued.attemptCount).toBe(1)
    expect(requeued.dead).toBe(false)
    expect(requeued.status).toBe('queued')
  })

  it('filters listDeadTasks by runId and kind', () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const runA = orchestrator.createRun({ namespace: 'a' })
    const runB = orchestrator.createRun({ namespace: 'b' })
    const taskA = orchestrator.enqueueTask({ runId: runA.id, kind: 'build', maxAttempts: 1 })
    const taskB = orchestrator.enqueueTask({ runId: runB.id, kind: 'deploy', maxAttempts: 1 })

    for (const w of ['a', 'b']) {
      orchestrator.claimNextTask({
        workerId: `w-${w}`,
        leaseMs: 10,
        now: `2026-03-05T00:00:00.00${w === 'a' ? 0 : 1}Z`,
      })
    }
    orchestrator.expireLeases('2026-03-05T00:00:02.000Z')

    expect(orchestrator.listDeadTasks().map(t => t.id).sort()).toEqual([taskA.id, taskB.id].sort())
    expect(orchestrator.listDeadTasks({ runId: runA.id }).map(t => t.id)).toEqual([taskA.id])
    expect(orchestrator.listDeadTasks({ kinds: ['deploy'] }).map(t => t.id)).toEqual([taskB.id])
  })
})
