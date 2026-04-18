import { describe, expect, it } from 'vitest'
import {
  ParallelMcpOrchestrator,
  SqliteParallelMcpStore,
} from '../src/index.js'

function newOrchestrator() {
  return new ParallelMcpOrchestrator(new SqliteParallelMcpStore({ filename: ':memory:' }))
}

describe('listRuns', () => {
  it('filters by namespace and statuses and respects limit/offset/order', () => {
    const orch = newOrchestrator()

    const alphaA = orch.createRun({ namespace: 'alpha', now: new Date('2025-01-01T00:00:00Z') })
    const alphaB = orch.createRun({ namespace: 'alpha', now: new Date('2025-01-02T00:00:00Z') })
    const beta = orch.createRun({ namespace: 'beta' })
    orch.cancelRun({ runId: beta.id })

    expect(orch.listRuns({ namespace: 'alpha' }).map(r => r.id).sort()).toEqual(
      [alphaA.id, alphaB.id].sort(),
    )
    expect(orch.listRuns({ namespace: 'beta' }).map(r => r.id)).toEqual([beta.id])
    expect(
      orch.listRuns({ statuses: ['cancelled'] }).map(r => r.id),
    ).toEqual([beta.id])

    const limited = orch.listRuns({ namespace: 'alpha', limit: 1, orderBy: 'created_at', orderDir: 'asc' })
    expect(limited).toHaveLength(1)
    expect(limited[0]!.id).toBe(alphaA.id)

    const offset = orch.listRuns({ namespace: 'alpha', limit: 1, offset: 1, orderBy: 'created_at', orderDir: 'asc' })
    expect(offset[0]!.id).toBe(alphaB.id)

    orch.close()
  })

  it('filters by updatedAfter / updatedBefore', () => {
    const orch = newOrchestrator()

    const early = orch.createRun({ namespace: 'time', now: new Date('2025-01-01T00:00:00Z') })
    const late = orch.createRun({ namespace: 'time', now: new Date('2025-06-01T00:00:00Z') })

    const afterApril = orch.listRuns({ namespace: 'time', updatedAfter: new Date('2025-04-01T00:00:00Z') })
    expect(afterApril.map(r => r.id)).toEqual([late.id])

    const beforeApril = orch.listRuns({ namespace: 'time', updatedBefore: new Date('2025-04-01T00:00:00Z') })
    expect(beforeApril.map(r => r.id)).toEqual([early.id])

    orch.close()
  })
})

describe('listPendingTasks', () => {
  it('returns only queued tasks, filtered by kind/runId, ordered by priority DESC', () => {
    const orch = newOrchestrator()

    const run = orch.createRun({ namespace: 'q' })
    const low = orch.enqueueTask({ runId: run.id, kind: 'a', priority: 1 })
    const high = orch.enqueueTask({ runId: run.id, kind: 'a', priority: 10 })
    const otherKind = orch.enqueueTask({ runId: run.id, kind: 'b' })

    const claim = orch.claimNextTask({ workerId: 'w' })!
    expect(claim.task.id).toBe(high.id)

    const pending = orch.listPendingTasks()
    expect(pending.map(t => t.id)).toEqual([low.id, otherKind.id])

    const onlyA = orch.listPendingTasks({ kinds: ['a'] })
    expect(onlyA.map(t => t.id)).toEqual([low.id])

    const scoped = orch.listPendingTasks({ runId: run.id, kinds: ['b'] })
    expect(scoped.map(t => t.id)).toEqual([otherKind.id])

    orch.close()
  })

  it('honors readyBy for delayed tasks (not_before set via expiry-requeue)', () => {
    const orch = newOrchestrator()
    const run = orch.createRun({ namespace: 'delayed' })
    const task = orch.enqueueTask({
      runId: run.id,
      kind: 'later',
      maxAttempts: 3,
      retry: { delayMs: 60_000, backoff: 'fixed' },
    })

    const claim = orch.claimNextTask({ workerId: 'w', leaseMs: 10 })!
    expect(claim.task.id).toBe(task.id)

    orch.expireLeases(new Date(Date.now() + 60_000))

    const requeued = orch.getTask(task.id)!
    expect(requeued.status).toBe('queued')
    expect(requeued.notBefore).not.toBeNull()

    expect(orch.listPendingTasks({ readyBy: new Date(Date.now()) }).map(t => t.id)).toEqual([])
    const farFuture = new Date(new Date(requeued.notBefore!).getTime() + 60_000)
    expect(orch.listPendingTasks({ readyBy: farFuture }).map(t => t.id)).toEqual([task.id])

    orch.close()
  })
})

