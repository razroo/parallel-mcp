/** JSON-only primitive value. */
export type JsonPrimitive = string | number | boolean | null
/** Recursive JSON value accepted anywhere this library persists JSON. */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
/** Recursive JSON object. */
export interface JsonObject {
  [key: string]: JsonValue
}

/**
 * Lifecycle status of a run. Non-terminal: `pending`, `active`, `waiting`.
 * Terminal: `completed`, `failed`, `cancelled`.
 */
export type RunStatus = 'pending' | 'active' | 'waiting' | 'completed' | 'failed' | 'cancelled'
/**
 * Lifecycle status of a task. `queued` → `leased` → `running` → terminal
 * (`completed`, `failed`, `cancelled`). `blocked` and `waiting_input` are
 * opt-in pause states that can be resumed back to `queued`.
 */
export type TaskStatus =
  | 'queued'
  | 'leased'
  | 'running'
  | 'blocked'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'cancelled'
/** Lifecycle status of a single task attempt. */
export type AttemptStatus = 'leased' | 'running' | 'completed' | 'failed' | 'expired' | 'released' | 'cancelled'
/** Lifecycle status of a task lease. */
export type LeaseStatus = 'active' | 'expired' | 'released' | 'cancelled'
/** Scope of a context snapshot — whole run or a single task. */
export type ContextScope = 'run' | 'task'

/** Durable record describing a single run. */
export interface RunRecord {
  id: string
  namespace: string | null
  externalId: string | null
  status: RunStatus
  metadata: JsonValue | null
  currentContextSnapshotId: string | null
  createdAt: string
  updatedAt: string
}

/** Strategy used to compute retry delay between attempts. */
export type RetryBackoff = 'fixed' | 'exponential'

/** Per-task retry policy. */
export interface RetryPolicy {
  delayMs?: number
  backoff?: RetryBackoff
  maxDelayMs?: number
}

/** Durable record describing a single task. */
export interface TaskRecord {
  id: string
  runId: string
  key: string | null
  kind: string
  status: TaskStatus
  priority: number
  maxAttempts: number | null
  attemptCount: number
  retryDelayMs: number | null
  retryBackoff: RetryBackoff | null
  retryMaxDelayMs: number | null
  notBefore: string | null
  input: JsonValue | null
  output: JsonValue | null
  metadata: JsonValue | null
  error: string | null
  contextSnapshotId: string | null
  leaseId: string | null
  leasedBy: string | null
  leaseExpiresAt: string | null
  dependsOnTaskIds: string[]
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
}

/** Durable record for one attempt at running a task. */
export interface TaskAttemptRecord {
  id: string
  runId: string
  taskId: string
  workerId: string
  status: AttemptStatus
  leasedAt: string
  startedAt: string | null
  endedAt: string | null
  leaseExpiresAt: string
  error: string | null
  output: JsonValue | null
  metadata: JsonValue | null
}

/** Durable record describing ownership of a task by a worker. */
export interface TaskLeaseRecord {
  id: string
  runId: string
  taskId: string
  attemptId: string
  workerId: string
  status: LeaseStatus
  acquiredAt: string
  expiresAt: string
  heartbeatAt: string | null
  releasedAt: string | null
  clientToken: string | null
}

/** Immutable context snapshot attached to a run or task. */
export interface ContextSnapshotRecord {
  id: string
  runId: string
  taskId: string | null
  scope: ContextScope
  parentSnapshotId: string | null
  label: string | null
  payload: JsonValue
  createdAt: string
}

/** Append-only event log entry. Event `id` is monotonic per store. */
export interface EventRecord {
  id: number
  runId: string
  taskId: string | null
  attemptId: string | null
  eventType: string
  payload: JsonValue
  createdAt: string
}

/** Options accepted by `orchestrator.createRun`. */
export interface CreateRunOptions {
  id?: string
  namespace?: string
  externalId?: string
  metadata?: JsonValue
  /** If provided, also append an initial run-scoped context snapshot. */
  context?: JsonValue
  now?: Date | string | number
}

/** Options accepted by `orchestrator.enqueueTask`. */
export interface EnqueueTaskOptions {
  id?: string
  runId: string
  /** Optional stable key, unique per run. Enables client-side idempotent enqueue. */
  key?: string
  kind: string
  /** Higher priority wins the next claim among equal-age tasks. */
  priority?: number
  maxAttempts?: number
  retry?: RetryPolicy
  input?: JsonValue
  metadata?: JsonValue
  contextSnapshotId?: string
  dependsOnTaskIds?: string[]
  now?: Date | string | number
}

