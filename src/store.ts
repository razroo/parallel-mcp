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
} from './types.js'

/**
 * Observer callback for every durable event the store writes. See
 * `ParallelMcpStore.addEventListener`.
 */
export type ParallelMcpEventListener = (event: EventRecord) => void

/**
 * Contract every adapter (SQLite, Postgres, MySQL, etc.) must satisfy in
 * order to plug into {@link import('./orchestrator.js').ParallelMcpOrchestrator}.
 *
 * The orchestrator itself is a thin facade — it applies defaults like
 * `defaultLeaseMs` and wires in `onEvent` — so every real behavior change
 * lives here.
 *
 * Stability guarantee (library post-1.0): this interface is frozen. New
 * methods are additive; removing or renaming a method is a major version.
 * Until 1.0, we may move methods around as adapter authors find edges.
 *
 * Authoring an adapter?
 *   - Start from `@razroo/parallel-mcp-testkit`'s `runConformanceSuite`.
 *   - Keep `claimNextTask` atomic across writers. Treat lease + task update
 *     as one transaction; the testkit has explicit multi-writer races.
 *   - Match the typed errors defined in `./errors.ts` exactly —
 *     `LeaseConflictError`, `LeaseExpiredError`, `RunTerminalError`,
 *     `DependencyCycleError`, `InvalidTransitionError`, `DuplicateTaskKeyError`.
 */
export interface ParallelMcpStore {
  /** Register a synchronous observer. Returns a detach function. */
  addEventListener(listener: ParallelMcpEventListener): () => void
  /**
   * Close the backing connection. Idempotent. After `close()`, any further
   * method call must throw.
   */
  close(): void
  /**
   * Run `fn` inside one atomic transaction. Every durable write performed
   * inside commits or rolls back as one unit.
   */
  transaction<T>(fn: () => T): T

  createRun(options: CreateRunOptions): RunRecord
  enqueueTask(options: EnqueueTaskOptions): TaskRecord
  claimNextTask(options: ClaimTaskOptions): ClaimTaskResult | null
  heartbeatLease(options: HeartbeatLeaseOptions): TaskLeaseRecord
  markTaskRunning(options: Omit<PauseTaskOptions, 'status' | 'reason'>): TaskRecord
  pauseTask(options: PauseTaskOptions): TaskRecord
  resumeTask(options: ResumeTaskOptions): TaskRecord
  completeTask(options: CompleteTaskOptions): TaskRecord
  failTask(options: FailTaskOptions): TaskRecord
  releaseTask(options: ReleaseTaskOptions): TaskRecord
  appendContextSnapshot(options: AppendContextSnapshotOptions): ContextSnapshotRecord
  cancelRun(options: CancelRunOptions): RunRecord
  expireLeases(options?: { now?: Date | string | number | undefined }): ExpireLeaseResult

  getRun(runId: string): RunRecord | null
  getTask(taskId: string): TaskRecord | null
  getCurrentContextSnapshot(runId: string): ContextSnapshotRecord | null
  listRunTasks(runId: string): TaskRecord[]
  listRunEvents(runId: string): EventRecord[]
  listRuns(options?: ListRunsOptions): RunRecord[]
  listPendingTasks(options?: ListPendingTasksOptions): TaskRecord[]
  listEventsSince(options?: ListEventsSinceOptions): ListEventsResult
  pruneRuns(options: PruneRunsOptions): PruneRunsResult
}
