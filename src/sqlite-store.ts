import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import {
  RecordNotFoundError,
  LeaseConflictError,
  LeaseExpiredError,
  RunTerminalError,
  DuplicateTaskKeyError,
  DependencyCycleError,
  InvalidTransitionError,
} from './errors.js'
import { deriveRunStatus, assertTaskTransition } from './state-machine.js'
import { runMigrations } from './migrations.js'
import type {
  AppendContextSnapshotOptions,
  CancelRunOptions,
  ClaimTaskOptions,
  ClaimTaskResult,
  CompleteTaskOptions,
  ContextSnapshotRecord,
  EventRecord,
  ExpireLeaseResult,
  FailTaskOptions,
  HeartbeatLeaseOptions,
  ResumeTaskOptions,
  CreateRunOptions,
  EnqueueTaskOptions,
  ListDeadTasksOptions,
  ListEventsResult,
  ListEventsSinceOptions,
  ListPendingTasksOptions,
  ListRunsOptions,
  PruneRunsOptions,
  PruneRunsResult,
  ReleaseTaskOptions,
  RequeueDeadTaskOptions,
  RunRecord,
  TaskAttemptRecord,
  TaskLeaseRecord,
  TaskRecord,
  JsonValue,
  PauseTaskOptions,
} from './types.js'

type TimestampLike = Date | string | number | undefined

interface RunRow {
  id: string
  namespace: string | null
  external_id: string | null
  status: RunRecord['status']
  metadata: string | null
  current_context_snapshot_id: string | null
  created_at: string
  updated_at: string
}

interface TaskRow {
  id: string
  run_id: string
  task_key: string | null
  kind: string
  status: TaskRecord['status']
  priority: number
  max_attempts: number | null
  attempt_count: number
  retry_delay_ms: number | null
  retry_backoff: 'fixed' | 'exponential' | null
  retry_max_delay_ms: number | null
  timeout_ms: number | null
  not_before: string | null
  input: string | null
  output: string | null
  metadata: string | null
  error: string | null
  context_snapshot_id: string | null
  lease_id: string | null
  leased_by: string | null
  lease_expires_at: string | null
  dead: number
  created_at: string
  updated_at: string
  started_at: string | null
  completed_at: string | null
}

interface AttemptRow {
  id: string
  run_id: string
  task_id: string
  worker_id: string
  status: TaskAttemptRecord['status']
  leased_at: string
  started_at: string | null
  ended_at: string | null
  lease_expires_at: string
  error: string | null
  output: string | null
  metadata: string | null
}

interface LeaseRow {
  id: string
  run_id: string
  task_id: string
  attempt_id: string
  worker_id: string
  status: TaskLeaseRecord['status']
  acquired_at: string
  expires_at: string
  heartbeat_at: string | null
  released_at: string | null
  client_token: string | null
}

interface ContextSnapshotRow {
  id: string
  run_id: string
  task_id: string | null
  scope: ContextSnapshotRecord['scope']
  parent_snapshot_id: string | null
  label: string | null
  payload: string
  created_at: string
}

interface EventRow {
  id: number
  run_id: string
  task_id: string | null
  attempt_id: string | null
  event_type: string
  payload: string
  created_at: string
}

function toIsoTimestamp(now?: TimestampLike): string {
  if (now === undefined) return new Date().toISOString()
  if (now instanceof Date) return now.toISOString()
  if (typeof now === 'number') return new Date(now).toISOString()
  return new Date(now).toISOString()
}

function jsonText(value: JsonValue | undefined | null): string | null {
  if (value === undefined) return null
  return JSON.stringify(value)
}

function parseJson<T extends JsonValue | null>(value: string | null): T {
  if (value === null) return null as T
  return JSON.parse(value) as T
}

function computeNotBefore(task: TaskRecord, nowIso: string): string | null {
  if (task.retryDelayMs === null || task.retryDelayMs <= 0) return null
  const nowMs = new Date(nowIso).getTime()
  const attempt = Math.max(1, task.attemptCount)
  let delay = task.retryDelayMs
  if (task.retryBackoff === 'exponential') {
    delay = task.retryDelayMs * 2 ** (attempt - 1)
  }
  if (task.retryMaxDelayMs !== null && task.retryMaxDelayMs > 0) {
    delay = Math.min(delay, task.retryMaxDelayMs)
  }
  return new Date(nowMs + delay).toISOString()
}

function asRunRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    namespace: row.namespace,
    externalId: row.external_id,
    status: row.status,
    metadata: parseJson(row.metadata),
    currentContextSnapshotId: row.current_context_snapshot_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function asTaskAttemptRecord(row: AttemptRow): TaskAttemptRecord {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    workerId: row.worker_id,
    status: row.status,
    leasedAt: row.leased_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    leaseExpiresAt: row.lease_expires_at,
    error: row.error,
    output: parseJson(row.output),
    metadata: parseJson(row.metadata),
  }
}

function asTaskLeaseRecord(row: LeaseRow): TaskLeaseRecord {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    workerId: row.worker_id,
    status: row.status,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
    releasedAt: row.released_at,
    clientToken: row.client_token,
  }
}

function asContextSnapshotRecord(row: ContextSnapshotRow): ContextSnapshotRecord {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    scope: row.scope,
    parentSnapshotId: row.parent_snapshot_id,
    label: row.label,
    payload: JSON.parse(row.payload) as JsonValue,
    createdAt: row.created_at,
  }
}

function asEventRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    eventType: row.event_type,
    payload: JSON.parse(row.payload) as JsonValue,
    createdAt: row.created_at,
  }
}

/** Construction options for {@link SqliteParallelMcpStore}. */
export interface SqliteParallelMcpStoreOptions {
  /** File path to open. Defaults to `:memory:`. Ignored when `database` is supplied. */
  filename?: string
  /** Pre-built `better-sqlite3` database handle. When provided, the caller owns lifecycle. */
  database?: Database.Database
  /** `busy_timeout` in ms for SQLite lock contention. Defaults to 5000. */
  busyTimeoutMs?: number
}

