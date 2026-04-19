import type { ParallelMcpStore } from './store.js'
import type { AsyncParallelMcpStore, AsyncParallelMcpEventListener } from './async-store.js'
import type {
  AppendContextSnapshotOptions,
  CancelRunOptions,
  ClaimTaskOptions,
  ClaimTaskResult,
  CompleteTaskOptions,
  ContextSnapshotRecord,
  CreateRunOptions,
  EnqueueTaskOptions,
  EventRecord,
  ExpireLeaseResult,
  FailTaskOptions,
  HeartbeatLeaseOptions,
  ListDeadTasksOptions,
  ListEventsResult,
  ListEventsSinceOptions,
  ListPendingTasksOptions,
  ListRunsOptions,
  PauseTaskOptions,
  PruneRunsOptions,
  PruneRunsResult,
  ReleaseTaskOptions,
  RequeueDeadTaskOptions,
  ResumeTaskOptions,
  RunRecord,
  TaskLeaseRecord,
  TaskRecord,
} from './types.js'

type PromiseState<T> =
  | { status: 'pending' }
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }

/**
 * Inspect whether a promise has already settled by the time a handful of
 * microtask turns have drained. Used by `toAsyncStore.transaction` to
 * detect callbacks whose body escaped the enclosing sync transaction via
 * `await` or a timer.
 *
 * We drain several turns because an already-resolved promise's
 * `.then` handler settles one microtask after being attached, and a
 * chain of a few `.then`s still settles deterministically in a bounded
 * number of turns. A genuinely async body (timer, I/O, a pending
 * external promise) will not settle in that budget.
 */
async function inspectPromiseState<T>(p: Promise<T>): Promise<PromiseState<T>> {
  let settled: PromiseState<T> = { status: 'pending' }
  p.then(
    value => {
      settled = { status: 'fulfilled', value }
    },
    reason => {
      settled = { status: 'rejected', reason }
    },
  )
  for (let i = 0; i < 8; i++) {
    if (settled.status !== 'pending') return settled
    await Promise.resolve()
  }
  return settled
}

/**
 * Adapt a synchronous {@link ParallelMcpStore} (e.g.
 * `SqliteParallelMcpStore`) into an {@link AsyncParallelMcpStore}.
 *
 * Every call returns a `Promise` that resolves on the next microtask with
 * the sync store's result. Synchronously thrown errors are rejected on the
 * returned promise. Listener callbacks may be async — their returned
 * promises are awaited *outside* the store's write path so a slow
 * listener cannot block writes.
 *
 * This is used in two places:
 * 1. Tests can exercise the async orchestrator against the battle-tested
 *    SQLite store without depending on Postgres.
 * 2. Library users who already have an in-memory `SqliteParallelMcpStore`
 *    and want to share it with code written against the async API can
 *    wrap it without a second backing store.
 *
 * **Transaction caveat.** A synchronous SQLite store cannot commit across
 * `await` boundaries. `transaction(fn)` will reject any declared `async`
 * callback up front, and any callback whose returned promise is still
 * pending when the underlying sync transaction closes. For cross-`await`
 * transactional work, use a native async store (e.g.
 * `PostgresParallelMcpStore`).
 */
