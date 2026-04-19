import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AsyncParallelMcpOrchestrator } from '@razroo/parallel-mcp'
import {
  DependencyCycleError,
  DuplicateTaskKeyError,
  InvalidTransitionError,
  LeaseConflictError,
  LeaseExpiredError,
  RunTerminalError,
} from '@razroo/parallel-mcp'

/**
 * Context returned by {@link AsyncConformanceSuiteOptions.createOrchestrator}.
 * Adapter authors produce a fresh async orchestrator per test plus an
 * optional cleanup that will run after `close()`.
 */
export interface AsyncConformanceFactoryContext {
  orchestrator: AsyncParallelMcpOrchestrator
  cleanup?: () => Promise<void> | void
}

/** Options accepted by {@link runAsyncConformanceSuite}. */
export interface AsyncConformanceSuiteOptions {
  label: string
  createOrchestrator: () =>
    | Promise<AsyncConformanceFactoryContext>
    | AsyncConformanceFactoryContext
  timeScale?: number
  supportsLeaseExpiry?: boolean
  /**
   * Whether the underlying store can atomically commit a transaction
   * body that spans `await` boundaries. True for native async stores
   * (e.g. Postgres); false for `toAsyncStore`-wrapped sync stores, which
   * cannot hold a commit across microtask gaps. Defaults to `true`.
   */
  supportsAwaitedTransactions?: boolean
}

/**
 * Async-flavored conformance suite. Mirror of {@link runConformanceSuite}
 * but exercises the {@link AsyncParallelMcpOrchestrator} surface so
 * async-backed adapters (Postgres, MySQL, Redis) can prove they satisfy
 * the same contract.
 *
 * ```ts
 * import { runAsyncConformanceSuite } from '@razroo/parallel-mcp-testkit'
 *
 * runAsyncConformanceSuite({
 *   label: 'postgres',
 *   createOrchestrator: async () => ({
 *     orchestrator: await buildAsyncPgOrchestrator(),
 *     cleanup: async () => dropSchema(),
 *   }),
 * })
 * ```
 */
