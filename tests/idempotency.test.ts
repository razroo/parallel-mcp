import { afterEach, describe, expect, it } from 'vitest'
import { ParallelMcpOrchestrator, SqliteParallelMcpStore } from '../src/index.js'

function newOrchestrator(): ParallelMcpOrchestrator {
  return new ParallelMcpOrchestrator(new SqliteParallelMcpStore({ filename: ':memory:' }))
}

describe('claim idempotency', () => {
  const instances: ParallelMcpOrchestrator[] = []
  afterEach(() => {
    while (instances.length > 0) instances.pop()?.close()
  })

  it('returns the same lease when claimNextTask is retried with the same clientToken', () => {
    const orchestrator = newOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'idem' })
    orchestrator.enqueueTask({ runId: run.id, kind: 'work', key: 't1' })

    const first = orchestrator.claimNextTask({ workerId: 'w', clientToken: 'client-123' })
    expect(first).not.toBeNull()
    const second = orchestrator.claimNextTask({ workerId: 'w', clientToken: 'client-123' })
    expect(second).not.toBeNull()
    expect(second!.lease.id).toBe(first!.lease.id)
    expect(second!.task.id).toBe(first!.task.id)
    expect(second!.lease.clientToken).toBe('client-123')
  })

  it('does not hand out a new lease for the same token after release', () => {
    const orchestrator = newOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'idem-release' })
    orchestrator.enqueueTask({ runId: run.id, kind: 'work', key: 't1' })

    const first = orchestrator.claimNextTask({ workerId: 'w', clientToken: 'tok-a' })
    expect(first).not.toBeNull()
    orchestrator.releaseTask({ taskId: first!.task.id, leaseId: first!.lease.id, workerId: 'w' })

    const retry = orchestrator.claimNextTask({ workerId: 'w', clientToken: 'tok-a' })
    expect(retry).not.toBeNull()
    expect(retry!.lease.id).toBe(first!.lease.id)
    expect(retry!.task.status).toBe('queued')
  })
})

describe('complete/fail idempotency', () => {
  const instances: ParallelMcpOrchestrator[] = []
  afterEach(() => {
    while (instances.length > 0) instances.pop()?.close()
  })

  it('completeTask with same clientToken is a no-op that returns the same record', () => {
    const orchestrator = newOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'complete-idem' })
    const task = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
    const claim = orchestrator.claimNextTask({ workerId: 'w' })!
    orchestrator.markTaskRunning({ taskId: task.id, leaseId: claim.lease.id, workerId: 'w' })

    const first = orchestrator.completeTask({
      taskId: task.id,
      leaseId: claim.lease.id,
      workerId: 'w',
      output: { ok: true },
      clientToken: 'complete-1',
    })
    expect(first.status).toBe('completed')

    const second = orchestrator.completeTask({
      taskId: task.id,
      leaseId: claim.lease.id,
      workerId: 'w',
      output: { ok: true },
      clientToken: 'complete-1',
    })
    expect(second.status).toBe('completed')
    expect(second.id).toBe(first.id)
  })

  it('rejects a clientToken that was already used for a different task', () => {
    const orchestrator = newOrchestrator()
    instances.push(orchestrator)

    const runA = orchestrator.createRun({ namespace: 'token-collision-a' })
    const taskA = orchestrator.enqueueTask({ runId: runA.id, kind: 'work' })
    const claimA = orchestrator.claimNextTask({ workerId: 'w' })!
    orchestrator.markTaskRunning({ taskId: taskA.id, leaseId: claimA.lease.id, workerId: 'w' })
    orchestrator.completeTask({
      taskId: taskA.id,
      leaseId: claimA.lease.id,
      workerId: 'w',
      clientToken: 'dup-token',
    })

    const runB = orchestrator.createRun({ namespace: 'token-collision-b' })
    const taskB = orchestrator.enqueueTask({ runId: runB.id, kind: 'work' })
    const claimB = orchestrator.claimNextTask({ workerId: 'w' })!
    orchestrator.markTaskRunning({ taskId: taskB.id, leaseId: claimB.lease.id, workerId: 'w' })

    expect(() =>
      orchestrator.completeTask({
        taskId: taskB.id,
        leaseId: claimB.lease.id,
        workerId: 'w',
        clientToken: 'dup-token',
      }),
    ).toThrow(/already used/)
  })

  it('rejects reusing a complete-token as a fail-token', () => {
    const orchestrator = newOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'token-outcome' })
    const task = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
    const claim = orchestrator.claimNextTask({ workerId: 'w' })!
    orchestrator.markTaskRunning({ taskId: task.id, leaseId: claim.lease.id, workerId: 'w' })
    orchestrator.completeTask({
      taskId: task.id,
      leaseId: claim.lease.id,
      workerId: 'w',
      clientToken: 'outcome-token',
    })

    expect(() =>
      orchestrator.failTask({
        taskId: task.id,
        leaseId: claim.lease.id,
        workerId: 'w',
        error: 'bad',
        clientToken: 'outcome-token',
      }),
    ).toThrow(/already recorded/)
  })
})
