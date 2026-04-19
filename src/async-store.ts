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
  PauseTaskOptions,
  PruneRunsOptions,
  PruneRunsResult,
  ReleaseTaskOptions,
  ResumeTaskOptions,
  RunRecord,
  TaskLeaseRecord,
  TaskRecord,
  ListDeadTasksOptions,
  RequeueDeadTaskOptions,
} from './types.js'

/**
 * Observer callback for every durable event an async store writes. See
 * `AsyncParallelMcpStore.addEventListener`.
 */
export type AsyncParallelMcpEventListener = (event: EventRecord) => void | Promise<void>

/**
 * Contract every **async** adapter (Postgres, MySQL, Redis-backed, …) must
 * satisfy in order to plug into
 * {@link import('./async-orchestrator.js').AsyncParallelMcpOrchestrator}.
 *
 * This is the structural twin of {@link import('./store.js').ParallelMcpStore}
 * but every method returns a `Promise`. Semantic guarantees are identical:
 *
 * - Typed errors are the same (`LeaseConflictError`, `LeaseExpiredError`,
 *   `RunTerminalError`, `DependencyCycleError`, `InvalidTransitionError`,
 *   `DuplicateTaskKeyError`, `RecordNotFoundError`).
 * - `claimNextTask` must be atomic across writers.
 * - `addEventListener` returns a detach function. Listener errors are
 *   swallowed so observability cannot break writes.
 * - `transaction` runs `fn` inside one atomic unit; adapters that cannot
 *   offer real transactions (e.g. a naive Redis backend) should document
 *   that explicitly and reject with a clear error instead of silently
 *   interleaving writes.
 *
 * Authoring an async adapter?
 *   - Run `@razroo/parallel-mcp-testkit`'s `runAsyncConformanceSuite`.
 *   - Use `toAsyncStore(syncStore)` in tests that do not yet need real I/O.
 */
export interface AsyncParallelMcpStore {
  /** Register an observer. Returns a detach function. */
  addEventListener(listener: AsyncParallelMcpEventListener): () => void
  /**
   * Close the backing connection / pool. Idempotent. After `close()`, any
   * further method call must reject.
   */
  close(): Promise<void>
  /**
   * Run `fn` inside one atomic transaction. Every durable write performed
   * inside commits or rolls back as one unit.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>

  createRun(options: CreateRunOptions): Promise<RunRecord>
  enqueueTask(options: EnqueueTaskOptions): Promise<TaskRecord>
  claimNextTask(options: ClaimTaskOptions): Promise<ClaimTaskResult | null>
  heartbeatLease(options: HeartbeatLeaseOptions): Promise<TaskLeaseRecord>
  markTaskRunning(options: Omit<PauseTaskOptions, 'status' | 'reason'>): Promise<TaskRecord>
  pauseTask(options: PauseTaskOptions): Promise<TaskRecord>
  resumeTask(options: ResumeTaskOptions): Promise<TaskRecord>
  completeTask(options: CompleteTaskOptions): Promise<TaskRecord>
  failTask(options: FailTaskOptions): Promise<TaskRecord>
  releaseTask(options: ReleaseTaskOptions): Promise<TaskRecord>
  appendContextSnapshot(options: AppendContextSnapshotOptions): Promise<ContextSnapshotRecord>
  cancelRun(options: CancelRunOptions): Promise<RunRecord>
  expireLeases(options?: { now?: Date | string | number | undefined }): Promise<ExpireLeaseResult>

  getRun(runId: string): Promise<RunRecord | null>
  getTask(taskId: string): Promise<TaskRecord | null>
  getCurrentContextSnapshot(runId: string): Promise<ContextSnapshotRecord | null>
  listRunTasks(runId: string): Promise<TaskRecord[]>
  listRunEvents(runId: string): Promise<EventRecord[]>
  listRuns(options?: ListRunsOptions): Promise<RunRecord[]>
  listPendingTasks(options?: ListPendingTasksOptions): Promise<TaskRecord[]>
  listEventsSince(options?: ListEventsSinceOptions): Promise<ListEventsResult>
  pruneRuns(options: PruneRunsOptions): Promise<PruneRunsResult>

  /**
   * List tasks currently parked in the dead-letter queue. A task enters the
   * DLQ when `maxAttempts` has been exhausted; its last `error` is
   * preserved on the {@link TaskRecord} for operator triage.
   */
  listDeadTasks(options?: ListDeadTasksOptions): Promise<TaskRecord[]>
  /**
   * Requeue a task that exhausted its retry budget. Resets `attemptCount`
   * to `0` (unless `resetAttempts: false`), clears `error`, and returns the
   * task to `queued` so a future `claimNextTask` can pick it up.
   */
  requeueDeadTask(options: RequeueDeadTaskOptions): Promise<TaskRecord>
}