/** Options accepted by `orchestrator.claimNextTask`. */
export interface ClaimTaskOptions {
  workerId: string
  leaseMs?: number
  /** Restrict the claim to tasks whose `kind` is in this list. */
  kinds?: string[]
  /** Client-supplied idempotency token for this claim attempt. */
  clientToken?: string
  now?: Date | string | number
}

/** Result returned by a successful `claimNextTask`. */
export interface ClaimTaskResult {
  run: RunRecord
  task: TaskRecord
  attempt: TaskAttemptRecord
  lease: TaskLeaseRecord
}

/** Options accepted by `orchestrator.heartbeatLease`. */
export interface HeartbeatLeaseOptions {
  taskId: string
  leaseId: string
  workerId: string
  leaseMs?: number
  now?: Date | string | number
}

/** Shared shape for any operation that mutates a task via an active lease. */
export interface ActiveLeaseTaskOptions {
  taskId: string
  leaseId: string
  workerId: string
  now?: Date | string | number
}

/** Options for `orchestrator.pauseTask`. */
export interface PauseTaskOptions extends ActiveLeaseTaskOptions {
  status: Extract<TaskStatus, 'blocked' | 'waiting_input'>
  reason?: string
}

/** Options for `orchestrator.completeTask`. Supports client-token idempotency. */
export interface CompleteTaskOptions extends ActiveLeaseTaskOptions {
  output?: JsonValue
  metadata?: JsonValue
  /** Append a new context snapshot as part of the same atomic completion. */
  nextContext?: JsonValue
  nextContextLabel?: string
  clientToken?: string
}

/** Options for `orchestrator.failTask`. Supports client-token idempotency. */
export interface FailTaskOptions extends ActiveLeaseTaskOptions {
  error: string
  metadata?: JsonValue
  clientToken?: string
}

/** Options for `orchestrator.releaseTask`. */
export interface ReleaseTaskOptions extends ActiveLeaseTaskOptions {
  reason?: string
}

/** Options for `orchestrator.resumeTask`. */
export interface ResumeTaskOptions {
  taskId: string
  now?: Date | string | number
}

/** Options for `orchestrator.appendContextSnapshot`. */
export interface AppendContextSnapshotOptions {
  id?: string
  runId: string
  taskId?: string
  scope?: ContextScope
  parentSnapshotId?: string
  label?: string
  payload: JsonValue
  now?: Date | string | number
}

/** Options for `orchestrator.cancelRun`. */
export interface CancelRunOptions {
  runId: string
  reason?: string
  now?: Date | string | number
}

/** Result of `orchestrator.expireLeases()`. */
export interface ExpireLeaseResult {
  expiredTaskIds: string[]
  count: number
}

/** Filter/paginate options for `orchestrator.listRuns`. */
export interface ListRunsOptions {
  namespace?: string
  statuses?: RunStatus[]
  externalId?: string
  updatedAfter?: Date | string | number
  updatedBefore?: Date | string | number
  limit?: number
  offset?: number
  orderBy?: 'created_at' | 'updated_at'
  orderDir?: 'asc' | 'desc'
}

/** Filter options for `orchestrator.listPendingTasks`. */
export interface ListPendingTasksOptions {
  runId?: string
  kinds?: string[]
  /** Only include tasks whose `not_before` is at or before this timestamp. */
  readyBy?: Date | string | number
  limit?: number
}

/** Paging input for `orchestrator.listEventsSince`. */
export interface ListEventsSinceOptions {
  /** Returns events with `id > afterId`. Persist `nextCursor` between calls. */
  afterId?: number
  runId?: string
  eventTypes?: string[]
  limit?: number
}

/** Result of `orchestrator.listEventsSince`. */
export interface ListEventsResult {
  events: EventRecord[]
  /** Pass back as `afterId` to fetch the next page, or `null` when caught up. */
  nextCursor: number | null
}

/** Options for `orchestrator.pruneRuns`. */
export interface PruneRunsOptions {
  /** Only prune terminal runs whose `updated_at` is strictly before this timestamp. */
  olderThan: Date | string | number
  /** Defaults to all terminal statuses (`completed`, `failed`, `cancelled`). */
  statuses?: RunStatus[]
  limit?: number
  now?: Date | string | number
}

/** Result of `orchestrator.pruneRuns`. */
export interface PruneRunsResult {
  prunedRunIds: string[]
  count: number
}

/** Options accepted by the {@link import('./orchestrator.js').ParallelMcpOrchestrator} constructor. */
export interface ParallelMcpOptions {
  /** Default lease duration in ms. Applied when `claimNextTask` / `heartbeatLease` does not override. */
  defaultLeaseMs?: number
  /**
   * Synchronous observer invoked for every durable event. Listener exceptions
   * are swallowed so observability cannot break writes.
   */
  onEvent?: (event: EventRecord) => void
}