export function runAsyncConformanceSuite(options: AsyncConformanceSuiteOptions): void {
  const timeScale = options.timeScale ?? 1
  const supportsLeaseExpiry = options.supportsLeaseExpiry ?? true
  const supportsAwaitedTransactions = options.supportsAwaitedTransactions ?? true

  describe(`@razroo/parallel-mcp async conformance: ${options.label}`, () => {
    let orchestrator: AsyncParallelMcpOrchestrator
    let cleanup: (() => Promise<void> | void) | undefined

    beforeEach(async () => {
      const ctx = await options.createOrchestrator()
      orchestrator = ctx.orchestrator
      cleanup = ctx.cleanup
    })

    afterEach(async () => {
      try {
        await orchestrator.close()
      } catch {
        // ignore double-close
      }
      if (cleanup) await cleanup()
    })

    describe('run lifecycle', () => {
      it('creates runs and returns them by id', async () => {
        const run = await orchestrator.createRun({ namespace: 'conf', externalId: 'alpha' })
        expect(run.status).toBe('pending')
        expect((await orchestrator.getRun(run.id))?.id).toBe(run.id)
        expect(await orchestrator.getRun('not-a-run')).toBeNull()
      })

      it('rejects new tasks on terminal runs', async () => {
        const run = await orchestrator.createRun({ namespace: 'conf' })
        await orchestrator.cancelRun({ runId: run.id })
        await expect(
          orchestrator.enqueueTask({ runId: run.id, kind: 'work' }),
        ).rejects.toBeInstanceOf(RunTerminalError)
      })

      it('rejects duplicate task keys inside the same run', async () => {
        const run = await orchestrator.createRun({ namespace: 'conf' })
        await orchestrator.enqueueTask({ runId: run.id, kind: 'work', key: 'once' })
        await expect(
          orchestrator.enqueueTask({ runId: run.id, kind: 'work', key: 'once' }),
        ).rejects.toBeInstanceOf(DuplicateTaskKeyError)
      })

      it('rejects dependency cycles', async () => {
        const run = await orchestrator.createRun({ namespace: 'conf' })
        const a = await orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        await expect(
          orchestrator.enqueueTask({
            runId: run.id,
            kind: 'work',
            dependsOnTaskIds: [a.id],
            id: a.id,
          }),
        ).rejects.toBeInstanceOf(DependencyCycleError)
      })
    })

    describe('task lifecycle', () => {
      it('claims, heartbeats, and completes a task', async () => {
        const run = await orchestrator.createRun({ namespace: 'conf' })
        const task = await orchestrator.enqueueTask({ runId: run.id, kind: 'work', input: { n: 1 } })

        const claim = await orchestrator.claimNextTask({ workerId: 'w-1' })
        expect(claim).not.toBeNull()
        expect(claim!.task.id).toBe(task.id)

        const running = await orchestrator.markTaskRunning({
          taskId: task.id,
          leaseId: claim!.lease.id,
          workerId: 'w-1',
        })
        expect(running.status).toBe('running')

        await orchestrator.heartbeatLease({
          taskId: task.id,
          leaseId: claim!.lease.id,
          workerId: 'w-1',
        })

        const completed = await orchestrator.completeTask({
          taskId: task.id,
          leaseId: claim!.lease.id,
          workerId: 'w-1',
          output: { done: true },
        })
        expect(completed.status).toBe('completed')
        expect(completed.output).toEqual({ done: true })
      })

      it('claimNextTask returns null when no tasks are ready', async () => {
        const run = await orchestrator.createRun({ namespace: 'conf' })
        await orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        await orchestrator.claimNextTask({ workerId: 'w-1' })
        expect(await orchestrator.claimNextTask({ workerId: 'w-2' })).toBeNull()
      })

      it('only one worker wins the claim when two race for the same task', async () => {
        const run = await orchestrator.createRun({ namespace: 'conf' })
        await orchestrator.enqueueTask({ runId: run.id, kind: 'work' })

        const first = await orchestrator.claimNextTask({ workerId: 'a' })
        const second = await orchestrator.claimNextTask({ workerId: 'b' })
        expect(first).not.toBeNull()
        expect(second).toBeNull()
      })

      it('rejects writes from a worker that does not own the lease', async () => {
        const run = await orchestrator.createRun({ namespace: 'conf' })
        const task = await orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        const claim = (await orchestrator.claimNextTask({ workerId: 'owner' }))!

        await expect(
          orchestrator.completeTask({
            taskId: task.id,
            leaseId: claim.lease.id,
            workerId: 'intruder',
          }),
        ).rejects.toBeInstanceOf(LeaseConflictError)
      })

      it('rejects illegal state transitions', async () => {
        const run = await orchestrator.createRun({ namespace: 'conf' })
        const task = await orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        const claim = (await orchestrator.claimNextTask({ workerId: 'w-1' }))!
        await orchestrator.completeTask({
          taskId: task.id,
          leaseId: claim.lease.id,
          workerId: 'w-1',
        })

        await expect(
          orchestrator.resumeTask({ taskId: task.id }),
        ).rejects.toBeInstanceOf(InvalidTransitionError)
      })

      it('releases a task without consuming an attempt', async () => {
        const run = await orchestrator.createRun({ namespace: 'conf' })
        const task = await orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        const claim = (await orchestrator.claimNextTask({ workerId: 'w-1' }))!

        await orchestrator.releaseTask({
          taskId: task.id,
          leaseId: claim.lease.id,
          workerId: 'w-1',
          reason: 'wrong-shard',
        })

        const again = await orchestrator.claimNextTask({ workerId: 'w-2' })
        expect(again?.task.id).toBe(task.id)
      })

      it('pauses and resumes a blocked task', async () => {
        const run = await orchestrator.createRun({ namespace: 'conf' })
        const task = await orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        const claim = (await orchestrator.claimNextTask({ workerId: 'w-1' }))!

        const paused = await orchestrator.pauseTask({
          taskId: task.id,
          leaseId: claim.lease.id,
          workerId: 'w-1',
          status: 'blocked',
          reason: 'needs-input',
        })
        expect(paused.status).toBe('blocked')

        const resumed = await orchestrator.resumeTask({ taskId: task.id })
        expect(resumed.status).toBe('queued')
      })
    })

    describe('dependencies', () => {
      it('does not hand out a task until its dependencies complete', async () => {
        const run = await orchestrator.createRun({ namespace: 'conf' })
        const a = await orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        const b = await orchestrator.enqueueTask({
          runId: run.id,
          kind: 'work',
          dependsOnTaskIds: [a.id],
        })

        const firstClaim = (await orchestrator.claimNextTask({ workerId: 'w-1' }))!
        expect(firstClaim.task.id).toBe(a.id)

        const secondClaim = await orchestrator.claimNextTask({ workerId: 'w-2' })
        expect(secondClaim).toBeNull()

        await orchestrator.completeTask({
          taskId: a.id,
          leaseId: firstClaim.lease.id,
          workerId: 'w-1',
        })

        const finalClaim = (await orchestrator.claimNextTask({ workerId: 'w-3' }))!
        expect(finalClaim.task.id).toBe(b.id)
      })
    })

    describe('idempotency (clientToken)', () => {
      it('returns the same task on retried completeTask with the same clientToken', async () => {
        const run = await orchestrator.createRun({ namespace: 'conf' })
        const task = await orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        const claim = (await orchestrator.claimNextTask({ workerId: 'w-1' }))!

        const first = await orchestrator.completeTask({
          taskId: task.id,
          leaseId: claim.lease.id,
          workerId: 'w-1',
          output: { ok: true },
          clientToken: 'token-1',
        })
        const second = await orchestrator.completeTask({
          taskId: task.id,
          leaseId: claim.lease.id,
          workerId: 'w-1',
          output: { ok: true },
          clientToken: 'token-1',
        })
        expect(second.id).toBe(first.id)
        expect(second.status).toBe('completed')
      })
    })

    describe('context snapshots', () => {
      it('persists initial context and advances on completion', async () => {
        const run = await orchestrator.createRun({
          namespace: 'conf',
          context: { step: 0 },
        })
        expect((await orchestrator.getCurrentContextSnapshot(run.id))?.payload).toEqual({ step: 0 })

        const task = await orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        const claim = (await orchestrator.claimNextTask({ workerId: 'w-1' }))!
        await orchestrator.completeTask({
          taskId: task.id,
          leaseId: claim.lease.id,
          workerId: 'w-1',
          nextContext: { step: 1 },
          nextContextLabel: 'advance',
        })
        expect((await orchestrator.getCurrentContextSnapshot(run.id))?.payload).toEqual({ step: 1 })
      })
    })

    if (supportsLeaseExpiry) {
      describe('lease expiry + dead-letter queue', () => {
        it('requeues expired leases and increments attempt count', async () => {
          const run = await orchestrator.createRun({ namespace: 'conf' })
          const task = await orchestrator.enqueueTask({
            runId: run.id,
            kind: 'work',
            maxAttempts: 3,
          })
          await orchestrator.claimNextTask({ workerId: 'w-fragile', leaseMs: 10 * timeScale })
          await new Promise(resolve => setTimeout(resolve, 30 * timeScale))
          const expired = await orchestrator.expireLeases()
          expect(expired.count).toBe(1)
          expect(expired.expiredTaskIds).toContain(task.id)

          const requeued = (await orchestrator.getTask(task.id))!
          expect(requeued.status).toBe('queued')
          expect(requeued.attemptCount).toBe(1)
        })

        it('surfaces LeaseExpiredError before the sweeper has run', async () => {
          const run = await orchestrator.createRun({ namespace: 'conf' })
          const task = await orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
          const claim = (await orchestrator.claimNextTask({ workerId: 'w-1', leaseMs: 10 * timeScale }))!
          await new Promise(resolve => setTimeout(resolve, 30 * timeScale))

          await expect(
            orchestrator.completeTask({
              taskId: task.id,
              leaseId: claim.lease.id,
              workerId: 'w-1',
            }),
          ).rejects.toBeInstanceOf(LeaseExpiredError)
        })

        it('parks a task in the DLQ after maxAttempts and revives it via requeueDeadTask', async () => {
          const run = await orchestrator.createRun({ namespace: 'conf' })
          const task = await orchestrator.enqueueTask({
            runId: run.id,
            kind: 'work',
            maxAttempts: 1,
          })
          await orchestrator.claimNextTask({ workerId: 'w-1', leaseMs: 10 * timeScale })
          await new Promise(resolve => setTimeout(resolve, 30 * timeScale))
          await orchestrator.expireLeases()

          const dead = await orchestrator.listDeadTasks()
          expect(dead.map(t => t.id)).toContain(task.id)
          const deadRec = (await orchestrator.getTask(task.id))!
          expect(deadRec.dead).toBe(true)
          expect(deadRec.status).toBe('failed')

          const revived = await orchestrator.requeueDeadTask({ taskId: task.id })
          expect(revived.status).toBe('queued')
          expect(revived.dead).toBe(false)
          expect(revived.attemptCount).toBe(0)
        })
      })
    }

    describe('cancellation', () => {
      it('moves active non-terminal tasks to cancelled', async () => {
        const run = await orchestrator.createRun({ namespace: 'conf' })
        const t1 = await orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        const t2 = await orchestrator.enqueueTask({ runId: run.id, kind: 'work' })

        await orchestrator.cancelRun({ runId: run.id })

        expect((await orchestrator.getTask(t1.id))?.status).toBe('cancelled')
        expect((await orchestrator.getTask(t2.id))?.status).toBe('cancelled')
        expect((await orchestrator.getRun(run.id))?.status).toBe('cancelled')
      })
    })

    describe('admin / introspection', () => {
      it('lists runs and pending tasks', async () => {
        const run = await orchestrator.createRun({ namespace: 'conf-admin' })
        await orchestrator.enqueueTask({ runId: run.id, kind: 'a' })
        await orchestrator.enqueueTask({ runId: run.id, kind: 'b' })

        const runs = await orchestrator.listRuns({ namespace: 'conf-admin' })
        expect(runs.some(r => r.id === run.id)).toBe(true)

        const pending = await orchestrator.listPendingTasks({ runId: run.id })
        expect(pending.map(t => t.kind).sort()).toEqual(['a', 'b'])
      })

      it('paginates events via listEventsSince', async () => {
        const run = await orchestrator.createRun({ namespace: 'conf-events' })
        await orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        await orchestrator.enqueueTask({ runId: run.id, kind: 'work' })

        const first = await orchestrator.listEventsSince({ runId: run.id, limit: 2 })
        expect(first.events.length).toBeLessThanOrEqual(2)
        if (first.nextCursor !== null) {
          const second = await orchestrator.listEventsSince({
            runId: run.id,
            afterId: first.nextCursor,
            limit: 50,
          })
          const combined = [...first.events, ...second.events]
          const ids = combined.map(e => e.id)
          expect(new Set(ids).size).toBe(ids.length)
        }
      })
    })

    describe('retention', () => {
      it('prunes terminal runs older than the cutoff', async () => {
        const oldRun = await orchestrator.createRun({ namespace: 'conf-prune' })
        await orchestrator.cancelRun({ runId: oldRun.id })

        await new Promise(resolve => setTimeout(resolve, 10 * timeScale))
        const activeRun = await orchestrator.createRun({ namespace: 'conf-prune' })

        const cutoff = new Date()
        const result = await orchestrator.pruneRuns({
          olderThan: cutoff,
          statuses: ['cancelled'],
        })
        expect(result.count).toBeGreaterThanOrEqual(1)
        expect(result.prunedRunIds).toContain(oldRun.id)
        expect(await orchestrator.getRun(oldRun.id)).toBeNull()
        expect(await orchestrator.getRun(activeRun.id)).not.toBeNull()
      })
    })

    describe('transaction', () => {
      it.skipIf(!supportsAwaitedTransactions)(
        'commits composite writes spanning awaits atomically',
        async () => {
          const run = await orchestrator.createRun({ namespace: 'conf-tx' })
          await orchestrator.transaction(async () => {
            await orchestrator.enqueueTask({ runId: run.id, kind: 'a' })
            await orchestrator.enqueueTask({ runId: run.id, kind: 'b' })
          })
          expect(await orchestrator.listRunTasks(run.id)).toHaveLength(2)
        },
      )
    })
  })
}
