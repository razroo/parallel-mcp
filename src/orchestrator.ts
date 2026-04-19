import { SqliteParallelMcpStore } from './sqlite-store.js'
import type { ParallelMcpStore } from './store.js'
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
  ListEventsResult,
  ListEventsSinceOptions,
  ListPendingTasksOptions,
  ListRunsOptions,
  ParallelMcpOptions,
  PruneRunsOptions,
  PruneRunsResult,
  ReleaseTaskOptions,
  ResumeTaskOptions,
  RunRecord,
  TaskRecord,
  PauseTaskOptions,
} from './types.js'

/**
 * Thin, stable facade over {@link SqliteParallelMcpStore}. This is the class
 * you want to depend on from adapter code — it applies defaults (like
 * `defaultLeaseMs`) and wires optional listeners (like `onEvent`) that the
 * raw store does not.
 *
 * See also:
 * - [`docs/lifecycle.md`](../docs/lifecycle.md) for the state machine
 * - [`docs/failure-modes.md`](../docs/failure-modes.md) for error handling
 * - [`docs/authoring-adapters.md`](../docs/authoring-adapters.md) for a full
 *   walk-through of building a worker on top of this API.
 */
export class ParallelMcpOrchestrator {
  readonly store: ParallelMcpStore
  readonly defaultLeaseMs: number
  private removeEventListener: (() => void) | null = null

  /**
   * @param store - Underlying durable store. Any implementation of
   *                {@link ParallelMcpStore} works — the shipped default is a
   *                fresh in-memory {@link SqliteParallelMcpStore}. Swap in
   *                an alternative adapter (e.g. `@razroo/parallel-mcp-postgres`)
   *                by passing it here.
   * @param options - Orchestrator-level defaults. `defaultLeaseMs` (default
   *                  30_000) is the lease duration used when `claimNextTask`
   *                  / `heartbeatLease` is called without an explicit
   *                  `leaseMs`. `onEvent` registers a synchronous observer
   *                  that fires for every durable event; listener exceptions
   *                  are swallowed so observability cannot break writes.
   */
  constructor(store: ParallelMcpStore = new SqliteParallelMcpStore(), options: ParallelMcpOptions = {}) {
    this.store = store
    this.defaultLeaseMs = options.defaultLeaseMs ?? 30_000
    if (options.onEvent) {
      this.removeEventListener = this.store.addEventListener(options.onEvent)
    }
  }

  /**
   * Close the underlying store and detach any registered event listener.
   * Idempotent and safe to call from `process.on('beforeExit')` handlers.
   */
  close(): void {
    if (this.removeEventListener) {
      this.removeEventListener()
      this.removeEventListener = null
    }
    this.store.close()
  }

  /**
   * Register a synchronous observer for every durable event written by this
   * orchestrator. Returns a detach function. Multiple listeners can be
   * registered at once; they fire in registration order.
   *
   * Listener exceptions are swallowed so observability cannot break writes.
   * Use this to build workers that react to `run.cancelled`, external
   * dashboards, metrics exporters, etc.
   */
  addEventListener(listener: (event: EventRecord) => void): () => void {
    return this.store.addEventListener(listener)
  }

  /**
   * Create a durable run that groups tasks. Optionally seeds an initial
   * context snapshot if `options.context` is provided.
   */
  createRun(options: CreateRunOptions = {}): RunRecord {
    return this.store.createRun(options)
  }

  /**
   * Enqueue a task onto an existing run. Supports dependencies, priority,
   * `maxAttempts`, and a retry policy.
   *
   * @throws {@link RunTerminalError} if the run is already terminal.
   * @throws {@link DuplicateTaskKeyError} if `options.key` is already used in the run.
   * @throws {@link DependencyCycleError} if `dependsOnTaskIds` would form a cycle.
   */
  enqueueTask(options: EnqueueTaskOptions): TaskRecord {
    return this.store.enqueueTask(options)
  }

  /**
   * Atomically claim the next runnable task for a worker. Returns `null` if
   * nothing is currently runnable (no queued tasks, or all of them are gated
   * by `not_before` or unresolved dependencies).
   *
   * When multiple workers race, exactly one wins; the rest see `null` or a
   * different task. Pass a stable `clientToken` to make retries of the claim
   * itself idempotent.
   */
  claimNextTask(options: ClaimTaskOptions): ClaimTaskResult | null {
    return this.store.claimNextTask({
      ...options,
      leaseMs: options.leaseMs ?? this.defaultLeaseMs,
    })
  }

  /**
   * Extend the lease on a claimed task so it does not expire while work is
   * in progress. Call at most every `leaseMs / 3` to stay ahead of the
   * deadline.
   *
   * @throws {@link LeaseConflictError} / {@link LeaseExpiredError}.
   */
  heartbeatLease(options: HeartbeatLeaseOptions) {
    return this.store.heartbeatLease({
      ...options,
      leaseMs: options.leaseMs ?? this.defaultLeaseMs,
    })
  }

  /** Transition a leased task into the `running` state. */
  markTaskRunning(options: Omit<PauseTaskOptions, 'status' | 'reason'>): TaskRecord {
    return this.store.markTaskRunning(options)
  }

