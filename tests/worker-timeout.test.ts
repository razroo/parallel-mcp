import { afterEach, describe, expect, it } from 'vitest'
import {
  ParallelMcpOrchestrator,
  SqliteParallelMcpStore,
  runWorker,
  type WorkerHandle,
} from '../src/index.js'

function createOrchestrator(): ParallelMcpOrchestrator {
  return new ParallelMcpOrchestrator(new SqliteParallelMcpStore({ filename: ':memory:' }), {
    defaultLeaseMs: 2_000,
  })
}

describe('runWorker task-level timeoutMs', () => {
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

  it('fails a task whose handler exceeds its timeoutMs and reports task_timeout on onHandlerEnd', async () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'timeout' })
    const task = orchestrator.enqueueTask({
      runId: run.id,
      kind: 'slow',
      timeoutMs: 40,
      maxAttempts: 1,
    })

    const outcomes: Array<{ status: string; timeoutMs?: number }> = []
    let sawAbort = false

    const worker = runWorker({
      orchestrator,
      workerId: 'w-timeout',
      pollIntervalMs: 1,
      idleBackoffMs: 5,
      handler: async ({ signal }) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000)
          signal.addEventListener('abort', () => {
            clearTimeout(timer)
            sawAbort = true
            reject(new Error('aborted'))
          }, { once: true })
        })
        return { status: 'completed' as const }
      },
      onHandlerEnd: ({ outcome }) => {
        const entry: { status: string; timeoutMs?: number } = { status: outcome.status }
        if (outcome.status === 'task_timeout') entry.timeoutMs = outcome.timeoutMs
        outcomes.push(entry)
      },
    })
    workers.push(worker)

    const deadline = Date.now() + 1_500
    while (Date.now() < deadline) {
      const t = orchestrator.getTask(task.id)
      if (t?.status === 'failed') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    const final = orchestrator.getTask(task.id)
    expect(final?.status).toBe('failed')
    expect(final?.error).toBe('task_timeout_exceeded:40ms')
    expect(sawAbort).toBe(true)
    expect(outcomes.some(o => o.status === 'task_timeout' && o.timeoutMs === 40)).toBe(true)
  })

  it('does not fire task_timeout for tasks without a timeoutMs', async () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'timeout-none' })
    const task = orchestrator.enqueueTask({ runId: run.id, kind: 'quick' })

    const outcomes: string[] = []
    const worker = runWorker({
      orchestrator,
      workerId: 'w-none',
      pollIntervalMs: 1,
      idleBackoffMs: 5,
      handler: async () => ({ status: 'completed' as const }),
      onHandlerEnd: ({ outcome }) => outcomes.push(outcome.status),
    })
    workers.push(worker)

    const deadline = Date.now() + 1_000
    while (Date.now() < deadline) {
      const t = orchestrator.getTask(task.id)
      if (t?.status === 'completed') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    expect(orchestrator.getTask(task.id)?.status).toBe('completed')
    expect(outcomes).toContain('completed')
    expect(outcomes).not.toContain('task_timeout')
  })

  it('persists timeoutMs on the task record', () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const run = orchestrator.createRun({ namespace: 'timeout-store' })
    const task = orchestrator.enqueueTask({
      runId: run.id,
      kind: 'work',
      timeoutMs: 123,
    })
    expect(task.timeoutMs).toBe(123)
    expect(orchestrator.getTask(task.id)?.timeoutMs).toBe(123)

    const untimed = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
    expect(untimed.timeoutMs).toBeNull()
  })
})
