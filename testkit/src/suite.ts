import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ParallelMcpOrchestrator } from '@razroo/parallel-mcp'
import {
  DependencyCycleError,
  DuplicateTaskKeyError,
  InvalidTransitionError,
  LeaseConflictError,
  LeaseExpiredError,
  RunTerminalError,
} from '@razroo/parallel-mcp'

/**
 * Context provided to the conformance factory for each test. Implementations
 * return a fresh `ParallelMcpOrchestrator` bound to their adapter and a
 * cleanup hook that the testkit will call after the case.
 */
export interface ConformanceFactoryContext {
  /** Adapter-produced orchestrator. Must be fully isolated per test. */
  orchestrator: ParallelMcpOrchestrator
  /** Optional cleanup; called from `afterEach`. `orchestrator.close()` is always called too. */
  cleanup?: () => Promise<void> | void
}

/** Options accepted by {@link runConformanceSuite}. */
export interface ConformanceSuiteOptions {
  /** Human-readable label for the adapter under test. Shown in the `describe` block. */
  label: string
  /** Factory invoked per test to produce a fresh orchestrator. */
  createOrchestrator: () => Promise<ConformanceFactoryContext> | ConformanceFactoryContext
  /** Optional ms multiplier for timing-sensitive tests (e.g. remote adapters need bigger leases). Default `1`. */
  timeScale?: number
  /**
   * Some tests exercise lease expiry and require a working `expireLeases`.
   * Default `true`. Adapters without that capability can set this `false` to
   * skip those cases while still covering the rest of the contract.
   */
  supportsLeaseExpiry?: boolean
}

/**
 * Run the `@razroo/parallel-mcp` conformance suite against an arbitrary
 * orchestrator/store implementation. Adapters can import this from their own
 * Vitest test file to assert their adapter satisfies the library's lifecycle
 * and invariants.
 *
 * ```ts
 * import { runConformanceSuite } from '@razroo/parallel-mcp-testkit'
 * import { createMyOrchestrator } from '../src/index.js'
 *
 * runConformanceSuite({
 *   label: 'postgres adapter',
 *   createOrchestrator: async () => ({
 *     orchestrator: await createMyOrchestrator(),
 *     cleanup: async () => {\/* drop schema *\/},
 *   }),
 * })
 * ```
 */