/** Observer for durable events emitted by the store. */
export type EventListener = (event: EventRecord) => void

/**
 * Durable, transactional persistence layer backing {@link import('./orchestrator.js').ParallelMcpOrchestrator}.
 *
 * Every public method is synchronous and either commits fully or throws —
 * there is no partial state visible between callers. Safe for multi-writer
 * workloads: concurrent processes can open the same file and race on claims.
 *
 * Most applications should depend on the orchestrator; reach for the store
 * directly only when you need raw SQL access (via `store.db`), custom
 * transactions, or you are writing an alternative orchestrator facade.
 */
export class SqliteParallelMcpStore {
  readonly db: Database.Database
  private readonly ownsDatabase: boolean
  private eventListeners: EventListener[] = []

  constructor(options: SqliteParallelMcpStoreOptions = {}) {
    this.db = options.database ?? new Database(options.filename ?? ':memory:')
    this.ownsDatabase = options.database === undefined
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('journal_mode = WAL')
    this.db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`)
    this.migrate()
  }

  /**
   * Register a synchronous observer for every durable event the store emits.
   * Listener exceptions are swallowed so observability cannot break writes.
   *
   * @returns a function that removes the listener when called.
   */
  addEventListener(listener: EventListener): () => void {
    this.eventListeners.push(listener)
    return () => {
      this.eventListeners = this.eventListeners.filter(existing => existing !== listener)
    }
  }

  /**
   * Close the underlying SQLite handle. No-op when the caller supplied their
   * own `database` in the constructor.
   */
  close(): void {
    if (this.ownsDatabase) this.db.close()
  }

  /** Apply any pending schema migrations. Invoked automatically from the constructor. */
  migrate(): void {
    runMigrations(this.db)
  }

  createRun(options: CreateRunOptions = {}): RunRecord {
    const runId = options.id ?? randomUUID()
    const now = toIsoTimestamp(options.now)
    const snapshotId = options.context === undefined ? null : randomUUID()

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO runs (id, namespace, external_id, status, metadata, current_context_snapshot_id, created_at, updated_at)
        VALUES (@id, @namespace, @externalId, 'pending', @metadata, @currentContextSnapshotId, @createdAt, @updatedAt)
      `).run({
        id: runId,
        namespace: options.namespace ?? 'default',
        externalId: options.externalId ?? null,
        metadata: jsonText(options.metadata),
        currentContextSnapshotId: snapshotId,
        createdAt: now,
        updatedAt: now,
      })

      this.insertEvent(runId, null, null, 'run.created', {
        namespace: options.namespace ?? 'default',
        externalId: options.externalId ?? null,
        metadata: options.metadata ?? null,
      }, now)

