import { afterEach, describe, expect, it } from 'vitest'
import { ParallelMcpOrchestrator, SqliteParallelMcpStore } from '../src/index.js'

function createOrchestrator(): ParallelMcpOrchestrator {
  return new ParallelMcpOrchestrator(new SqliteParallelMcpStore({ filename: ':memory:' }), {
    defaultLeaseMs: 1_000,
  })
}

describe('retry policy and maxAttempts', () => {
  const instances: ParallelMcpOrchestrator[] = []

  afterEach(() => {
    while (instances.length > 0) {
      instances.pop()?.close()
    }
  })

  it('marks a task failed once it exhausts maxAttempts via lease expiry', () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'retry' })
    const task = orchestrator.enqueueTask({
      runId: run.id,
      kind: 'work',
      maxAttempts: 2,
    })

    const first = orchestrator.claimNextTask({
      workerId: 'w1',
      leaseMs: 10,
      now: '2026-03-01T00:00:00.000Z',
    })
    expect(first).not.toBeNull()

    orchestrator.expireLeases('2026-03-01T00:00:00.050Z')
    expect(orchestrator.getTask(task.id)?.status).toBe('queued')

    const second = orchestrator.claimNextTask({
      workerId: 'w2',
      leaseMs: 10,
      now: '2026-03-01T00:00:01.000Z',
    })
    expect(second?.task.attemptCount).toBe(2)

    const result = orchestrator.expireLeases('2026-03-01T00:00:02.000Z')
    expect(result.count).toBe(1)

    const final = orchestrator.getTask(task.id)
    expect(final?.status).toBe('failed')
    expect(final?.error).toBe('max_attempts_exceeded')
    expect(orchestrator.getRun(run.id)?.status).toBe('failed')
  })

  it('honours a fixed retry delay by gating subsequent claims on not_before', () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'retry-delay' })
    orchestrator.enqueueTask({
      runId: run.id,
      kind: 'work',
      maxAttempts: 5,
      retry: { delayMs: 1_000, backoff: 'fixed' },
    })

    orchestrator.claimNextTask({
      workerId: 'w1',
      leaseMs: 10,
      now: '2026-03-02T00:00:00.000Z',
    })
    orchestrator.expireLeases('2026-03-02T00:00:00.050Z')

    const tooEarly = orchestrator.claimNextTask({
      workerId: 'w2',
      now: '2026-03-02T00:00:00.200Z',
    })
    expect(tooEarly).toBeNull()

    const lateEnough = orchestrator.claimNextTask({
      workerId: 'w2',
      now: '2026-03-02T00:00:02.000Z',
    })
    expect(lateEnough).not.toBeNull()
    expect(lateEnough?.task.attemptCount).toBe(2)
  })

  it('applies exponential backoff with a configured cap', () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'retry-expo' })
    const task = orchestrator.enqueueTask({
      runId: run.id,
      kind: 'work',
      maxAttempts: 10,
      retry: { delayMs: 1_000, backoff: 'exponential', maxDelayMs: 3_000 },
    })

    orchestrator.claimNextTask({
      workerId: 'w1',
      leaseMs: 10,
      now: '2026-03-03T00:00:00.000Z',
    })
    orchestrator.expireLeases('2026-03-03T00:00:00.020Z')
    const afterAttempt1 = orchestrator.getTask(task.id)
    expect(afterAttempt1?.notBefore).toBe('2026-03-03T00:00:01.020Z')

    orchestrator.claimNextTask({
      workerId: 'w1',
      leaseMs: 10,
      now: '2026-03-03T00:00:05.000Z',
    })
    orchestrator.expireLeases('2026-03-03T00:00:05.020Z')
    const afterAttempt2 = orchestrator.getTask(task.id)
    expect(afterAttempt2?.notBefore).toBe('2026-03-03T00:00:07.020Z')

    orchestrator.claimNextTask({
      workerId: 'w1',
      leaseMs: 10,
      now: '2026-03-03T00:00:10.000Z',
    })
    orchestrator.expireLeases('2026-03-03T00:00:10.020Z')
    const afterAttempt3 = orchestrator.getTask(task.id)
    expect(afterAttempt3?.notBefore).toBe('2026-03-03T00:00:13.020Z')
  })
})
