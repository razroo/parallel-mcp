import { describe, expect, it } from 'vitest'
import {
  ParallelMcpOrchestrator,
  SqliteParallelMcpStore,
  type EventRecord,
} from '../src/index.js'

describe('orchestrator onEvent', () => {
  it('fires for every durable event in order with the stored record', () => {
    const received: EventRecord[] = []
    const orchestrator = new ParallelMcpOrchestrator(
      new SqliteParallelMcpStore({ filename: ':memory:' }),
      {
        onEvent: event => {
          received.push(event)
        },
      },
    )

    const run = orchestrator.createRun({ namespace: 'observe' })
    const task = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
    const claim = orchestrator.claimNextTask({ workerId: 'w' })!
    orchestrator.markTaskRunning({ taskId: task.id, leaseId: claim.lease.id, workerId: 'w' })
    orchestrator.completeTask({ taskId: task.id, leaseId: claim.lease.id, workerId: 'w' })

    const types = received.map(event => event.eventType)
    expect(types).toContain('run.created')
    expect(types).toContain('task.enqueued')
    expect(types).toContain('task.claimed')
    expect(types).toContain('task.running')
    expect(types).toContain('task.completed')
    expect(types).toContain('run.status.changed')

    const ids = received.map(event => event.id)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))

    const persisted = orchestrator.listRunEvents(run.id).map(event => event.id)
    for (const event of received) {
      expect(persisted).toContain(event.id)
    }

    orchestrator.close()
  })

  it('does not rethrow listener failures', () => {
    let called = 0
    const orchestrator = new ParallelMcpOrchestrator(
      new SqliteParallelMcpStore({ filename: ':memory:' }),
      {
        onEvent: () => {
          called += 1
          throw new Error('listener blew up')
        },
      },
    )

    const run = orchestrator.createRun({ namespace: 'listener-error' })
    orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
    expect(called).toBeGreaterThan(0)

    orchestrator.close()
  })
})