      if (snapshotId !== null) {
        this.db.prepare(`
          INSERT INTO context_snapshots (id, run_id, task_id, scope, parent_snapshot_id, label, payload, created_at)
          VALUES (@id, @runId, NULL, 'run', NULL, 'run.initial', @payload, @createdAt)
        `).run({
          id: snapshotId,
          runId,
          payload: JSON.stringify(options.context),
          createdAt: now,
        })
        this.insertEvent(runId, null, null, 'context.snapshot.created', {
          snapshotId,
          scope: 'run',
          label: 'run.initial',
        }, now)
      }
    })()

    return this.requireRun(runId)
  }

  enqueueTask(options: EnqueueTaskOptions): TaskRecord {
    const run = this.requireRun(options.runId)
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      throw new RunTerminalError(run.id, run.status)
    }

    const taskId = options.id ?? randomUUID()
    const now = toIsoTimestamp(options.now)
    const dependencies = options.dependsOnTaskIds ?? []

    this.db.transaction(() => {
      if (options.key !== undefined) {
        const existing = this.db.prepare(`
          SELECT id FROM tasks WHERE run_id = ? AND task_key = ?
        `).get(options.runId, options.key) as { id: string } | undefined
        if (existing) {
          throw new DuplicateTaskKeyError(options.runId, options.key)
        }
      }

      if (dependencies.length > 0) {
        if (dependencies.includes(taskId)) {
          throw new DependencyCycleError(`Task ${taskId} cannot depend on itself`)
        }
        const rows = this.db.prepare(`
          SELECT id
          FROM tasks
          WHERE run_id = ? AND id IN (${dependencies.map(() => '?').join(',')})
        `).all(options.runId, ...dependencies) as Array<{ id: string }>

        if (rows.length !== dependencies.length) {
          throw new Error(`One or more dependency task ids do not belong to run ${options.runId}`)
        }
      }

      this.db.prepare(`
        INSERT INTO tasks (
          id, run_id, task_key, kind, status, priority, max_attempts, attempt_count,
          retry_delay_ms, retry_backoff, retry_max_delay_ms, timeout_ms, not_before,
          input, output, metadata, error, context_snapshot_id, lease_id, leased_by, lease_expires_at,
          dead, created_at, updated_at, started_at, completed_at
        )
        VALUES (
          @id, @runId, @taskKey, @kind, 'queued', @priority, @maxAttempts, 0,
          @retryDelayMs, @retryBackoff, @retryMaxDelayMs, @timeoutMs, NULL,
          @input, NULL, @metadata, NULL, @contextSnapshotId, NULL, NULL, NULL,
          0, @createdAt, @updatedAt, NULL, NULL
        )
      `).run({
        id: taskId,
        runId: options.runId,
        taskKey: options.key ?? null,
        kind: options.kind,
        priority: options.priority ?? 0,
        maxAttempts: options.maxAttempts ?? null,
        retryDelayMs: options.retry?.delayMs ?? null,
        retryBackoff: options.retry?.backoff ?? null,
        retryMaxDelayMs: options.retry?.maxDelayMs ?? null,
        timeoutMs: options.timeoutMs ?? null,
        input: jsonText(options.input),
        metadata: jsonText(options.metadata),
        contextSnapshotId: options.contextSnapshotId ?? run.currentContextSnapshotId,
        createdAt: now,
        updatedAt: now,
      })

      for (const dependsOnTaskId of dependencies) {
        this.db.prepare(`
          INSERT INTO task_dependencies (task_id, depends_on_task_id)
          VALUES (?, ?)
        `).run(taskId, dependsOnTaskId)
      }

      this.insertEvent(options.runId, taskId, null, 'task.enqueued', {
        kind: options.kind,
        priority: options.priority ?? 0,
        dependsOnTaskIds: dependencies,
      }, now)

      this.recomputeRunStatus(options.runId, now)
    })()

    return this.requireTask(taskId)
  }

  claimNextTask(options: ClaimTaskOptions): ClaimTaskResult | null {
    const now = toIsoTimestamp(options.now)
    const expiresAt = toIsoTimestamp(new Date(new Date(now).getTime() + (options.leaseMs ?? 30_000)))
    const kinds = options.kinds ?? []
    const clientToken = options.clientToken ?? null

    if (clientToken !== null) {
      const existing = this.db.prepare(`
        SELECT id FROM task_leases WHERE client_token = ?
      `).get(clientToken) as { id: string } | undefined
      if (existing) {
        return this.rehydrateLease(existing.id)
      }
    }

    return this.db.transaction(() => {
      this.expireLeases({ now })

      let sql = `
        SELECT t.*
        FROM tasks t
        JOIN runs r ON r.id = t.run_id
        WHERE t.status = 'queued'
          AND r.status NOT IN ('completed', 'failed', 'cancelled')
          AND (t.not_before IS NULL OR t.not_before <= @now)
          AND (t.max_attempts IS NULL OR t.attempt_count < t.max_attempts)
          AND NOT EXISTS (
            SELECT 1
            FROM task_dependencies d
            JOIN tasks dep ON dep.id = d.depends_on_task_id
            WHERE d.task_id = t.id
              AND dep.status != 'completed'
          )
      `
      const params: Record<string, string> = { now }
      if (kinds.length > 0) {
        const placeholders = kinds.map((_, idx) => `@kind${idx}`)
        sql += ` AND t.kind IN (${placeholders.join(',')})`
        kinds.forEach((kind, idx) => {
          params[`kind${idx}`] = kind
        })
      }
      sql += ' ORDER BY t.priority DESC, t.created_at ASC LIMIT 1'

      const row = this.db.prepare(sql).get(params) as TaskRow | undefined
      if (!row) return null

      assertTaskTransition(row.status, 'leased')
      const attemptId = randomUUID()
      const leaseId = randomUUID()

      const takenRows = this.db.prepare(`
        UPDATE tasks
        SET status = 'leased',
            attempt_count = attempt_count + 1,
            lease_id = @leaseId,
            leased_by = @workerId,
            lease_expires_at = @leaseExpiresAt,
            not_before = NULL,
            updated_at = @updatedAt
        WHERE id = @taskId
          AND status = 'queued'
          AND lease_id IS NULL
      `).run({
        taskId: row.id,
        leaseId,
        workerId: options.workerId,
        leaseExpiresAt: expiresAt,
        updatedAt: now,
      }).changes

      if (takenRows !== 1) {
        return null
      }

      this.db.prepare(`
        INSERT INTO task_attempts (
          id, run_id, task_id, worker_id, status, leased_at, started_at, ended_at, lease_expires_at, error, output, metadata
        )
        VALUES (@id, @runId, @taskId, @workerId, 'leased', @leasedAt, NULL, NULL, @leaseExpiresAt, NULL, NULL, NULL)
      `).run({
        id: attemptId,
        runId: row.run_id,
        taskId: row.id,
        workerId: options.workerId,
        leasedAt: now,
        leaseExpiresAt: expiresAt,
      })

      this.db.prepare(`
        INSERT INTO task_leases (
          id, run_id, task_id, attempt_id, worker_id, status, acquired_at, expires_at, heartbeat_at, released_at, client_token
        )
        VALUES (@id, @runId, @taskId, @attemptId, @workerId, 'active', @acquiredAt, @expiresAt, @heartbeatAt, NULL, @clientToken)
      `).run({
        id: leaseId,
        runId: row.run_id,
        taskId: row.id,
        attemptId,
        workerId: options.workerId,
        acquiredAt: now,
        expiresAt,
        heartbeatAt: now,
        clientToken,
      })

      this.insertEvent(row.run_id, row.id, attemptId, 'task.claimed', {
        workerId: options.workerId,
        leaseId,
        leaseExpiresAt: expiresAt,
      }, now)
      this.recomputeRunStatus(row.run_id, now)

      return {
        run: this.requireRun(row.run_id),
        task: this.requireTask(row.id),
        attempt: this.requireAttempt(attemptId),
        lease: this.requireLease(leaseId),
      }
    }).immediate()
  }

  private rehydrateLease(leaseId: string): ClaimTaskResult {
    const lease = this.requireLease(leaseId)
    return {
      run: this.requireRun(lease.runId),
      task: this.requireTask(lease.taskId),
      attempt: this.requireAttempt(lease.attemptId),
      lease,
    }
  }

  heartbeatLease(options: HeartbeatLeaseOptions): TaskLeaseRecord {
    const now = toIsoTimestamp(options.now)
    const expiresAt = toIsoTimestamp(new Date(new Date(now).getTime() + (options.leaseMs ?? 30_000)))

    return this.db.transaction(() => {
      const task = this.requireTask(options.taskId)
      const active = this.assertActiveLease(task, options.leaseId, options.workerId, now)

      this.db.prepare(`
        UPDATE tasks
        SET lease_expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run(expiresAt, now, task.id)

      this.db.prepare(`
        UPDATE task_attempts
        SET lease_expires_at = ?
        WHERE id = ?
      `).run(expiresAt, active.attempt.id)

      this.db.prepare(`
        UPDATE task_leases
        SET expires_at = ?, heartbeat_at = ?
        WHERE id = ?
      `).run(expiresAt, now, active.lease.id)

      this.insertEvent(task.runId, task.id, active.attempt.id, 'task.lease_heartbeat', {
        workerId: options.workerId,
        leaseId: options.leaseId,
        leaseExpiresAt: expiresAt,
      }, now)

      return this.requireLease(active.lease.id)
    })()
  }

  markTaskRunning(options: Omit<PauseTaskOptions, 'status' | 'reason'>): TaskRecord {
    const now = toIsoTimestamp(options.now)
    return this.db.transaction(() => {
      const task = this.requireTask(options.taskId)
      const active = this.assertActiveLease(task, options.leaseId, options.workerId, now)
      assertTaskTransition(task.status, 'running')

      this.db.prepare(`
        UPDATE tasks
        SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ?
      `).run(now, now, task.id)

      this.db.prepare(`
        UPDATE task_attempts
        SET status = 'running', started_at = COALESCE(started_at, ?)
        WHERE id = ?
      `).run(now, active.attempt.id)

      this.insertEvent(task.runId, task.id, active.attempt.id, 'task.running', {
        workerId: options.workerId,
        leaseId: options.leaseId,
      }, now)
      this.recomputeRunStatus(task.runId, now)
      return this.requireTask(task.id)
    })()
  }

  pauseTask(options: PauseTaskOptions): TaskRecord {
    const now = toIsoTimestamp(options.now)
    return this.db.transaction(() => {
      const task = this.requireTask(options.taskId)
      const active = this.assertActiveLease(task, options.leaseId, options.workerId, now)
      assertTaskTransition(task.status, options.status)

      this.db.prepare(`
        UPDATE tasks
        SET status = @status,
            lease_id = NULL,
            leased_by = NULL,
            lease_expires_at = NULL,
            updated_at = @updatedAt,
            started_at = COALESCE(started_at, @updatedAt)
        WHERE id = @taskId
      `).run({
        status: options.status,
        updatedAt: now,
        taskId: task.id,
      })

      this.db.prepare(`
        UPDATE task_attempts
        SET status = 'released', ended_at = COALESCE(ended_at, ?)
        WHERE id = ?
      `).run(now, active.attempt.id)

      this.db.prepare(`
        UPDATE task_leases
        SET status = 'released', released_at = COALESCE(released_at, ?), heartbeat_at = ?
        WHERE id = ?
      `).run(now, now, active.lease.id)

      this.insertEvent(task.runId, task.id, active.attempt.id, `task.${options.status}`, {
        workerId: options.workerId,
        reason: options.reason ?? null,
      }, now)
      this.recomputeRunStatus(task.runId, now)
      return this.requireTask(task.id)
    })()
  }

  resumeTask(options: ResumeTaskOptions): TaskRecord {
    const now = toIsoTimestamp(options.now)
    return this.db.transaction(() => {
      const task = this.requireTask(options.taskId)
      if (task.status !== 'blocked' && task.status !== 'waiting_input') {
        throw new InvalidTransitionError('task', task.status, 'queued')
      }
      assertTaskTransition(task.status, 'queued')

      this.db.prepare(`
        UPDATE tasks
        SET status = 'queued', updated_at = ?
        WHERE id = ?
      `).run(now, task.id)

      this.insertEvent(task.runId, task.id, null, 'task.resumed', {}, now)
      this.recomputeRunStatus(task.runId, now)
      return this.requireTask(task.id)
    })()
  }

  completeTask(options: CompleteTaskOptions): TaskRecord {
    const now = toIsoTimestamp(options.now)
    if (options.clientToken !== undefined) {
      const prior = this.lookupCompletion(options.clientToken, options.taskId, 'completed')
      if (prior) return prior
    }
    return this.db.transaction(() => {
      const task = this.requireTask(options.taskId)
      const active = this.assertActiveLease(task, options.leaseId, options.workerId, now)
      assertTaskTransition(task.status, 'completed')

      if (options.nextContext !== undefined) {
        const parentSnapshotId = task.contextSnapshotId ?? this.requireRun(task.runId).currentContextSnapshotId ?? null
        this.appendContextSnapshot({
          runId: task.runId,
          taskId: task.id,
          scope: 'run',
          ...(parentSnapshotId ? { parentSnapshotId } : {}),
          label: options.nextContextLabel ?? `${task.kind}.completed`,
          payload: options.nextContext,
          now,
        })
      }

      this.db.prepare(`
        UPDATE tasks
        SET status = 'completed',
            output = @output,
            metadata = COALESCE(@metadata, metadata),
            lease_id = NULL,
            leased_by = NULL,
            lease_expires_at = NULL,
            updated_at = @updatedAt,
            started_at = COALESCE(started_at, @updatedAt),
            completed_at = @updatedAt
        WHERE id = @taskId
      `).run({
        taskId: task.id,
        output: jsonText(options.output),
        metadata: jsonText(options.metadata),
        updatedAt: now,
      })

      this.db.prepare(`
        UPDATE task_attempts
        SET status = 'completed',
            output = @output,
            metadata = COALESCE(@metadata, metadata),
            started_at = COALESCE(started_at, @endedAt),
            ended_at = @endedAt
        WHERE id = @attemptId
      `).run({
        attemptId: active.attempt.id,
        output: jsonText(options.output),
        metadata: jsonText(options.metadata),
        endedAt: now,
      })

      this.db.prepare(`
        UPDATE task_leases
        SET status = 'released', released_at = @releasedAt, heartbeat_at = @heartbeatAt
        WHERE id = @leaseId
      `).run({
        leaseId: active.lease.id,
        releasedAt: now,
        heartbeatAt: now,
      })

      this.insertEvent(task.runId, task.id, active.attempt.id, 'task.completed', {
        workerId: options.workerId,
        output: options.output ?? null,
      }, now)
      if (options.clientToken !== undefined) {
        this.recordCompletion(options.clientToken, task.id, task.runId, 'completed', now)
      }
      this.recomputeRunStatus(task.runId, now)
      return this.requireTask(task.id)
    })()
  }

  failTask(options: FailTaskOptions): TaskRecord {
    const now = toIsoTimestamp(options.now)
    if (options.clientToken !== undefined) {
      const prior = this.lookupCompletion(options.clientToken, options.taskId, 'failed')
      if (prior) return prior
    }
    return this.db.transaction(() => {
      const task = this.requireTask(options.taskId)
      const active = this.assertActiveLease(task, options.leaseId, options.workerId, now)
      assertTaskTransition(task.status, 'failed')

      this.db.prepare(`
        UPDATE tasks
        SET status = 'failed',
            error = @error,
            metadata = COALESCE(@metadata, metadata),
            lease_id = NULL,
            leased_by = NULL,
            lease_expires_at = NULL,
            updated_at = @updatedAt,
            started_at = COALESCE(started_at, @updatedAt),
            completed_at = @updatedAt
        WHERE id = @taskId
      `).run({
        taskId: task.id,
        error: options.error,
        metadata: jsonText(options.metadata),
        updatedAt: now,
      })

      this.db.prepare(`
        UPDATE task_attempts
        SET status = 'failed',
            error = @error,
            metadata = COALESCE(@metadata, metadata),
            started_at = COALESCE(started_at, @endedAt),
            ended_at = @endedAt
        WHERE id = @attemptId
      `).run({
        attemptId: active.attempt.id,
        error: options.error,
        metadata: jsonText(options.metadata),
        endedAt: now,
      })

      this.db.prepare(`
        UPDATE task_leases
        SET status = 'released', released_at = @releasedAt, heartbeat_at = @heartbeatAt
        WHERE id = @leaseId
      `).run({
        leaseId: active.lease.id,
        releasedAt: now,
        heartbeatAt: now,
      })

      this.insertEvent(task.runId, task.id, active.attempt.id, 'task.failed', {
        workerId: options.workerId,
        error: options.error,
      }, now)
      if (options.clientToken !== undefined) {
        this.recordCompletion(options.clientToken, task.id, task.runId, 'failed', now)
      }
      this.recomputeRunStatus(task.runId, now)
      return this.requireTask(task.id)
    })()
  }

  releaseTask(options: ReleaseTaskOptions): TaskRecord {
    const now = toIsoTimestamp(options.now)
    return this.db.transaction(() => {
      const task = this.requireTask(options.taskId)
      const active = this.assertActiveLease(task, options.leaseId, options.workerId, now)
      assertTaskTransition(task.status, 'queued')

      this.db.prepare(`
        UPDATE tasks
        SET status = 'queued',
            lease_id = NULL,
            leased_by = NULL,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(now, task.id)

      this.db.prepare(`
        UPDATE task_attempts
        SET status = 'released', ended_at = COALESCE(ended_at, ?)
        WHERE id = ?
      `).run(now, active.attempt.id)

      this.db.prepare(`
        UPDATE task_leases
        SET status = 'released', released_at = COALESCE(released_at, ?), heartbeat_at = ?
        WHERE id = ?
      `).run(now, now, active.lease.id)

      this.insertEvent(task.runId, task.id, active.attempt.id, 'task.released', {
        workerId: options.workerId,
        reason: options.reason ?? null,
      }, now)
      this.recomputeRunStatus(task.runId, now)
      return this.requireTask(task.id)
    })()
  }

  appendContextSnapshot(options: AppendContextSnapshotOptions): ContextSnapshotRecord {
    const run = this.requireRun(options.runId)
    const now = toIsoTimestamp(options.now)
    const snapshotId = options.id ?? randomUUID()

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO context_snapshots (id, run_id, task_id, scope, parent_snapshot_id, label, payload, created_at)
        VALUES (@id, @runId, @taskId, @scope, @parentSnapshotId, @label, @payload, @createdAt)
      `).run({
        id: snapshotId,
        runId: options.runId,
        taskId: options.taskId ?? null,
        scope: options.scope ?? 'run',
        parentSnapshotId: options.parentSnapshotId ?? run.currentContextSnapshotId,
        label: options.label ?? null,
        payload: JSON.stringify(options.payload),
        createdAt: now,
      })

      if ((options.scope ?? 'run') === 'run') {
        this.db.prepare(`
          UPDATE runs
          SET current_context_snapshot_id = ?, updated_at = ?
          WHERE id = ?
        `).run(snapshotId, now, options.runId)
      }

      if (options.taskId) {
        this.db.prepare(`
          UPDATE tasks
          SET context_snapshot_id = ?, updated_at = ?
          WHERE id = ?
        `).run(snapshotId, now, options.taskId)
      }

      this.insertEvent(options.runId, options.taskId ?? null, null, 'context.snapshot.created', {
        snapshotId,
        scope: options.scope ?? 'run',
        label: options.label ?? null,
      }, now)
    })()

    return this.requireContextSnapshot(snapshotId)
  }

  cancelRun(options: CancelRunOptions): RunRecord {
    const now = toIsoTimestamp(options.now)
    this.db.transaction(() => {
      const run = this.requireRun(options.runId)
      if (run.status === 'cancelled') return

      this.db.prepare(`
        UPDATE runs
        SET status = 'cancelled', updated_at = ?
        WHERE id = ?
      `).run(now, options.runId)

      this.db.prepare(`
        UPDATE tasks
        SET status = 'cancelled',
            lease_id = NULL,
            leased_by = NULL,
            lease_expires_at = NULL,
            updated_at = ?,
            completed_at = COALESCE(completed_at, ?)
        WHERE run_id = ?
          AND status NOT IN ('completed', 'failed', 'cancelled')
      `).run(now, now, options.runId)

      this.db.prepare(`
        UPDATE task_attempts
        SET status = 'cancelled',
            ended_at = COALESCE(ended_at, ?)
        WHERE run_id = ?
          AND status IN ('leased', 'running')
      `).run(now, options.runId)

      this.db.prepare(`
        UPDATE task_leases
        SET status = 'cancelled',
            released_at = COALESCE(released_at, ?),
            heartbeat_at = ?
        WHERE run_id = ?
          AND status = 'active'
      `).run(now, now, options.runId)

      this.insertEvent(options.runId, null, null, 'run.cancelled', {
        reason: options.reason ?? null,
      }, now)
    })()

    return this.requireRun(options.runId)
  }

  expireLeases(options: { now?: TimestampLike } = {}): ExpireLeaseResult {
    const now = toIsoTimestamp(options.now)
    const expiredTasks = this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT id
        FROM tasks
        WHERE status IN ('leased', 'running')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < ?
      `).all(now) as Array<{ id: string }>

      const expiredTaskIds: string[] = []
      for (const row of rows) {
        const task = this.requireTask(row.id)
        if (!task.leaseId) continue
        const lease = this.requireLease(task.leaseId)
        const attempt = this.requireAttempt(lease.attemptId)

        this.db.prepare(`
          UPDATE task_attempts
          SET status = 'expired', ended_at = COALESCE(ended_at, ?)
          WHERE id = ?
        `).run(now, attempt.id)

        this.db.prepare(`
          UPDATE task_leases
          SET status = 'expired', released_at = COALESCE(released_at, ?), heartbeat_at = ?
          WHERE id = ?
        `).run(now, now, lease.id)

        const exhausted = task.maxAttempts !== null && task.attemptCount >= task.maxAttempts
        if (exhausted) {
          this.db.prepare(`
            UPDATE tasks
            SET status = 'failed',
                error = 'max_attempts_exceeded',
                lease_id = NULL,
                leased_by = NULL,
                lease_expires_at = NULL,
                not_before = NULL,
                dead = 1,
                updated_at = ?,
                completed_at = ?
            WHERE id = ?
          `).run(now, now, task.id)

          this.insertEvent(task.runId, task.id, attempt.id, 'task.failed', {
            workerId: task.leasedBy,
            error: 'max_attempts_exceeded',
            attemptCount: task.attemptCount,
            maxAttempts: task.maxAttempts,
          }, now)

          this.insertEvent(task.runId, task.id, attempt.id, 'task.dead_lettered', {
            workerId: task.leasedBy,
            attemptCount: task.attemptCount,
            maxAttempts: task.maxAttempts,
            lastError: 'max_attempts_exceeded',
          }, now)
        } else {
          const notBefore = computeNotBefore(task, now)
          this.db.prepare(`
            UPDATE tasks
            SET status = 'queued',
                lease_id = NULL,
                leased_by = NULL,
                lease_expires_at = NULL,
                not_before = ?,
                updated_at = ?
            WHERE id = ?
          `).run(notBefore, now, task.id)

          this.insertEvent(task.runId, task.id, attempt.id, 'task.lease_expired', {
            workerId: task.leasedBy,
            previousStatus: task.status,
            leaseId: lease.id,
            notBefore,
          }, now)
        }
        this.recomputeRunStatus(task.runId, now)
        expiredTaskIds.push(task.id)
      }

      return expiredTaskIds
    })()

    return {
      expiredTaskIds: expiredTasks,
      count: expiredTasks.length,
    }
  }

  getRun(runId: string): RunRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM runs
      WHERE id = ?
    `).get(runId) as RunRow | undefined
    return row ? asRunRecord(row) : null
  }

  getTask(taskId: string): TaskRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM tasks
      WHERE id = ?
    `).get(taskId) as TaskRow | undefined
    return row ? this.hydrateTaskRecord(row) : null
  }

  listRunTasks(runId: string): TaskRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM tasks
      WHERE run_id = ?
      ORDER BY priority DESC, created_at ASC
    `).all(runId) as TaskRow[]
    return rows.map(row => this.hydrateTaskRecord(row))
  }

  listRunEvents(runId: string): EventRecord[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM events
      WHERE run_id = ?
      ORDER BY id ASC
    `).all(runId) as EventRow[]
    return rows.map(asEventRecord)
  }

  listRuns(options: ListRunsOptions = {}): RunRecord[] {
    const clauses: string[] = []
    const params: unknown[] = []

    if (options.namespace !== undefined) {
      clauses.push('namespace IS ?')
      params.push(options.namespace)
    }
    if (options.externalId !== undefined) {
      clauses.push('external_id IS ?')
      params.push(options.externalId)
    }
    if (options.statuses && options.statuses.length > 0) {
      const placeholders = options.statuses.map(() => '?').join(', ')
      clauses.push(`status IN (${placeholders})`)
      params.push(...options.statuses)
    }
    if (options.updatedAfter !== undefined) {
      clauses.push('updated_at >= ?')
      params.push(toIsoTimestamp(options.updatedAfter))
    }
    if (options.updatedBefore !== undefined) {
      clauses.push('updated_at < ?')
      params.push(toIsoTimestamp(options.updatedBefore))
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const orderCol = options.orderBy === 'created_at' ? 'created_at' : 'updated_at'
    const orderDir = options.orderDir === 'asc' ? 'ASC' : 'DESC'
    const limit = options.limit ?? 100
    const offset = options.offset ?? 0

    const rows = this.db.prepare(`
      SELECT *
      FROM runs
      ${where}
      ORDER BY ${orderCol} ${orderDir}, id ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as RunRow[]

    return rows.map(asRunRecord)
  }

  listPendingTasks(options: ListPendingTasksOptions = {}): TaskRecord[] {
    const clauses: string[] = [`status = 'queued'`]
    const params: unknown[] = []

    if (options.runId !== undefined) {
      clauses.push('run_id = ?')
      params.push(options.runId)
    }
    if (options.kinds && options.kinds.length > 0) {
      const placeholders = options.kinds.map(() => '?').join(', ')
      clauses.push(`kind IN (${placeholders})`)
      params.push(...options.kinds)
    }
    if (options.readyBy !== undefined) {
      clauses.push('(not_before IS NULL OR not_before <= ?)')
      params.push(toIsoTimestamp(options.readyBy))
    }

    const where = `WHERE ${clauses.join(' AND ')}`
    const limit = options.limit ?? 100

    const rows = this.db.prepare(`
      SELECT *
      FROM tasks
      ${where}
      ORDER BY priority DESC, created_at ASC
      LIMIT ?
    `).all(...params, limit) as TaskRow[]

    return rows.map(row => this.hydrateTaskRecord(row))
  }

  listEventsSince(options: ListEventsSinceOptions = {}): ListEventsResult {
    const clauses: string[] = []
    const params: unknown[] = []

    if (options.afterId !== undefined) {
      clauses.push('id > ?')
      params.push(options.afterId)
    }
    if (options.runId !== undefined) {
      clauses.push('run_id = ?')
      params.push(options.runId)
    }
    if (options.eventTypes && options.eventTypes.length > 0) {
      const placeholders = options.eventTypes.map(() => '?').join(', ')
      clauses.push(`event_type IN (${placeholders})`)
      params.push(...options.eventTypes)
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.max(1, options.limit ?? 200)

    const rows = this.db.prepare(`
      SELECT *
      FROM events
      ${where}
      ORDER BY id ASC
      LIMIT ?
    `).all(...params, limit) as EventRow[]

    const events = rows.map(asEventRecord)
    const last = events.length > 0 ? events[events.length - 1] : undefined
    const nextCursor = last ? last.id : (options.afterId ?? null)
    return { events, nextCursor }
  }

  pruneRuns(options: PruneRunsOptions): PruneRunsResult {
    const now = toIsoTimestamp(options.now)
    const cutoff = toIsoTimestamp(options.olderThan)
    const statuses = options.statuses && options.statuses.length > 0
      ? options.statuses
      : ['completed' as const, 'failed' as const, 'cancelled' as const]
    const limit = options.limit ?? 500

    const prunedRunIds = this.db.transaction(() => {
      const placeholders = statuses.map(() => '?').join(', ')
      const candidates = this.db.prepare(`
        SELECT id
        FROM runs
        WHERE status IN (${placeholders})
          AND updated_at < ?
        ORDER BY updated_at ASC
        LIMIT ?
      `).all(...statuses, cutoff, limit) as Array<{ id: string }>

      const ids: string[] = []
      for (const row of candidates) {
        this.db.prepare(`DELETE FROM task_completions WHERE run_id = ?`).run(row.id)
        this.db.prepare(`DELETE FROM task_leases WHERE run_id = ?`).run(row.id)
        this.db.prepare(`DELETE FROM task_attempts WHERE run_id = ?`).run(row.id)
        this.db.prepare(`
          DELETE FROM task_dependencies
          WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?)
             OR depends_on_task_id IN (SELECT id FROM tasks WHERE run_id = ?)
        `).run(row.id, row.id)
        this.db.prepare(`DELETE FROM context_snapshots WHERE run_id = ?`).run(row.id)
        this.db.prepare(`DELETE FROM events WHERE run_id = ?`).run(row.id)
        this.db.prepare(`DELETE FROM tasks WHERE run_id = ?`).run(row.id)
        this.db.prepare(`DELETE FROM runs WHERE id = ?`).run(row.id)
        ids.push(row.id)
      }

      if (ids.length > 0) {
        this.db.prepare(`
          INSERT INTO events (run_id, task_id, attempt_id, event_type, payload, created_at)
          SELECT NULL, NULL, NULL, 'runs.pruned', ?, ?
          WHERE 1 = 0
        `)
      }

      return ids
    })()

    void now
    return { prunedRunIds, count: prunedRunIds.length }
  }

  /**
   * List tasks currently parked in the dead-letter queue (`dead = 1`).
   * Ordered by most-recently-dead first.
   */
  listDeadTasks(options: ListDeadTasksOptions = {}): TaskRecord[] {
    const clauses: string[] = ['dead = 1']
    const params: unknown[] = []

    if (options.runId) {
      clauses.push('run_id = ?')
      params.push(options.runId)
    }
    if (options.kinds && options.kinds.length > 0) {
      clauses.push(`kind IN (${options.kinds.map(() => '?').join(', ')})`)
      params.push(...options.kinds)
    }

    const limit = options.limit ?? 100
    const offset = options.offset ?? 0
    const rows = this.db.prepare(`
      SELECT *
      FROM tasks
      WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC, id ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as TaskRow[]

    return rows.map(row => this.hydrateTaskRecord(row))
  }

  /**
   * Requeue a dead-letter task back onto the runnable queue. By default
   * clears `attemptCount` and `error` so the task gets a fresh retry
   * budget. Emits `task.requeued_from_dlq` on the event log.
   */
  requeueDeadTask(options: RequeueDeadTaskOptions): TaskRecord {
    const now = toIsoTimestamp(options.now)
    const resetAttempts = options.resetAttempts !== false
    const notBefore = options.notBefore === undefined ? null : toIsoTimestamp(options.notBefore)

    this.db.transaction(() => {
      const task = this.requireTask(options.taskId)
      if (!task.dead) {
        throw new InvalidTransitionError('task', task.status, 'queued')
      }

      this.db.prepare(`
        UPDATE tasks
        SET status = 'queued',
            dead = 0,
            error = NULL,
            lease_id = NULL,
            leased_by = NULL,
            lease_expires_at = NULL,
            started_at = NULL,
            completed_at = NULL,
            not_before = ?,
            attempt_count = CASE WHEN ? = 1 THEN 0 ELSE attempt_count END,
            updated_at = ?
        WHERE id = ?
      `).run(notBefore, resetAttempts ? 1 : 0, now, options.taskId)

      this.insertEvent(task.runId, task.id, null, 'task.requeued_from_dlq', {
        resetAttempts,
        notBefore,
        reason: options.reason ?? null,
        previousAttemptCount: task.attemptCount,
      }, now)

      this.recomputeRunStatus(task.runId, now)
    })()

    return this.requireTask(options.taskId)
  }

  /**
   * Run `fn` in a SQLite `IMMEDIATE` transaction. Every durable write made
   * inside commits or rolls back atomically; throwing from `fn` rolls back.
   * Use for composite operations that must be all-or-nothing.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate()
  }

  getCurrentContextSnapshot(runId: string): ContextSnapshotRecord | null {
    const run = this.getRun(runId)
    if (!run?.currentContextSnapshotId) return null
    return this.requireContextSnapshot(run.currentContextSnapshotId)
  }

  private requireRun(runId: string): RunRecord {
    const run = this.getRun(runId)
    if (!run) throw new RecordNotFoundError(`Run ${runId} was not found`)
    return run
  }

  private requireTask(taskId: string): TaskRecord {
    const task = this.getTask(taskId)
    if (!task) throw new RecordNotFoundError(`Task ${taskId} was not found`)
    return task
  }

  private requireAttempt(attemptId: string): TaskAttemptRecord {
    const row = this.db.prepare(`
      SELECT *
      FROM task_attempts
      WHERE id = ?
    `).get(attemptId) as AttemptRow | undefined
    if (!row) throw new RecordNotFoundError(`Task attempt ${attemptId} was not found`)
    return asTaskAttemptRecord(row)
  }

  private requireLease(leaseId: string): TaskLeaseRecord {
    const row = this.db.prepare(`
      SELECT *
      FROM task_leases
      WHERE id = ?
    `).get(leaseId) as LeaseRow | undefined
    if (!row) throw new RecordNotFoundError(`Task lease ${leaseId} was not found`)
    return asTaskLeaseRecord(row)
  }

  private requireContextSnapshot(snapshotId: string): ContextSnapshotRecord {
    const row = this.db.prepare(`
      SELECT *
      FROM context_snapshots
      WHERE id = ?
    `).get(snapshotId) as ContextSnapshotRow | undefined
    if (!row) throw new RecordNotFoundError(`Context snapshot ${snapshotId} was not found`)
    return asContextSnapshotRecord(row)
  }

  private hydrateTaskRecord(row: TaskRow): TaskRecord {
    const dependencyRows = this.db.prepare(`
      SELECT depends_on_task_id
      FROM task_dependencies
      WHERE task_id = ?
      ORDER BY depends_on_task_id ASC
    `).all(row.id) as Array<{ depends_on_task_id: string }>

    return {
      id: row.id,
      runId: row.run_id,
      key: row.task_key,
      kind: row.kind,
      status: row.status,
      priority: row.priority,
      maxAttempts: row.max_attempts,
      attemptCount: row.attempt_count,
      retryDelayMs: row.retry_delay_ms,
      retryBackoff: row.retry_backoff,
      retryMaxDelayMs: row.retry_max_delay_ms,
      timeoutMs: row.timeout_ms,
      notBefore: row.not_before,
      input: parseJson(row.input),
      output: parseJson(row.output),
      metadata: parseJson(row.metadata),
      error: row.error,
      contextSnapshotId: row.context_snapshot_id,
      leaseId: row.lease_id,
      leasedBy: row.leased_by,
      leaseExpiresAt: row.lease_expires_at,
      dependsOnTaskIds: dependencyRows.map(dep => dep.depends_on_task_id),
      dead: row.dead === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    }
  }

  private insertEvent(
    runId: string,
    taskId: string | null,
    attemptId: string | null,
    eventType: string,
    payload: JsonValue,
    createdAt: string,
  ): void {
    const info = this.db.prepare(`
      INSERT INTO events (run_id, task_id, attempt_id, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(runId, taskId, attemptId, eventType, JSON.stringify(payload), createdAt)

    if (this.eventListeners.length === 0) return
    const record: EventRecord = {
      id: Number(info.lastInsertRowid),
      runId,
      taskId,
      attemptId,
      eventType,
      payload,
      createdAt,
    }
    for (const listener of this.eventListeners) {
      try {
        listener(record)
      } catch {
        // Listeners are observability callbacks; swallow to avoid breaking durable writes.
      }
    }
  }

  private recomputeRunStatus(runId: string, now: string): RunRecord {
    const current = this.requireRun(runId)
    const rows = this.db.prepare(`
      SELECT status
      FROM tasks
      WHERE run_id = ?
    `).all(runId) as Array<{ status: TaskRecord['status'] }>

    const nextStatus = deriveRunStatus(current.status, rows.map(row => row.status))
    if (nextStatus !== current.status) {
      this.db.prepare(`
        UPDATE runs
        SET status = ?, updated_at = ?
        WHERE id = ?
      `).run(nextStatus, now, runId)
      this.insertEvent(runId, null, null, 'run.status.changed', {
        from: current.status,
        to: nextStatus,
      }, now)
    } else {
      this.db.prepare(`
        UPDATE runs
        SET updated_at = ?
        WHERE id = ?
      `).run(now, runId)
    }

    return this.requireRun(runId)
  }

  private lookupCompletion(clientToken: string, taskId: string, expectedOutcome: 'completed' | 'failed'): TaskRecord | null {
    const row = this.db.prepare(`
      SELECT task_id, outcome
      FROM task_completions
      WHERE client_token = ?
    `).get(clientToken) as { task_id: string; outcome: string } | undefined
    if (!row) return null
    if (row.task_id !== taskId) {
      throw new Error(
        `clientToken ${clientToken} was already used for task ${row.task_id}; refusing to reuse it for task ${taskId}`,
      )
    }
    if (row.outcome !== expectedOutcome) {
      throw new Error(
        `clientToken ${clientToken} already recorded a ${row.outcome} outcome for task ${taskId}; refusing to re-apply as ${expectedOutcome}`,
      )
    }
    return this.requireTask(taskId)
  }

  private recordCompletion(
    clientToken: string,
    taskId: string,
    runId: string,
    outcome: 'completed' | 'failed',
    now: string,
  ): void {
    this.db.prepare(`
      INSERT INTO task_completions (client_token, task_id, run_id, outcome, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(clientToken, taskId, runId, outcome, now)
  }

  private assertActiveLease(task: TaskRecord, leaseId: string, workerId: string, now: string): {
    lease: TaskLeaseRecord
    attempt: TaskAttemptRecord
  } {
    if (!task.leaseId || task.leaseId !== leaseId || task.leasedBy !== workerId) {
      throw new LeaseConflictError(task.id)
    }
    if (!task.leaseExpiresAt || task.leaseExpiresAt < now) {
      throw new LeaseExpiredError(task.id)
    }
    const lease = this.requireLease(leaseId)
    if (lease.status !== 'active' || lease.workerId !== workerId) {
      throw new LeaseConflictError(task.id)
    }
    return {
      lease,
      attempt: this.requireAttempt(lease.attemptId),
    }
  }
}
