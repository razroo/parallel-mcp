import { SqliteParallelMcpStore } from './sqlite-store.js'
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

export class ParallelMcpOrchestrator {
  readonly store: SqliteParallelMcpStore
  readonly defaultLeaseMs: number
  private removeEventListener: (() => void) | null = null

  constructor(store = new SqliteParallelMcpStore(), options: ParallelMcpOptions = {}) {
    this.store = store
    this.defaultLeaseMs = options.defaultLeaseMs ?? 30_000
    if (options.onEvent) {
      this.removeEventListener = this.store.addEventListener(options.onEvent)
    }
  }

  close(): void {
    if (this.removeEventListener) {
      this.removeEventListener()
      this.removeEventListener = null
    }
    this.store.close()
  }

  createRun(options: CreateRunOptions = {}): RunRecord {
    return this.store.createRun(options)
  }

  enqueueTask(options: EnqueueTaskOptions): TaskRecord {
    return this.store.enqueueTask(options)
  }

  claimNextTask(options: ClaimTaskOptions): ClaimTaskResult | null {
    return this.store.claimNextTask({
      ...options,
      leaseMs: options.leaseMs ?? this.defaultLeaseMs,
    })
  }

  heartbeatLease(options: HeartbeatLeaseOptions) {
    return this.store.heartbeatLease({
      ...options,
      leaseMs: options.leaseMs ?? this.defaultLeaseMs,
    })
  }

  markTaskRunning(options: Omit<PauseTaskOptions, 'status' | 'reason'>): TaskRecord {
    return this.store.markTaskRunning(options)
  }

  pauseTask(options: PauseTaskOptions): TaskRecord {
    return this.store.pauseTask(options)
  }

  resumeTask(options: ResumeTaskOptions): TaskRecord {
    return this.store.resumeTask(options)
  }

  completeTask(options: CompleteTaskOptions): TaskRecord {
    return this.store.completeTask(options)
  }

  failTask(options: FailTaskOptions): TaskRecord {
    return this.store.failTask(options)
  }

  releaseTask(options: ReleaseTaskOptions): TaskRecord {
    return this.store.releaseTask(options)
  }

  appendContextSnapshot(options: AppendContextSnapshotOptions): ContextSnapshotRecord {
    return this.store.appendContextSnapshot(options)
  }

  cancelRun(options: CancelRunOptions): RunRecord {
    return this.store.cancelRun(options)
  }

  expireLeases(now?: Date | string | number): ExpireLeaseResult {
    return this.store.expireLeases({ now })
  }

  getRun(runId: string): RunRecord | null {
    return this.store.getRun(runId)
  }

  getTask(taskId: string): TaskRecord | null {
    return this.store.getTask(taskId)
  }

  listRunTasks(runId: string): TaskRecord[] {
    return this.store.listRunTasks(runId)
  }

  listRunEvents(runId: string): EventRecord[] {
    return this.store.listRunEvents(runId)
  }

  listRuns(options: ListRunsOptions = {}): RunRecord[] {
    return this.store.listRuns(options)
  }

  listPendingTasks(options: ListPendingTasksOptions = {}): TaskRecord[] {
    return this.store.listPendingTasks(options)
  }

  listEventsSince(options: ListEventsSinceOptions = {}): ListEventsResult {
    return this.store.listEventsSince(options)
  }

  pruneRuns(options: PruneRunsOptions): PruneRunsResult {
    return this.store.pruneRuns(options)
  }

  transaction<T>(fn: () => T): T {
    return this.store.transaction(fn)
  }

  getCurrentContextSnapshot(runId: string): ContextSnapshotRecord | null {
    return this.store.getCurrentContextSnapshot(runId)
  }
}
