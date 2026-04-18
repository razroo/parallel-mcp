import { afterEach, describe, expect, it } from 'vitest'
import {
  DuplicateTaskKeyError,
  LeaseConflictError,
  ParallelMcpOrchestrator,
  RunTerminalError,
  SqliteParallelMcpStore,
} from '../src/index.js'

function createOrchestrator(): ParallelMcpOrchestrator {
  return new ParallelMcpOrchestrator(new SqliteParallelMcpStore({ filename: ':memory:' }), {
    defaultLeaseMs: 1_000,
  })
}

describe('task lifecycle', () => {
  const instances: ParallelMcpOrchestrator[] = []

  afterEach(() => {
    while (instances.length > 0) {
      instances.pop()?.close()
    }
  })

  it('heartbeat extends the lease and rejects mismatched workers', () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'hb' })
    orchestrator.enqueueTask({ runId: run.id, kind: 'work' })

    const claimed = orchestrator.claimNextTask({
      workerId: 'worker-a',
      leaseMs: 500,
      now: '2026-02-01T00:00:00.000Z',
    })
    expect(claimed).not.toBeNull()

    const heartbeat = orchestrator.heartbeatLease({
      taskId: claimed!.task.id,
      leaseId: claimed!.lease.id,
      workerId: 'worker-a',
      leaseMs: 5_000,
      now: '2026-02-01T00:00:00.200Z',
    })
    expect(heartbeat.expiresAt).toBe('2026-02-01T00:00:05.200Z')

    expect(() =>
      orchestrator.heartbeatLease({
        taskId: claimed!.task.id,
        leaseId: claimed!.lease.id,
        workerId: 'worker-b',
      }),
    ).toThrow(LeaseConflictError)
  })

  it('failTask writes terminal state and records the run as failed', () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'fail' })
    const task = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })

    const claimed = orchestrator.claimNextTask({ workerId: 'w1' })
    expect(claimed).not.toBeNull()

    orchestrator.failTask({
      taskId: task.id,
      leaseId: claimed!.lease.id,
      workerId: 'w1',
      error: 'boom',
    })

    expect(orchestrator.getTask(task.id)?.status).toBe('failed')
    expect(orchestrator.getTask(task.id)?.error).toBe('boom')
    expect(orchestrator.getRun(run.id)?.status).toBe('failed')
  })

  it('releaseTask requeues without incrementing attempt past maxAttempts', () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'release' })
    const task = orchestrator.enqueueTask({
      runId: run.id,
      kind: 'work',
      maxAttempts: 3,
    })

    const first = orchestrator.claimNextTask({ workerId: 'w1' })
    expect(first?.task.attemptCount).toBe(1)

    orchestrator.releaseTask({
      taskId: task.id,
      leaseId: first!.lease.id,
      workerId: 'w1',
      reason: 'unavailable',
    })

    const requeued = orchestrator.getTask(task.id)
    expect(requeued?.status).toBe('queued')
    expect(requeued?.leaseId).toBeNull()

    const second = orchestrator.claimNextTask({ workerId: 'w2' })
    expect(second?.task.id).toBe(task.id)
    expect(second?.task.attemptCount).toBe(2)
  })

  it('cancelRun moves active leases and pending tasks to cancelled', () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'cancel' })
    const running = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
    const waiting = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })

    const claimed = orchestrator.claimNextTask({ workerId: 'w1' })
    expect(claimed?.task.id).toBe(running.id)

    orchestrator.cancelRun({ runId: run.id, reason: 'user requested' })

    expect(orchestrator.getTask(running.id)?.status).toBe('cancelled')
    expect(orchestrator.getTask(waiting.id)?.status).toBe('cancelled')
    expect(orchestrator.getRun(run.id)?.status).toBe('cancelled')

    expect(() =>
      orchestrator.enqueueTask({ runId: run.id, kind: 'work' }),
    ).toThrow(RunTerminalError)
  })

  it('rejects duplicate task keys within a run', () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'keys' })
    orchestrator.enqueueTask({ runId: run.id, kind: 'work', key: 'step-1' })

    expect(() =>
      orchestrator.enqueueTask({ runId: run.id, kind: 'work', key: 'step-1' }),
    ).toThrow(DuplicateTaskKeyError)
  })

  it('derives run status correctly when tasks end in a mix of terminal states', () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'mixed' })
    const a = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
    const b = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })

    const firstClaim = orchestrator.claimNextTask({ workerId: 'w1' })
    expect(firstClaim?.task.id).toBe(a.id)
    orchestrator.completeTask({
      taskId: a.id,
      leaseId: firstClaim!.lease.id,
      workerId: 'w1',
    })

    const secondClaim = orchestrator.claimNextTask({ workerId: 'w1' })
    expect(secondClaim?.task.id).toBe(b.id)
    orchestrator.failTask({
      taskId: b.id,
      leaseId: secondClaim!.lease.id,
      workerId: 'w1',
      error: 'boom',
    })

    expect(orchestrator.getRun(run.id)?.status).toBe('failed')
  })
})