describe('listEventsSince', () => {
  it('paginates through events for a run and returns a usable nextCursor', () => {
    const orch = newOrchestrator()
    const run = orch.createRun({ namespace: 'cursor' })
    for (let i = 0; i < 6; i++) {
      orch.enqueueTask({ runId: run.id, kind: `k-${i}` })
    }

    const page1 = orch.listEventsSince({ runId: run.id, limit: 3 })
    expect(page1.events).toHaveLength(3)
    expect(page1.nextCursor).toBe(page1.events.at(-1)!.id)

    const page2 = orch.listEventsSince({ runId: run.id, limit: 3, afterId: page1.nextCursor ?? 0 })
    expect(page2.events.length).toBeGreaterThan(0)
    for (const event of page2.events) {
      expect(event.id).toBeGreaterThan(page1.nextCursor!)
    }

    const seen = [...page1.events.map(e => e.id), ...page2.events.map(e => e.id)]
    expect(new Set(seen).size).toBe(seen.length)

    orch.close()
  })

  it('filters by eventTypes and global (no runId) feed', () => {
    const orch = newOrchestrator()
    const runA = orch.createRun({ namespace: 'a' })
    const runB = orch.createRun({ namespace: 'b' })
    orch.enqueueTask({ runId: runA.id, kind: 'x' })
    orch.enqueueTask({ runId: runB.id, kind: 'y' })

    const enqueued = orch.listEventsSince({ eventTypes: ['task.enqueued'] })
    expect(enqueued.events.length).toBe(2)
    const runs = new Set(enqueued.events.map(e => e.runId))
    expect(runs.has(runA.id)).toBe(true)
    expect(runs.has(runB.id)).toBe(true)

    orch.close()
  })

  it('returns the provided afterId as nextCursor when no new events match', () => {
    const orch = newOrchestrator()
    const run = orch.createRun({ namespace: 'empty' })
    const first = orch.listEventsSince({ runId: run.id })
    const cursor = first.nextCursor ?? 0

    const empty = orch.listEventsSince({ runId: run.id, afterId: cursor })
    expect(empty.events).toEqual([])
    expect(empty.nextCursor).toBe(cursor)

    orch.close()
  })
})

describe('pruneRuns', () => {
  it('deletes terminal runs older than the cutoff and cascades to tasks/events', () => {
    const orch = newOrchestrator()

    const oldRun = orch.createRun({ namespace: 'old', now: new Date('2025-01-01T00:00:00Z') })
    orch.enqueueTask({ runId: oldRun.id, kind: 'k', now: new Date('2025-01-01T00:00:00Z') })
    orch.cancelRun({ runId: oldRun.id, now: new Date('2025-01-02T00:00:00Z') })

    const recentRun = orch.createRun({ namespace: 'recent' })

    const result = orch.pruneRuns({
      olderThan: new Date('2025-03-01T00:00:00Z'),
      statuses: ['cancelled', 'completed', 'failed'],
    })

    expect(result.count).toBe(1)
    expect(result.prunedRunIds).toEqual([oldRun.id])
    expect(orch.getRun(oldRun.id)).toBeNull()
    expect(orch.listRunTasks(oldRun.id)).toEqual([])
    expect(orch.listRunEvents(oldRun.id)).toEqual([])
    expect(orch.getRun(recentRun.id)).not.toBeNull()

    orch.close()
  })

  it('does not prune non-terminal runs even if old', () => {
    const orch = newOrchestrator()

    const oldActive = orch.createRun({ namespace: 'n', now: new Date('2025-01-01T00:00:00Z') })
    orch.enqueueTask({ runId: oldActive.id, kind: 'k', now: new Date('2025-01-01T00:00:00Z') })

    const result = orch.pruneRuns({ olderThan: new Date('2025-12-31T00:00:00Z') })
    expect(result.count).toBe(0)
    expect(orch.getRun(oldActive.id)).not.toBeNull()

    orch.close()
  })
})

describe('orchestrator.transaction', () => {
  it('commits composite writes atomically', () => {
    const orch = newOrchestrator()

    const result = orch.transaction(() => {
      const run = orch.createRun({ namespace: 'tx' })
      const a = orch.enqueueTask({ runId: run.id, kind: 'a' })
      const b = orch.enqueueTask({ runId: run.id, kind: 'b' })
      return { runId: run.id, a: a.id, b: b.id }
    })

    expect(orch.getRun(result.runId)).not.toBeNull()
    expect(orch.listRunTasks(result.runId)).toHaveLength(2)

    orch.close()
  })

  it('rolls back every write when the callback throws', () => {
    const orch = newOrchestrator()
    const runBefore = orch.listRuns()

    expect(() =>
      orch.transaction(() => {
        const run = orch.createRun({ namespace: 'tx-fail' })
        orch.enqueueTask({ runId: run.id, kind: 'a' })
        throw new Error('boom')
      }),
    ).toThrow(/boom/)

    expect(orch.listRuns().length).toBe(runBefore.length)

    orch.close()
  })
})