export function runConformanceSuite(options: ConformanceSuiteOptions): void {
  const timeScale = options.timeScale ?? 1
  const supportsLeaseExpiry = options.supportsLeaseExpiry ?? true

  describe(`@razroo/parallel-mcp conformance: ${options.label}`, () => {
    let orchestrator: ParallelMcpOrchestrator
    let cleanup: (() => Promise<void> | void) | undefined

    beforeEach(async () => {
      const ctx = await options.createOrchestrator()
      orchestrator = ctx.orchestrator
      cleanup = ctx.cleanup
    })

    afterEach(async () => {
      try {
        orchestrator.close()
      } catch {
        // ignore double-close; adapters may already have closed
      }
      if (cleanup) await cleanup()
    })

    describe('run lifecycle', () => {
      it('creates runs and returns them by id', () => {
        const run = orchestrator.createRun({ namespace: 'conf', externalId: 'alpha' })
        expect(run.status).toBe('pending')
        expect(orchestrator.getRun(run.id)?.id).toBe(run.id)
        expect(orchestrator.getRun('not-a-run')).toBeNull()
      })

      it('rejects new tasks on terminal runs', () => {
        const run = orchestrator.createRun({ namespace: 'conf' })
        orchestrator.cancelRun({ runId: run.id })
        expect(() =>
          orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        ).toThrow(RunTerminalError)
      })

      it('rejects duplicate task keys inside the same run', () => {
        const run = orchestrator.createRun({ namespace: 'conf' })
        orchestrator.enqueueTask({ runId: run.id, kind: 'work', key: 'once' })
        expect(() =>
          orchestrator.enqueueTask({ runId: run.id, kind: 'work', key: 'once' })
        ).toThrow(DuplicateTaskKeyError)
      })

      it('rejects dependency cycles', () => {
        const run = orchestrator.createRun({ namespace: 'conf' })
        const a = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        expect(() =>
          orchestrator.enqueueTask({
            runId: run.id,
            kind: 'work',
            dependsOnTaskIds: [a.id],
            id: a.id,
          })
        ).toThrow(DependencyCycleError)
      })
    })

    describe('task lifecycle', () => {
      it('claims, heartbeats, and completes a task', () => {
        const run = orchestrator.createRun({ namespace: 'conf' })
        const task = orchestrator.enqueueTask({ runId: run.id, kind: 'work', input: { n: 1 } })

        const claim = orchestrator.claimNextTask({ workerId: 'w-1' })
        expect(claim).not.toBeNull()
        expect(claim!.task.id).toBe(task.id)

        const running = orchestrator.markTaskRunning({
          taskId: task.id,
          leaseId: claim!.lease.id,
          workerId: 'w-1',
        })
        expect(running.status).toBe('running')

        orchestrator.heartbeatLease({
          taskId: task.id,
          leaseId: claim!.lease.id,
          workerId: 'w-1',
        })

        const completed = orchestrator.completeTask({
          taskId: task.id,
          leaseId: claim!.lease.id,
          workerId: 'w-1',
          output: { done: true },
        })
        expect(completed.status).toBe('completed')
        expect(completed.output).toEqual({ done: true })
      })

      it('claimNextTask returns null when no tasks are ready', () => {
        const run = orchestrator.createRun({ namespace: 'conf' })
        orchestrator.enqueueTask({
          runId: run.id,
          kind: 'work',
          dependsOnTaskIds: [],
        })
        orchestrator.claimNextTask({ workerId: 'w-1' })
        expect(orchestrator.claimNextTask({ workerId: 'w-2' })).toBeNull()
      })

      it('only one worker wins the claim when two race for the same task', () => {
        const run = orchestrator.createRun({ namespace: 'conf' })
        orchestrator.enqueueTask({ runId: run.id, kind: 'work' })

        const first = orchestrator.claimNextTask({ workerId: 'a' })
        const second = orchestrator.claimNextTask({ workerId: 'b' })
        expect(first).not.toBeNull()
        expect(second).toBeNull()
      })

      it('rejects writes from a worker that does not own the lease', () => {
        const run = orchestrator.createRun({ namespace: 'conf' })
        const task = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        const claim = orchestrator.claimNextTask({ workerId: 'owner' })!

        expect(() =>
          orchestrator.completeTask({
            taskId: task.id,
            leaseId: claim.lease.id,
            workerId: 'intruder',
          })
        ).toThrow(LeaseConflictError)
      })

      it('rejects illegal state transitions (pauseTask on a completed task)', () => {
        const run = orchestrator.createRun({ namespace: 'conf' })
        const task = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        const claim = orchestrator.claimNextTask({ workerId: 'w-1' })!
        orchestrator.completeTask({
          taskId: task.id,
          leaseId: claim.lease.id,
          workerId: 'w-1',
        })

        const secondRun = orchestrator.createRun({ namespace: 'conf' })
        const secondTask = orchestrator.enqueueTask({ runId: secondRun.id, kind: 'work' })
        const secondClaim = orchestrator.claimNextTask({ workerId: 'w-2' })!
        orchestrator.completeTask({
          taskId: secondTask.id,
          leaseId: secondClaim.lease.id,
          workerId: 'w-2',
        })

        expect(() =>
          orchestrator.resumeTask({ taskId: secondTask.id })
        ).toThrow(InvalidTransitionError)
      })

      it('releases a task without consuming an attempt', () => {
        const run = orchestrator.createRun({ namespace: 'conf' })
        const task = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        const claim = orchestrator.claimNextTask({ workerId: 'w-1' })!

        orchestrator.releaseTask({
          taskId: task.id,
          leaseId: claim.lease.id,
          workerId: 'w-1',
          reason: 'wrong-shard',
        })

        const again = orchestrator.claimNextTask({ workerId: 'w-2' })
        expect(again?.task.id).toBe(task.id)
      })

      it('pauses and resumes a blocked task', () => {
        const run = orchestrator.createRun({ namespace: 'conf' })
        const task = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        const claim = orchestrator.claimNextTask({ workerId: 'w-1' })!

        const paused = orchestrator.pauseTask({
          taskId: task.id,
          leaseId: claim.lease.id,
          workerId: 'w-1',
          status: 'blocked',
          reason: 'needs-input',
        })
        expect(paused.status).toBe('blocked')

        const resumed = orchestrator.resumeTask({ taskId: task.id })
        expect(resumed.status).toBe('queued')
      })
    })

    describe('dependencies', () => {
      it('does not hand out a task until its dependencies complete', () => {
        const run = orchestrator.createRun({ namespace: 'conf' })
        const a = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        const b = orchestrator.enqueueTask({
          runId: run.id,
          kind: 'work',
          dependsOnTaskIds: [a.id],
        })

        const firstClaim = orchestrator.claimNextTask({ workerId: 'w-1' })!
        expect(firstClaim.task.id).toBe(a.id)

        const secondClaim = orchestrator.claimNextTask({ workerId: 'w-2' })
        expect(secondClaim).toBeNull()

        orchestrator.completeTask({
          taskId: a.id,
          leaseId: firstClaim.lease.id,
          workerId: 'w-1',
        })

        const finalClaim = orchestrator.claimNextTask({ workerId: 'w-3' })!
        expect(finalClaim.task.id).toBe(b.id)
      })
    })

    describe('idempotency (clientToken)', () => {
      it('returns the same task on retried completeTask with the same clientToken', () => {
        const run = orchestrator.createRun({ namespace: 'conf' })
        const task = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        const claim = orchestrator.claimNextTask({ workerId: 'w-1' })!

        const first = orchestrator.completeTask({
          taskId: task.id,
          leaseId: claim.lease.id,
          workerId: 'w-1',
          output: { ok: true },
          clientToken: 'token-1',
        })
        const second = orchestrator.completeTask({
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
      it('persists initial context and advances on completion', () => {
        const run = orchestrator.createRun({
          namespace: 'conf',
          context: { step: 0 },
        })
        expect(orchestrator.getCurrentContextSnapshot(run.id)?.payload).toEqual({ step: 0 })

        const task = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        const claim = orchestrator.claimNextTask({ workerId: 'w-1' })!
        orchestrator.completeTask({
          taskId: task.id,
          leaseId: claim.lease.id,
          workerId: 'w-1',
          nextContext: { step: 1 },
          nextContextLabel: 'advance',
        })
        expect(orchestrator.getCurrentContextSnapshot(run.id)?.payload).toEqual({ step: 1 })
      })
    })

    if (supportsLeaseExpiry) {
      describe('lease expiry', () => {
        it('requeues expired leases and increments attempt count', async () => {
          const run = orchestrator.createRun({ namespace: 'conf' })
          const task = orchestrator.enqueueTask({
            runId: run.id,
            kind: 'work',
            maxAttempts: 3,
          })
          orchestrator.claimNextTask({
            workerId: 'w-fragile',
            leaseMs: 10 * timeScale,
          })
          await new Promise(resolve => setTimeout(resolve, 30 * timeScale))
          const expired = orchestrator.expireLeases()
          expect(expired.count).toBe(1)
          expect(expired.expiredTaskIds).toContain(task.id)

          const requeued = orchestrator.getTask(task.id)!
          expect(requeued.status).toBe('queued')
          expect(requeued.attemptCount).toBe(1)
        })

        it('surfaces LeaseExpiredError before the sweeper has run', async () => {
          const run = orchestrator.createRun({ namespace: 'conf' })
          const task = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
          const claim = orchestrator.claimNextTask({
            workerId: 'w-1',
            leaseMs: 10 * timeScale,
          })!
          await new Promise(resolve => setTimeout(resolve, 30 * timeScale))

          expect(() =>
            orchestrator.completeTask({
              taskId: task.id,
              leaseId: claim.lease.id,
              workerId: 'w-1',
            })
          ).toThrow(LeaseExpiredError)
        })

        it('surfaces LeaseConflictError after the sweeper has requeued the task', async () => {
          const run = orchestrator.createRun({ namespace: 'conf' })
          const task = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
          const claim = orchestrator.claimNextTask({
            workerId: 'w-1',
            leaseMs: 10 * timeScale,
          })!
          await new Promise(resolve => setTimeout(resolve, 30 * timeScale))
          orchestrator.expireLeases()

          expect(() =>
            orchestrator.completeTask({
              taskId: task.id,
              leaseId: claim.lease.id,
              workerId: 'w-1',
            })
          ).toThrow(LeaseConflictError)
        })
      })
    }

    describe('cancellation', () => {
      it('moves active non-terminal tasks to cancelled', () => {
        const run = orchestrator.createRun({ namespace: 'conf' })
        const t1 = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        const t2 = orchestrator.enqueueTask({ runId: run.id, kind: 'work' })

        orchestrator.cancelRun({ runId: run.id })

        expect(orchestrator.getTask(t1.id)?.status).toBe('cancelled')
        expect(orchestrator.getTask(t2.id)?.status).toBe('cancelled')
        expect(orchestrator.getRun(run.id)?.status).toBe('cancelled')
      })
    })

    describe('admin / introspection', () => {
      it('lists runs and pending tasks', () => {
        const run = orchestrator.createRun({ namespace: 'conf-admin' })
        orchestrator.enqueueTask({ runId: run.id, kind: 'a' })
        orchestrator.enqueueTask({ runId: run.id, kind: 'b' })

        const runs = orchestrator.listRuns({ namespace: 'conf-admin' })
        expect(runs.some(r => r.id === run.id)).toBe(true)

        const pending = orchestrator.listPendingTasks({ runId: run.id })
        expect(pending.map(t => t.kind).sort()).toEqual(['a', 'b'])
      })

      it('paginates events via listEventsSince', () => {
        const run = orchestrator.createRun({ namespace: 'conf-events' })
        orchestrator.enqueueTask({ runId: run.id, kind: 'work' })
        orchestrator.enqueueTask({ runId: run.id, kind: 'work' })

        const first = orchestrator.listEventsSince({ runId: run.id, limit: 2 })
        expect(first.events.length).toBeLessThanOrEqual(2)
        if (first.nextCursor !== null) {
          const second = orchestrator.listEventsSince({
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
      it('prunes terminal runs older than the cutoff and leaves active runs alone', async () => {
        const oldRun = orchestrator.createRun({ namespace: 'conf-prune' })
        orchestrator.cancelRun({ runId: oldRun.id })

        await new Promise(resolve => setTimeout(resolve, 10 * timeScale))
        const activeRun = orchestrator.createRun({ namespace: 'conf-prune' })

        const cutoff = new Date()
        const result = orchestrator.pruneRuns({
          olderThan: cutoff,
          statuses: ['cancelled'],
        })
        expect(result.count).toBeGreaterThanOrEqual(1)
        expect(result.prunedRunIds).toContain(oldRun.id)
        expect(orchestrator.getRun(oldRun.id)).toBeNull()
        expect(orchestrator.getRun(activeRun.id)).not.toBeNull()
      })
    })

    describe('transaction', () => {
      it('commits composite writes atomically', () => {
        const run = orchestrator.createRun({ namespace: 'conf-tx' })
        orchestrator.transaction(() => {
          orchestrator.enqueueTask({ runId: run.id, kind: 'a' })
          orchestrator.enqueueTask({ runId: run.id, kind: 'b' })
        })
        expect(orchestrator.listRunTasks(run.id)).toHaveLength(2)
      })

      it('rolls back composite writes when the callback throws', () => {
        const run = orchestrator.createRun({ namespace: 'conf-tx' })
        expect(() =>
          orchestrator.transaction(() => {
            orchestrator.enqueueTask({ runId: run.id, kind: 'a' })
            throw new Error('intentional')
          })
        ).toThrow(/intentional/)
        expect(orchestrator.listRunTasks(run.id)).toHaveLength(0)
      })
    })
  })
}