  /**
   * Move a leased / running task into `blocked` or `waiting_input`. The lease
   * is released so another worker does not keep heartbeating it.
   */
  pauseTask(options: PauseTaskOptions): TaskRecord {
    return this.store.pauseTask(options)
  }

  /** Return a `blocked` / `waiting_input` task to `queued`. */
  resumeTask(options: ResumeTaskOptions): TaskRecord {
    return this.store.resumeTask(options)
  }

  /**
   * Mark a leased / running task `completed`. Optionally append a new context
   * snapshot (`nextContext`). Pass a stable `clientToken` when the caller may
   * retry across process restarts.
   *
   * @throws {@link LeaseConflictError} / {@link LeaseExpiredError}.
   */
  completeTask(options: CompleteTaskOptions): TaskRecord {
    return this.store.completeTask(options)
  }

  /**
   * Mark a leased / running task `failed`. Retries happen via lease expiry;
   * `failTask` is terminal for the current attempt. Pass a stable
   * `clientToken` when the caller may retry across process restarts.
   */
  failTask(options: FailTaskOptions): TaskRecord {
    return this.store.failTask(options)
  }

  /**
   * Give a leased task back to the queue without consuming an attempt. Use
   * this when a worker decides it is the wrong process to handle the task
   * (graceful drain, wrong capability, etc.).
   */
  releaseTask(options: ReleaseTaskOptions): TaskRecord {
    return this.store.releaseTask(options)
  }

  /**
   * Append an explicit context snapshot for a run or a task. Returns the
   * new snapshot record; its `id` can be referenced from later
   * `enqueueTask({ contextSnapshotId })` calls.
   */
  appendContextSnapshot(options: AppendContextSnapshotOptions): ContextSnapshotRecord {
    return this.store.appendContextSnapshot(options)
  }

  /**
   * Cancel a run. All non-terminal tasks are moved to `cancelled` and all
   * active leases / attempts are closed.
   */
  cancelRun(options: CancelRunOptions): RunRecord {
    return this.store.cancelRun(options)
  }

  /**
   * Expire every lease whose `lease_expires_at` is in the past at `now`.
   * Expired tasks are requeued (respecting `maxAttempts` and retry backoff)
   * or marked `failed` with `error = 'max_attempts_exceeded'`.
   *
   * Run this on a timer from *some* process — see
   * {@link scheduleExpireLeases}.
   */
  expireLeases(now?: Date | string | number): ExpireLeaseResult {
    return this.store.expireLeases({ now })
  }

  /** Fetch a run by id, or `null` if not found. */
  getRun(runId: string): RunRecord | null {
    return this.store.getRun(runId)
  }

  /** Fetch a task by id, or `null` if not found. */
  getTask(taskId: string): TaskRecord | null {
    return this.store.getTask(taskId)
  }

  /** All tasks in a run, ordered by priority DESC then creation time ASC. */
  listRunTasks(runId: string): TaskRecord[] {
    return this.store.listRunTasks(runId)
  }

  /**
   * Full append-only event log for a single run. For resumable / paginated
   * consumption across runs, use {@link listEventsSince}.
   */
  listRunEvents(runId: string): EventRecord[] {
    return this.store.listRunEvents(runId)
  }

  /**
   * Admin listing of runs, optionally filtered by namespace, statuses,
   * externalId, and an updated-at range.
   */
  listRuns(options: ListRunsOptions = {}): RunRecord[] {
    return this.store.listRuns(options)
  }

  /**
   * Admin listing of `queued` tasks across runs, filtered by `runId`,
   * `kinds`, and `readyBy` (respects `not_before`).
   */
  listPendingTasks(options: ListPendingTasksOptions = {}): TaskRecord[] {
    return this.store.listPendingTasks(options)
  }

  /**
   * Paginate the global append-only event log. Returns up to `limit` events
   * strictly after `afterId`, plus a `nextCursor` to pass on the next call.
   * Persist the cursor to build reliable downstream subscribers.
   */
  listEventsSince(options: ListEventsSinceOptions = {}): ListEventsResult {
    return this.store.listEventsSince(options)
  }

  /**
   * Hard-delete terminal runs older than `olderThan`. Cascades to tasks,
   * leases, attempts, dependencies, context snapshots, and events.
   * Non-terminal runs are never pruned, even if old.
   */
  pruneRuns(options: PruneRunsOptions): PruneRunsResult {
    return this.store.pruneRuns(options)
  }

  /**
   * Run `fn` inside an `IMMEDIATE` SQLite transaction. Every durable write
   * performed inside commits or rolls back as one unit. Useful for composite
   * operations (e.g. "append a snapshot *and* enqueue a dependent task").
   */
  transaction<T>(fn: () => T): T {
    return this.store.transaction(fn)
  }

  /** Current run-scoped context snapshot, or `null` if the run has none. */
  getCurrentContextSnapshot(runId: string): ContextSnapshotRecord | null {
    return this.store.getCurrentContextSnapshot(runId)
  }
}
