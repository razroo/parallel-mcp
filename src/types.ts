export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject {
  [key: string]: JsonValue
}

export type RunStatus = 'pending' | 'active' | 'waiting' | 'completed' | 'failed' | 'cancelled'
export type TaskStatus =
  | 'queued'
  | 'leased'
  | 'running'
  | 'blocked'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'cancelled'
export type AttemptStatus = 'leased' | 'running' | 'completed' | 'failed' | 'expired' | 'released' | 'cancelled'
export type LeaseStatus = 'active' | 'expired' | 'released' | 'cancelled'
export type ContextScope = 'run' | 'task'

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

export type RetryBackoff = 'fixed' | 'exponential'

export interface RetryPolicy {
  delayMs?: number
  backoff?: RetryBackoff
  maxDelayMs?: number
}

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
}

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

export interface EventRecord {
  id: number
  runId: string
  taskId: string | null
  attemptId: string | null
  eventType: string
  payload: JsonValue
  createdAt: string
}

export interface CreateRunOptions {
  id?: string
  namespace?: string
  externalId?: string
  metadata?: JsonValue
  context?: JsonValue
  now?: Date | string | number
}

export interface EnqueueTaskOptions {
  id?: string
  runId: string
  key?: string
  kind: string
  priority?: number
  maxAttempts?: number
  retry?: RetryPolicy
  input?: JsonValue
  metadata?: JsonValue
  contextSnapshotId?: string
  dependsOnTaskIds?: string[]
  now?: Date | string | number
}

export interface ClaimTaskOptions {
  workerId: string
  leaseMs?: number
  kinds?: string[]
  now?: Date | string | number
}

export interface ClaimTaskResult {
  run: RunRecord
  task: TaskRecord
  attempt: TaskAttemptRecord
  lease: TaskLeaseRecord
}

export interface HeartbeatLeaseOptions {
  taskId: string
  leaseId: string
  workerId: string
  leaseMs?: number
  now?: Date | string | number
}

export interface ActiveLeaseTaskOptions {
  taskId: string
  leaseId: string
  workerId: string
  now?: Date | string | number
}

export interface PauseTaskOptions extends ActiveLeaseTaskOptions {
  status: Extract<TaskStatus, 'blocked' | 'waiting_input'>
  reason?: string
}

export interface CompleteTaskOptions extends ActiveLeaseTaskOptions {
  output?: JsonValue
  metadata?: JsonValue
  nextContext?: JsonValue
  nextContextLabel?: string
}

export interface FailTaskOptions extends ActiveLeaseTaskOptions {
  error: string
  metadata?: JsonValue
}

export interface ReleaseTaskOptions extends ActiveLeaseTaskOptions {
  reason?: string
}

export interface ResumeTaskOptions {
  taskId: string
  now?: Date | string | number
}

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

export interface CancelRunOptions {
  runId: string
  reason?: string
  now?: Date | string | number
}

export interface ExpireLeaseResult {
  expiredTaskIds: string[]
  count: number
}

export interface ParallelMcpOptions {
  defaultLeaseMs?: number
}
