import { toAsyncStore } from './sync-to-async.js'
import { SqliteParallelMcpStore } from './sqlite-store.js'
import type { AsyncParallelMcpStore } from './async-store.js'
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
  ParallelMcpOptions,
  PauseTaskOptions,
  PruneRunsOptions,
  PruneRunsResult,
  ReleaseTaskOptions,
  RequeueDeadTaskOptions,
  ResumeTaskOptions,
  RunRecord,
  TaskRecord,
} from './types.js'

/**
 * Async-facing facade over an {@link AsyncParallelMcpStore}. This is the
 * orchestrator you want when the underlying adapter talks to a real
 * database driver (Postgres, MySQL, …).
 *
 * Structural twin of {@link import('./orchestrator.js').ParallelMcpOrchestrator}:
 * every method returns a `Promise`, the stored `store` field is the
 * underlying async store, and the defaults (`defaultLeaseMs`, `onEvent`)
 * behave identically.
 *
 * Default backing store: when constructed with no argument, wraps a
 * fresh in-memory {@link SqliteParallelMcpStore} through
 * {@link toAsyncStore}. This is convenient for tests but real
 * applications should pass their adapter explicitly.
 */
export class AsyncParallelMcpOrchestrator {
  readonly store: AsyncParallelMcpStore
  readonly defaultLeaseMs: number
  private removeEventListener: (() => void) | null = null

  /**
   * @param store - Underlying async store. Defaults to a
   *                {@link SqliteParallelMcpStore} wrapped with
   *                {@link toAsyncStore}. Pass an explicit adapter in
   *                production (`@razroo/parallel-mcp-postgres`, etc.).
   * @param options - Same shape as the sync orchestrator's options.
   */
  constructor(store: AsyncParallelMcpStore = toAsyncStore(new SqliteParallelMcpStore()), options: ParallelMcpOptions = {}) {
    this.store = store
    this.defaultLeaseMs = options.defaultLeaseMs ?? 30_000
    if (options.onEvent) {
      this.removeEventListener = this.store.addEventListener(options.onEvent)
    }
  }

  /** Close the backing store and detach any registered listener. Idempotent. */
  async close(): Promise<void> {
    if (this.removeEventListener) {
      this.removeEventListener()
      this.removeEventListener = null
    }
    await this.store.close()
  }

  /**
   * Register an observer for every durable event. Returns a detach function.
   * Listener may be sync or async; exceptions are swallowed so observability
   * cannot break writes.
   */
  addEventListener(listener: (event: EventRecord) => void | Promise<void>): () => void {
    return this.store.addEventListener(listener)
  }

  async createRun(options: CreateRunOptions = {}): Promise<RunRecord> {
    return this.store.createRun(options)
  }

  async enqueueTask(options: EnqueueTaskOptions): Promise<TaskRecord> {
    return this.store.enqueueTask(options)
  }

  async claimNextTask(options: ClaimTaskOptions): Promise<ClaimTaskResult | null> {
    return this.store.claimNextTask({
      ...options,
      leaseMs: options.leaseMs ?? this.defaultLeaseMs,
    })
  }

  async heartbeatLease(options: HeartbeatLeaseOptions) {
    return this.store.heartbeatLease({
      ...options,
      leaseMs: options.leaseMs ?? this.defaultLeaseMs,
    })
  }

  async markTaskRunning(options: Omit<PauseTaskOptions, 'status' | 'reason'>): Promise<TaskRecord> {
    return this.store.markTaskRunning(options)
  }

  async pauseTask(options: PauseTaskOptions): Promise<TaskRecord> {
    return this.store.pauseTask(options)
  }

  async resumeTask(options: ResumeTaskOptions): Promise<TaskRecord> {
    return this.store.resumeTask(options)
  }

  async completeTask(options: CompleteTaskOptions): Promise<TaskRecord> {
    return this.store.completeTask(options)
  }

  async failTask(options: FailTaskOptions): Promise<TaskRecord> {
    return this.store.failTask(options)
  }

  async releaseTask(options: ReleaseTaskOptions): Promise<TaskRecord> {
    return this.store.releaseTask(options)
  }

  async appendContextSnapshot(options: AppendContextSnapshotOptions): Promise<ContextSnapshotRecord> {
    return this.store.appendContextSnapshot(options)
  }

  async cancelRun(options: CancelRunOptions): Promise<RunRecord> {
    return this.store.cancelRun(options)
  }

  async expireLeases(now?: Date | string | number): Promise<ExpireLeaseResult> {
    return this.store.expireLeases({ now })
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.store.getRun(runId)
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    return this.store.getTask(taskId)
  }

  async listRunTasks(runId: string): Promise<TaskRecord[]> {
    return this.store.listRunTasks(runId)
  }

  async listRunEvents(runId: string): Promise<EventRecord[]> {
    return this.store.listRunEvents(runId)
  }

  async listRuns(options: ListRunsOptions = {}): Promise<RunRecord[]> {
    return this.store.listRuns(options)
  }

  async listPendingTasks(options: ListPendingTasksOptions = {}): Promise<TaskRecord[]> {
    return this.store.listPendingTasks(options)
  }

  async listEventsSince(options: ListEventsSinceOptions = {}): Promise<ListEventsResult> {
    return this.store.listEventsSince(options)
  }

  async pruneRuns(options: PruneRunsOptions): Promise<PruneRunsResult> {
    return this.store.pruneRuns(options)
  }

  async listDeadTasks(options: ListDeadTasksOptions = {}): Promise<TaskRecord[]> {
    return this.store.listDeadTasks(options)
  }

  async requeueDeadTask(options: RequeueDeadTaskOptions): Promise<TaskRecord> {
    return this.store.requeueDeadTask(options)
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.store.transaction(fn)
  }

  async getCurrentContextSnapshot(runId: string): Promise<ContextSnapshotRecord | null> {
    return this.store.getCurrentContextSnapshot(runId)
  }
}
