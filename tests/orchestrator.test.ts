import { afterEach, describe, expect, it } from 'vitest'
import { ParallelMcpOrchestrator, SqliteParallelMcpStore } from '../src/index.js'

function createOrchestrator(): ParallelMcpOrchestrator {
  return new ParallelMcpOrchestrator(new SqliteParallelMcpStore({ filename: ':memory:' }), {
    defaultLeaseMs: 1_000,
  })
}

describe('ParallelMcpOrchestrator', () => {
  const instances: ParallelMcpOrchestrator[] = []

  afterEach(() => {
    while (instances.length > 0) {
      instances.pop()?.close()
    }
  })

  it('claims tasks only when dependencies are satisfied', () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({
      namespace: 'test',
      context: { flow: 'dependency-check' },
    })

    const parse = orchestrator.enqueueTask({
      runId: run.id,
      kind: 'resume.parse',
      key: 'parse',
      input: { file: 'resume.pdf' },
    })

    orchestrator.enqueueTask({
      runId: run.id,
      kind: 'site.apply',
      key: 'apply',
      dependsOnTaskIds: [parse.id],
      input: { url: 'https://example.com/jobs/1' },
    })

    const first = orchestrator.claimNextTask({ workerId: 'worker-a' })
    expect(first?.task.id).toBe(parse.id)

    expect(orchestrator.claimNextTask({ workerId: 'worker-b' })).toBeNull()

    orchestrator.markTaskRunning({
      taskId: first!.task.id,
      leaseId: first!.lease.id,
      workerId: 'worker-a',
    })
    orchestrator.completeTask({
      taskId: first!.task.id,
      leaseId: first!.lease.id,
      workerId: 'worker-a',
      output: { ok: true },
    })

    const second = orchestrator.claimNextTask({ workerId: 'worker-b' })
    expect(second?.task.kind).toBe('site.apply')
  })

  it('requeues expired leases so another worker can recover the task', () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'test' })
    orchestrator.enqueueTask({
      runId: run.id,
      kind: 'browser.step',
    })

    const claimed = orchestrator.claimNextTask({
      workerId: 'worker-a',
      leaseMs: 10,
      now: '2026-01-01T00:00:00.000Z',
    })
    expect(claimed).not.toBeNull()

    const expired = orchestrator.expireLeases('2026-01-01T00:00:00.020Z')
    expect(expired.count).toBe(1)
    expect(expired.expiredTaskIds).toEqual([claimed!.task.id])

    const recovered = orchestrator.claimNextTask({
      workerId: 'worker-b',
      now: '2026-01-01T00:00:00.030Z',
    })
    expect(recovered?.task.id).toBe(claimed!.task.id)
    expect(recovered?.lease.workerId).toBe('worker-b')
  })

  it('stores explicit context snapshots and surfaces waiting runs', () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({
      namespace: 'test',
      context: {
        candidateId: 'c1',
        browserProfile: null,
      },
    })

    const task = orchestrator.enqueueTask({
      runId: run.id,
      kind: 'human.review',
    })

    const claimed = orchestrator.claimNextTask({ workerId: 'worker-a' })
    expect(claimed?.task.id).toBe(task.id)

    orchestrator.markTaskRunning({
      taskId: task.id,
      leaseId: claimed!.lease.id,
      workerId: 'worker-a',
    })

    orchestrator.pauseTask({
      taskId: task.id,
      leaseId: claimed!.lease.id,
      workerId: 'worker-a',
      status: 'waiting_input',
      reason: 'Need user confirmation',
    })

    expect(orchestrator.getRun(run.id)?.status).toBe('waiting')

    orchestrator.resumeTask({ taskId: task.id })
    const reclaimed = orchestrator.claimNextTask({ workerId: 'worker-b' })
    expect(reclaimed?.task.id).toBe(task.id)

    orchestrator.completeTask({
      taskId: task.id,
      leaseId: reclaimed!.lease.id,
      workerId: 'worker-b',
      nextContext: {
        candidateId: 'c1',
        browserProfile: 'profile-7',
      },
      nextContextLabel: 'human.review.completed',
    })

    const snapshot = orchestrator.getCurrentContextSnapshot(run.id)
    expect(snapshot?.payload).toEqual({
      candidateId: 'c1',
      browserProfile: 'profile-7',
    })
  })
})
