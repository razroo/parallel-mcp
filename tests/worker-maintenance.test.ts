import { afterEach, describe, expect, it } from 'vitest'
import {
  ParallelMcpOrchestrator,
  SqliteParallelMcpStore,
  runWorker,
  scheduleExpireLeases,
} from '../src/index.js'

function createOrchestrator(): ParallelMcpOrchestrator {
  return new ParallelMcpOrchestrator(new SqliteParallelMcpStore({ filename: ':memory:' }), {
    defaultLeaseMs: 500,
  })
}

describe('scheduleExpireLeases', () => {
  const instances: ParallelMcpOrchestrator[] = []
  afterEach(() => {
    while (instances.length > 0) instances.pop()?.close()
  })

  it('runs immediately and then on interval, and stops cleanly', async () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const ticks: number[] = []
    const handle = scheduleExpireLeases({
      orchestrator,
      intervalMs: 20,
      onTick: result => ticks.push(result.count),
    })

    await new Promise(resolve => setTimeout(resolve, 100))
    handle.stop()
    await handle.stopped
    expect(ticks.length).toBeGreaterThanOrEqual(2)
  })

  it('surfaces errors through onError instead of throwing', async () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const captured: unknown[] = []
    const originalExpire = orchestrator.expireLeases.bind(orchestrator)
    let thrown = false
    orchestrator.expireLeases = () => {
      if (!thrown) {
        thrown = true
        throw new Error('boom')
      }
      return originalExpire()
    }

    const handle = scheduleExpireLeases({
      orchestrator,
      intervalMs: 10,
      onError: error => captured.push(error),
    })

    await new Promise(resolve => setTimeout(resolve, 40))
    handle.stop()
    await handle.stopped
    expect(captured.length).toBeGreaterThan(0)
  })

  it('stops when the supplied AbortSignal aborts', async () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const controller = new AbortController()
    let tickCount = 0
    const handle = scheduleExpireLeases({
      orchestrator,
      intervalMs: 10,
      signal: controller.signal,
      onTick: () => {
        tickCount += 1
      },
    })

    await new Promise(resolve => setTimeout(resolve, 30))
    controller.abort()
    await handle.stopped
    const snapshot = tickCount
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(tickCount).toBe(snapshot)
  })

  it('rejects non-positive intervals', () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)
    expect(() => scheduleExpireLeases({ orchestrator, intervalMs: 0 })).toThrow()
    expect(() => scheduleExpireLeases({ orchestrator, intervalMs: -5 })).toThrow()
  })
})

describe('runWorker installSignalHandlers', () => {
  const instances: ParallelMcpOrchestrator[] = []
  afterEach(() => {
    while (instances.length > 0) instances.pop()?.close()
  })

  it('attaches SIGINT/SIGTERM listeners and removes them after stop', async () => {
    const orchestrator = createOrchestrator()
    instances.push(orchestrator)

    const before = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    }

    const worker = runWorker({
      orchestrator,
      workerId: 'signal-worker',
      handler: async () => ({ status: 'completed' as const }),
      pollIntervalMs: 5,
      idleBackoffMs: 5,
      idleMaxBackoffMs: 20,
      installSignalHandlers: true,
    })

    expect(process.listenerCount('SIGINT')).toBeGreaterThan(before.sigint)
    expect(process.listenerCount('SIGTERM')).toBeGreaterThan(before.sigterm)

    worker.stop()
    await worker.stopped

    expect(process.listenerCount('SIGINT')).toBe(before.sigint)
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm)
  })
})
