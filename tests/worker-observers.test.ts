import { afterEach, describe, expect, it } from 'vitest'
import {
  ParallelMcpOrchestrator,
  SqliteParallelMcpStore,
  runWorker,
  type WorkerHandle,
} from '../src/index.js'

function createOrchestrator(): ParallelMcpOrchestrator {
  return new ParallelMcpOrchestrator(new SqliteParallelMcpStore({ filename: ':memory:' }), {
    defaultLeaseMs: 500,
  })
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitUntil timeout')
}

describe('runWorker observers', () => {
  const instances: ParallelMcpOrchestrator[] = []
  const workers: WorkerHandle[] = []

  afterEach(async () => {
    while (workers.length > 0) {
      const worker = workers.pop()
      worker?.stop()
      if (worker) await worker.stopped
    }
    while (instances.length > 0) instances.pop()?.close()
  })

  it('fires onClaim → onHandlerStart → onHandlerEnd in order for each task', async () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'obs' })
    orchestrator.enqueueTask({ runId: run.id, kind: 'work', input: { n: 1 } })

    const events: string[] = []
    let recordedDurationMs: number | null = null

    const worker = runWorker({
      orchestrator,
      workerId: 'observer-1',
      pollIntervalMs: 5,
      idleBackoffMs: 10,
      onClaim: () => events.push('claim'),
      onHandlerStart: () => events.push('start'),
      onHandlerEnd: ({ durationMs, outcome }) => {
        events.push(`end:${outcome.status}`)
        recordedDurationMs = durationMs
      },
      handler: async () => {
        await new Promise(resolve => setTimeout(resolve, 25))
        return { status: 'completed' as const, output: { ok: true } }
      },
    })
    workers.push(worker)

    await waitUntil(() => events.includes('end:completed'))

    expect(events).toEqual(['claim', 'start', 'end:completed'])
    expect(recordedDurationMs).not.toBeNull()
    expect(recordedDurationMs!).toBeGreaterThanOrEqual(20)
  })

  it('reports handler throw as outcome { status: "threw", error }', async () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'obs' })
    orchestrator.enqueueTask({ runId: run.id, kind: 'work' })

    let endOutcome: unknown = null
    const boom = new Error('kaboom')

    const worker = runWorker({
      orchestrator,
      workerId: 'observer-2',
      pollIntervalMs: 5,
      idleBackoffMs: 10,
      onHandlerEnd: ({ outcome }) => {
        endOutcome = outcome
      },
      handler: async () => {
        throw boom
      },
    })
    workers.push(worker)

    await waitUntil(() => endOutcome !== null)
    expect(endOutcome).toEqual({ status: 'threw', error: boom })
  })

  it('does not crash the loop when an observer itself throws — routes error to onError', async () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'obs' })
    orchestrator.enqueueTask({ runId: run.id, kind: 'work' })

    const observerErrors: unknown[] = []
    let completedTaskSeen = false

    const worker = runWorker({
      orchestrator,
      workerId: 'observer-3',
      pollIntervalMs: 5,
      idleBackoffMs: 10,
      onClaim: () => {
        throw new Error('observer blew up')
      },
      onHandlerEnd: () => {
        completedTaskSeen = true
      },
      onError: error => observerErrors.push(error),
      handler: async () => ({ status: 'completed' as const }),
    })
    workers.push(worker)

    await waitUntil(() => completedTaskSeen)

    expect(observerErrors.some(e => e instanceof Error && (e as Error).message === 'observer blew up')).toBe(true)
  })
})

describe('runWorker propagateRunCancellation', () => {
  const instances: ParallelMcpOrchestrator[] = []
  const workers: WorkerHandle[] = []

  afterEach(async () => {
    while (workers.length > 0) {
      const worker = workers.pop()
      worker?.stop()
      if (worker) await worker.stopped
    }
    while (instances.length > 0) instances.pop()?.close()
  })

  it('aborts the in-flight handler signal when its run is cancelled', async () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'cancel' })
    orchestrator.enqueueTask({ runId: run.id, kind: 'long' })

    let sawAbort = false
    let runCancelledNotified = false
    let handlerResolved = false

    const worker = runWorker({
      orchestrator,
      workerId: 'cancellable',
      pollIntervalMs: 5,
      idleBackoffMs: 10,
      onRunCancelled: () => {
        runCancelledNotified = true
      },
      handler: async ({ signal }) => {
        await new Promise<void>(resolve => {
          if (signal.aborted) {
            sawAbort = true
            resolve()
            return
          }
          signal.addEventListener(
            'abort',
            () => {
              sawAbort = true
              resolve()
            },
            { once: true },
          )
        })
        handlerResolved = true
        return { status: 'released' as const, reason: 'cancelled' }
      },
    })
    workers.push(worker)

    await new Promise(resolve => setTimeout(resolve, 50))

    orchestrator.cancelRun({ runId: run.id })

    await waitUntil(() => handlerResolved, 2_000)
    expect(sawAbort).toBe(true)
    expect(runCancelledNotified).toBe(true)
  })

  it('does not abort when propagateRunCancellation is false', async () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'cancel-off' })
    orchestrator.enqueueTask({ runId: run.id, kind: 'long' })

    let sawAbort = false
    let handlerEnded = false

    const worker = runWorker({
      orchestrator,
      workerId: 'non-cancellable',
      pollIntervalMs: 5,
      idleBackoffMs: 10,
      propagateRunCancellation: false,
      handler: async ({ signal }) => {
        const raced = await Promise.race<'abort' | 'done'>([
          new Promise<'abort'>(resolve => {
            if (signal.aborted) resolve('abort')
            else signal.addEventListener('abort', () => resolve('abort'), { once: true })
          }),
          new Promise<'done'>(resolve => setTimeout(() => resolve('done'), 150)),
        ])
        if (raced === 'abort') sawAbort = true
        handlerEnded = true
        return { status: 'completed' as const }
      },
    })
    workers.push(worker)

    await new Promise(resolve => setTimeout(resolve, 30))
    orchestrator.cancelRun({ runId: run.id })

    await waitUntil(() => handlerEnded, 2_000)
    expect(sawAbort).toBe(false)
  })
})

describe('typed event helpers', () => {
  it('isEventOfType narrows payload by eventType', async () => {
    const orchestrator = createOrchestrator()
    try {
      const run = orchestrator.createRun({ namespace: 'typed' })
      orchestrator.enqueueTask({ runId: run.id, kind: 'work' })

      const events = orchestrator.listRunEvents(run.id)
      const mod = await import('../src/index.js')
      const { isEventOfType } = mod

      const enqueued = events.find(e => e.eventType === 'task.enqueued')!
      expect(isEventOfType(enqueued, 'task.enqueued')).toBe(true)
      expect(isEventOfType(enqueued, 'task.completed')).toBe(false)

      if (isEventOfType(enqueued, 'task.enqueued')) {
        expect(enqueued.payload.kind).toBe('work')
        expect(Array.isArray(enqueued.payload.dependsOnTaskIds)).toBe(true)
      }
    } finally {
      orchestrator.close()
    }
  })
})