export function toAsyncStore(store: ParallelMcpStore): AsyncParallelMcpStore {
  const listeners = new Map<AsyncParallelMcpEventListener, (event: EventRecord) => void>()

  return {
    addEventListener(listener: AsyncParallelMcpEventListener): () => void {
      const wrapper = (event: EventRecord) => {
        try {
          const maybe = listener(event)
          if (maybe && typeof (maybe as Promise<unknown>).then === 'function') {
            void (maybe as Promise<unknown>).catch(() => {
              /* swallow — observability must not break writes */
            })
          }
        } catch {
          /* swallow — observability must not break writes */
        }
      }
      listeners.set(listener, wrapper)
      const detach = store.addEventListener(wrapper)
      return () => {
        listeners.delete(listener)
        detach()
      }
    },

    async close(): Promise<void> {
      store.close()
    },

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      // A sync store can only commit a sync body, because the underlying
      // `store.transaction(fn)` callback must return before the COMMIT
      // is issued. Any `await` inside `fn` schedules work on the
      // microtask queue that, by construction, will NOT run until after
      // the sync transaction closes — i.e. those writes would land
      // *outside* the transaction.
      //
      // We therefore reject the two shapes that cannot be safely served:
      //
      // 1. Declared `async` callbacks. These always return a genuinely
      //    async promise that cannot resolve inside a sync call frame,
      //    so no isolation is possible.
      // 2. Callbacks that return a Promise which hasn't already settled
      //    by the time `fn()` returns synchronously. We detect this by
      //    racing against a sentinel that resolves on the next microtask.
      //
      // For true cross-`await` transactional work, use a native async
      // store (e.g. `PostgresParallelMcpStore`), whose `transaction`
      // holds a real SQL BEGIN/COMMIT around the awaited body.
      const fnName = (fn as unknown as { constructor?: { name?: string } }).constructor?.name
      if (fnName === 'AsyncFunction') {
        throw new Error(
          'toAsyncStore: transaction() rejected an async callback. ' +
            'A sync store cannot isolate writes across await boundaries. ' +
            'Either refactor the body to be synchronous, or wrap a native ' +
            'AsyncParallelMcpStore (e.g. PostgresParallelMcpStore) instead.',
        )
      }

      let capturedValue: T | undefined
      let capturedPromise: Promise<T> | undefined
      let errorInsideFn: unknown
      let sawReturn = false

      store.transaction(() => {
        try {
          const result = fn() as T | Promise<T>
          if (result && typeof (result as Promise<T>).then === 'function') {
            capturedPromise = result as Promise<T>
          } else {
            capturedValue = result as T
          }
          sawReturn = true
        } catch (err) {
          errorInsideFn = err
          throw err
        }
      })

      if (!sawReturn) throw errorInsideFn
      if (capturedPromise === undefined) {
        return capturedValue as T
      }

      // If `fn` returned a Promise we only guarantee it was *resolved*
      // before the sync transaction closed. Inspect it: if still pending,
      // reject — the enclosing transaction has already committed and we
      // refuse to pretend otherwise.
      const state = await inspectPromiseState(capturedPromise)
      if (state.status === 'pending') {
        throw new Error(
          'toAsyncStore: transaction() callback returned a Promise that ' +
            'was not settled by the time the underlying sync transaction ' +
            'committed. Any writes performed after the first `await` are ' +
            'NOT inside the transaction. Refactor to synchronous, or use a ' +
            'native AsyncParallelMcpStore.',
        )
      }
      if (state.status === 'rejected') throw state.reason
      return state.value
    },

    async createRun(options: CreateRunOptions): Promise<RunRecord> {
      return store.createRun(options)
    },
    async enqueueTask(options: EnqueueTaskOptions): Promise<TaskRecord> {
      return store.enqueueTask(options)
    },
    async claimNextTask(options: ClaimTaskOptions): Promise<ClaimTaskResult | null> {
      return store.claimNextTask(options)
    },
    async heartbeatLease(options: HeartbeatLeaseOptions): Promise<TaskLeaseRecord> {
      return store.heartbeatLease(options)
    },
    async markTaskRunning(options: Omit<PauseTaskOptions, 'status' | 'reason'>): Promise<TaskRecord> {
      return store.markTaskRunning(options)
    },
    async pauseTask(options: PauseTaskOptions): Promise<TaskRecord> {
      return store.pauseTask(options)
    },
    async resumeTask(options: ResumeTaskOptions): Promise<TaskRecord> {
      return store.resumeTask(options)
    },
    async completeTask(options: CompleteTaskOptions): Promise<TaskRecord> {
      return store.completeTask(options)
    },
    async failTask(options: FailTaskOptions): Promise<TaskRecord> {
      return store.failTask(options)
    },
    async releaseTask(options: ReleaseTaskOptions): Promise<TaskRecord> {
      return store.releaseTask(options)
    },
    async appendContextSnapshot(options: AppendContextSnapshotOptions): Promise<ContextSnapshotRecord> {
      return store.appendContextSnapshot(options)
    },
    async cancelRun(options: CancelRunOptions): Promise<RunRecord> {
      return store.cancelRun(options)
    },
    async expireLeases(options?: { now?: Date | string | number | undefined }): Promise<ExpireLeaseResult> {
      return store.expireLeases(options)
    },
    async getRun(runId: string): Promise<RunRecord | null> {
      return store.getRun(runId)
    },
    async getTask(taskId: string): Promise<TaskRecord | null> {
      return store.getTask(taskId)
    },
    async getCurrentContextSnapshot(runId: string): Promise<ContextSnapshotRecord | null> {
      return store.getCurrentContextSnapshot(runId)
    },
    async listRunTasks(runId: string): Promise<TaskRecord[]> {
      return store.listRunTasks(runId)
    },
    async listRunEvents(runId: string): Promise<EventRecord[]> {
      return store.listRunEvents(runId)
    },
    async listRuns(options?: ListRunsOptions): Promise<RunRecord[]> {
      return store.listRuns(options)
    },
    async listPendingTasks(options?: ListPendingTasksOptions): Promise<TaskRecord[]> {
      return store.listPendingTasks(options)
    },
    async listEventsSince(options?: ListEventsSinceOptions): Promise<ListEventsResult> {
      return store.listEventsSince(options)
    },
    async pruneRuns(options: PruneRunsOptions): Promise<PruneRunsResult> {
      return store.pruneRuns(options)
    },
    async listDeadTasks(options?: ListDeadTasksOptions): Promise<TaskRecord[]> {
      return store.listDeadTasks(options)
    },
    async requeueDeadTask(options: RequeueDeadTaskOptions): Promise<TaskRecord> {
      return store.requeueDeadTask(options)
    },
  }
}
