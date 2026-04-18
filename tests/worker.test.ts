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

describe('runWorker', () => {
  const instances: ParallelMcpOrchestrator[] = []
  const workers: WorkerHandle[] = []

  afterEach(async () => {
    while (workers.length > 0) {
      const worker = workers.pop()
      worker?.stop()
      if (worker) await worker.stopped
    }
    while (instances.length > 0) {
      instances.pop()?.close()
    }
  })

  it('claims, completes, and advances the next task until stopped', async () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'worker' })
    orchestrator.enqueueTask({ runId: run.id, kind: 'work', input: { n: 1 } })
    orchestrator.enqueueTask({ runId: run.id, kind: 'work', input: { n: 2 } })

    const seen: number[] = []
    const worker = runWorker({
      orchestrator,
      workerId: 'w1',
      pollIntervalMs: 1,
      idleBackoffMs: 5,
      handler: ({ task }) => {
        const input = task.input as { n: number } | null
        if (input) seen.push(input.n)
        return { status: 'completed', output: { ok: true } }
      },
    })
    workers.push(worker)

    while (seen.length < 2) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    expect(seen.sort()).toEqual([1, 2])

    const [taskA, taskB] = orchestrator.listRunTasks(run.id)
    expect(taskA?.status).toBe('completed')
    expect(taskB?.status).toBe('completed')
    expect(orchestrator.getRun(run.id)?.status).toBe('completed')
  })

  it('marks a task failed when the handler throws', async () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'worker-fail' })
    const task = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })

    const errors: unknown[] = []
    const worker = runWorker({
      orchestrator,
      workerId: 'w1',
      pollIntervalMs: 1,
      idleBackoffMs: 5,
      onError: error => {
        errors.push(error)
      },
      handler: () => {
        throw new Error('boom')
      },
    })
    workers.push(worker)

    while (orchestrator.getTask(task.id)?.status !== 'failed') {
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    const finalTask = orchestrator.getTask(task.id)
    expect(finalTask?.status).toBe('failed')
    expect(finalTask?.error).toBe('boom')
    expect(errors.length).toBeGreaterThan(0)
  })

  it('honors the paused result and releases the lease', async () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'worker-pause' })
    const task = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })

    const worker = runWorker({
      orchestrator,
      workerId: 'w1',
      pollIntervalMs: 1,
      idleBackoffMs: 5,
      handler: () => ({
        status: 'paused',
        pauseAs: 'waiting_input',
        reason: 'needs human',
      }),
    })
    workers.push(worker)

    while (orchestrator.getTask(task.id)?.status !== 'waiting_input') {
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    const paused = orchestrator.getTask(task.id)
    expect(paused?.status).toBe('waiting_input')
    expect(paused?.leaseId).toBeNull()
  })

  it('stops cleanly when stop() is called mid-idle', async () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    orchestrator.createRun({ namespace: 'worker-stop' })

    const worker = runWorker({
      orchestrator,
      workerId: 'w-stop',
      pollIntervalMs: 1,
      idleBackoffMs: 50,
      handler: () => ({ status: 'completed' }),
    })

    await new Promise(resolve => setTimeout(resolve, 20))
    worker.stop()
    await worker.stopped
    expect(true).toBe(true)
  })
})
