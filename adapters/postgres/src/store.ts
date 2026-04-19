import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient, QueryResult } from 'pg'
import {
  DependencyCycleError,
  DuplicateTaskKeyError,
  InvalidTransitionError,
  LeaseConflictError,
  LeaseExpiredError,
  RecordNotFoundError,
  RunTerminalError,
  assertTaskTransition,
  deriveRunStatus,
} from '@razroo/parallel-mcp'
import type {
  AppendContextSnapshotOptions,
  AsyncParallelMcpEventListener,
  AsyncParallelMcpStore,
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
  JsonValue,
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
  TaskAttemptRecord,
  TaskLeaseRecord,
  TaskRecord,
} from '@razroo/parallel-mcp'
import { POSTGRES_SCHEMA } from './schema.js'

type TimestampLike = Date | string | number | undefined

interface RunRow {
  id: string
  namespace: string | null
  external_id: string | null
  status: RunRecord['status']
  metadata: JsonValue | null
  current_context_snapshot_id: string | null
  created_at: Date
  updated_at: Date
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
  not_before: Date | null
  input: JsonValue | null
  output: JsonValue | null
  metadata: JsonValue | null
  error: string | null
  context_snapshot_id: string | null
  lease_id: string | null
  leased_by: string | null
  lease_expires_at: Date | null
  dead: boolean
  created_at: Date
  updated_at: Date
  started_at: Date | null
  completed_at: Date | null
}

interface AttemptRow {
  id: string
  run_id: string
  task_id: string
  worker_id: string
  status: TaskAttemptRecord['status']
  leased_at: Date
  started_at: Date | null
  ended_at: Date | null
  lease_expires_at: Date
  error: string | null
  output: JsonValue | null
  metadata: JsonValue | null
}

interface LeaseRow {
  id: string
  run_id: string
  task_id: string
  attempt_id: string
  worker_id: string
  status: TaskLeaseRecord['status']
  acquired_at: Date
  expires_at: Date
  heartbeat_at: Date | null
  released_at: Date | null
  client_token: string | null
}

interface ContextSnapshotRow {
  id: string
  run_id: string
  task_id: string | null
  scope: ContextSnapshotRecord['scope']
  parent_snapshot_id: string | null
  label: string | null
  payload: JsonValue
  created_at: Date
}

interface EventRow {
  id: string
  run_id: string
  task_id: string | null
  attempt_id: string | null
  event_type: string
  payload: JsonValue
  created_at: Date
}

/**
 * Runner abstraction so the same SQL can run either against the pool or a
 * checked-out client inside a transaction. Postgres `pg.Pool` and `pg.PoolClient`
 * both expose `query` with the same signature.
 */
type Runner = Pick<Pool, 'query'> | PoolClient

function toIso(value: Date | string | number | undefined): string {
  if (value === undefined) return new Date().toISOString()
  if (value instanceof Date) return value.toISOString()
  return new Date(value).toISOString()
}

function toDateOrNull(value: TimestampLike): Date | null {
  if (value === undefined) return null
  if (value instanceof Date) return value
  return new Date(value)
}

function tsToIsoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString()
}

function jsonOrNull(value: JsonValue | undefined | null): JsonValue | null {
  return value === undefined ? null : value
}

function asRunRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    namespace: row.namespace,
    externalId: row.external_id,
    status: row.status,
    metadata: row.metadata ?? null,
    currentContextSnapshotId: row.current_context_snapshot_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function asTaskAttemptRecord(row: AttemptRow): TaskAttemptRecord {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    workerId: row.worker_id,
    status: row.status,
    leasedAt: row.leased_at.toISOString(),
    startedAt: tsToIsoOrNull(row.started_at),
    endedAt: tsToIsoOrNull(row.ended_at),
    leaseExpiresAt: row.lease_expires_at.toISOString(),
    error: row.error,
    output: row.output ?? null,
    metadata: row.metadata ?? null,
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
    acquiredAt: row.acquired_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    heartbeatAt: tsToIsoOrNull(row.heartbeat_at),
    releasedAt: tsToIsoOrNull(row.released_at),
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
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  }
}

function asEventRecord(row: EventRow): EventRecord {
  return {
    id: Number(row.id),
    runId: row.run_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    eventType: row.event_type,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  }
}

function computeNotBefore(task: TaskRecord, now: Date): Date | null {
  if (task.retryDelayMs === null || task.retryDelayMs <= 0) return null
  const attempt = Math.max(1, task.attemptCount)
  let delay = task.retryDelayMs
  if (task.retryBackoff === 'exponential') {
    delay = task.retryDelayMs * 2 ** (attempt - 1)
  }
  if (task.retryMaxDelayMs !== null && task.retryMaxDelayMs > 0) {
    delay = Math.min(delay, task.retryMaxDelayMs)
  }
  return new Date(now.getTime() + delay)
}

/** Construction options for {@link PostgresParallelMcpStore}. */
export interface PostgresParallelMcpStoreOptions {
  pool: Pool
  /**
   * When true, `migrate()` runs `POSTGRES_SCHEMA` on construction so a fresh
   * database boots without a separate CLI step. Default `false` — the
   * recommended setup is to own migrations out-of-band (e.g. drizzle-kit,
   * node-pg-migrate) and only read this field for bootstrap / tests.
   */
  autoMigrate?: boolean
}

/**
 * Postgres-backed implementation of {@link AsyncParallelMcpStore}. Port of
 * {@link import('@razroo/parallel-mcp').SqliteParallelMcpStore} with
 * idiomatic Postgres SQL and transactional claim semantics using
 * `SELECT ... FOR UPDATE SKIP LOCKED`.
 *
 * The caller owns the pool lifecycle: `close()` does **not** call
 * `pool.end()`. This keeps pool ownership correct in long-running
 * servers that share the pool across many stores.
 */
export class PostgresParallelMcpStore implements AsyncParallelMcpStore {
  readonly pool: Pool
  private eventListeners: AsyncParallelMcpEventListener[] = []
  private closed = false
  private readonly autoMigratePromise: Promise<void> | null

  constructor(options: PostgresParallelMcpStoreOptions) {
    this.pool = options.pool
    this.autoMigratePromise = options.autoMigrate ? this.migrate() : null
  }

  /** Run the canonical schema against the pool. Idempotent. */
  async migrate(): Promise<void> {
    await this.pool.query(POSTGRES_SCHEMA)
  }

  addEventListener(listener: AsyncParallelMcpEventListener): () => void {
    this.eventListeners.push(listener)
    return () => {
      this.eventListeners = this.eventListeners.filter(existing => existing !== listener)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    // Pool ownership stays with the caller — we don't end() it.
  }

  /**
   * Run `fn` inside a Postgres `BEGIN`/`COMMIT`. Rolls back and rethrows on
   * any error. Useful for composite writes that must be all-or-nothing.
   *
   * Note: unlike the store's built-in methods, this helper does **not**
   * provide a client handle to `fn` — it simply wraps the pool in a
   * transaction and relies on Postgres' session semantics. If you need a
   * shared client, use `withClient` directly.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn()
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        /* swallow — original error wins */
      })
      throw error
    } finally {
      client.release()
    }
  }

  async createRun(options: CreateRunOptions = {}): Promise<RunRecord> {
    await this.ensureMigrated()
    const runId = options.id ?? randomUUID()
    const now = new Date(toIso(options.now))
    const snapshotId = options.context === undefined ? null : randomUUID()
    const namespace = options.namespace ?? 'default'

    await withClient(this.pool, async client => {
      await client.query('BEGIN')
      try {
        await client.query(
          `INSERT INTO runs (id, namespace, external_id, status, metadata, current_context_snapshot_id, created_at, updated_at)
           VALUES ($1, $2, $3, 'pending', $4::jsonb, $5, $6, $7)`,
          [runId, namespace, options.externalId ?? null, JSON.stringify(jsonOrNull(options.metadata)), snapshotId, now, now],
        )

        await this.insertEvent(client, runId, null, null, 'run.created', {
          namespace,
          externalId: options.externalId ?? null,
          metadata: options.metadata ?? null,
        }, now)

        if (snapshotId !== null) {
          await client.query(
            `INSERT INTO context_snapshots (id, run_id, task_id, scope, parent_snapshot_id, label, payload, created_at)
             VALUES ($1, $2, NULL, 'run', NULL, 'run.initial', $3::jsonb, $4)`,
            [snapshotId, runId, JSON.stringify(options.context ?? null), now],
          )
          await this.insertEvent(client, runId, null, null, 'context.snapshot.created', {
            snapshotId,
            scope: 'run',
            label: 'run.initial',
          }, now)
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
    })

    return this.requireRun(this.pool, runId)
  }

  async enqueueTask(options: EnqueueTaskOptions): Promise<TaskRecord> {
    await this.ensureMigrated()
    const now = new Date(toIso(options.now))
    const taskId = options.id ?? randomUUID()
    const dependencies = options.dependsOnTaskIds ?? []

    const run = await this.requireRun(this.pool, options.runId)
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      throw new RunTerminalError(run.id, run.status)
    }

    await withClient(this.pool, async client => {
      await client.query('BEGIN')
      try {
        if (options.key !== undefined) {
          const existing = await client.query<{ id: string }>(
            `SELECT id FROM tasks WHERE run_id = $1 AND task_key = $2`,
            [options.runId, options.key],
          )
          if (existing.rowCount && existing.rowCount > 0) {
            throw new DuplicateTaskKeyError(options.runId, options.key)
          }
        }

        if (dependencies.length > 0) {
          if (dependencies.includes(taskId)) {
            throw new DependencyCycleError(`Task ${taskId} cannot depend on itself`)
          }
          const rows = await client.query<{ id: string }>(
            `SELECT id FROM tasks WHERE run_id = $1 AND id = ANY($2::text[])`,
            [options.runId, dependencies],
          )
          if ((rows.rowCount ?? 0) !== dependencies.length) {
            throw new Error(`One or more dependency task ids do not belong to run ${options.runId}`)
          }
        }

        await client.query(
          `INSERT INTO tasks (
             id, run_id, task_key, kind, status, priority, max_attempts, attempt_count,
             retry_delay_ms, retry_backoff, retry_max_delay_ms, timeout_ms, not_before,
             input, output, metadata, error, context_snapshot_id, lease_id, leased_by, lease_expires_at,
             dead, created_at, updated_at, started_at, completed_at
           )
           VALUES (
             $1, $2, $3, $4, 'queued', $5, $6, 0,
             $7, $8, $9, $10, NULL,
             $11::jsonb, NULL, $12::jsonb, NULL, $13, NULL, NULL, NULL,
             FALSE, $14, $14, NULL, NULL
           )`,
          [
            taskId,
            options.runId,
            options.key ?? null,
            options.kind,
            options.priority ?? 0,
            options.maxAttempts ?? null,
            options.retry?.delayMs ?? null,
            options.retry?.backoff ?? null,
            options.retry?.maxDelayMs ?? null,
            options.timeoutMs ?? null,
            JSON.stringify(jsonOrNull(options.input)),
            JSON.stringify(jsonOrNull(options.metadata)),
            options.contextSnapshotId ?? run.currentContextSnapshotId,
            now,
          ],
        )

        for (const dependsOnTaskId of dependencies) {
          await client.query(
            `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)`,
            [taskId, dependsOnTaskId],
          )
        }

        await this.insertEvent(client, options.runId, taskId, null, 'task.enqueued', {
          kind: options.kind,
          priority: options.priority ?? 0,
          dependsOnTaskIds: dependencies,
        }, now)

        await this.recomputeRunStatus(client, options.runId, now)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
    })

    return this.requireTask(this.pool, taskId)
  }

  async claimNextTask(options: ClaimTaskOptions): Promise<ClaimTaskResult | null> {
    await this.ensureMigrated()
    const now = new Date(toIso(options.now))
    const expiresAt = new Date(now.getTime() + (options.leaseMs ?? 30_000))
    const kinds = options.kinds ?? []
    const clientToken = options.clientToken ?? null

    if (clientToken !== null) {
      const existing = await this.pool.query<{ id: string }>(
        `SELECT id FROM task_leases WHERE client_token = $1`,
        [clientToken],
      )
      if (existing.rowCount && existing.rowCount > 0 && existing.rows[0]) {
        return this.rehydrateLease(existing.rows[0].id)
      }
    }

    return await withClient(this.pool, async client => {
      await client.query('BEGIN')
      try {
        await this.expireLeasesTx(client, now)

        const kindsFilter = kinds.length > 0 ? `AND t.kind = ANY($2::text[])` : ''
        const params: unknown[] = [now]
        if (kinds.length > 0) params.push(kinds)

        const pickSql = `
          SELECT t.id
          FROM tasks t
          JOIN runs r ON r.id = t.run_id
          WHERE t.status = 'queued'
            AND r.status NOT IN ('completed', 'failed', 'cancelled')
            AND (t.not_before IS NULL OR t.not_before <= $1)
            AND (t.max_attempts IS NULL OR t.attempt_count < t.max_attempts)
            AND NOT EXISTS (
              SELECT 1
              FROM task_dependencies d
              JOIN tasks dep ON dep.id = d.depends_on_task_id
              WHERE d.task_id = t.id
                AND dep.status != 'completed'
            )
            ${kindsFilter}
          ORDER BY t.priority DESC, t.created_at ASC
          FOR UPDATE OF t SKIP LOCKED
          LIMIT 1`

        const picked = await client.query<{ id: string }>(pickSql, params)
        if (!picked.rowCount || !picked.rows[0]) {
          await client.query('COMMIT')
          return null
        }
        const pickedId = picked.rows[0].id

        const attemptId = randomUUID()
        const leaseId = randomUUID()

        const updated = await client.query(
          `UPDATE tasks
             SET status = 'leased',
                 attempt_count = attempt_count + 1,
                 lease_id = $1,
                 leased_by = $2,
                 lease_expires_at = $3,
                 not_before = NULL,
                 updated_at = $4
           WHERE id = $5
             AND status = 'queued'
             AND lease_id IS NULL`,
          [leaseId, options.workerId, expiresAt, now, pickedId],
        )
        if (updated.rowCount !== 1) {
          await client.query('COMMIT')
          return null
        }

        const taskRows = await client.query<TaskRow>(
          `SELECT * FROM tasks WHERE id = $1`,
          [pickedId],
        )
        const taskRow = taskRows.rows[0]
        if (!taskRow) {
          await client.query('COMMIT')
          return null
        }

        await client.query(
          `INSERT INTO task_attempts (
             id, run_id, task_id, worker_id, status,
             leased_at, started_at, ended_at, lease_expires_at,
             error, output, metadata
           )
           VALUES ($1, $2, $3, $4, 'leased', $5, NULL, NULL, $6, NULL, NULL, NULL)`,
          [attemptId, taskRow.run_id, taskRow.id, options.workerId, now, expiresAt],
        )

        await client.query(
          `INSERT INTO task_leases (
             id, run_id, task_id, attempt_id, worker_id, status,
             acquired_at, expires_at, heartbeat_at, released_at, client_token
           )
           VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $6, NULL, $8)`,
          [leaseId, taskRow.run_id, taskRow.id, attemptId, options.workerId, now, expiresAt, clientToken],
        )

        await this.insertEvent(client, taskRow.run_id, taskRow.id, attemptId, 'task.claimed', {
          workerId: options.workerId,
          leaseId,
          leaseExpiresAt: expiresAt.toISOString(),
        }, now)
        await this.recomputeRunStatus(client, taskRow.run_id, now)

        await client.query('COMMIT')

        return {
          run: await this.requireRun(this.pool, taskRow.run_id),
          task: await this.requireTask(this.pool, taskRow.id),
          attempt: await this.requireAttempt(this.pool, attemptId),
          lease: await this.requireLease(this.pool, leaseId),
        }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
    })
  }

  private async rehydrateLease(leaseId: string): Promise<ClaimTaskResult> {
    const lease = await this.requireLease(this.pool, leaseId)
    return {
      run: await this.requireRun(this.pool, lease.runId),
      task: await this.requireTask(this.pool, lease.taskId),
      attempt: await this.requireAttempt(this.pool, lease.attemptId),
      lease,
    }
  }

  async heartbeatLease(options: HeartbeatLeaseOptions): Promise<TaskLeaseRecord> {
    await this.ensureMigrated()
    const now = new Date(toIso(options.now))
    const expiresAt = new Date(now.getTime() + (options.leaseMs ?? 30_000))

    return await withClient(this.pool, async client => {
      await client.query('BEGIN')
      try {
        const task = await this.requireTask(client, options.taskId)
        const active = await this.assertActiveLease(client, task, options.leaseId, options.workerId, now)

        await client.query(
          `UPDATE tasks SET lease_expires_at = $1, updated_at = $2 WHERE id = $3`,
          [expiresAt, now, task.id],
        )
        await client.query(
          `UPDATE task_attempts SET lease_expires_at = $1 WHERE id = $2`,
          [expiresAt, active.attempt.id],
        )
        await client.query(
          `UPDATE task_leases SET expires_at = $1, heartbeat_at = $2 WHERE id = $3`,
          [expiresAt, now, active.lease.id],
        )

        await this.insertEvent(client, task.runId, task.id, active.attempt.id, 'task.lease_heartbeat', {
          workerId: options.workerId,
          leaseId: options.leaseId,
          leaseExpiresAt: expiresAt.toISOString(),
        }, now)

        const result = await this.requireLease(client, active.lease.id)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
    })
  }

  async markTaskRunning(options: Omit<PauseTaskOptions, 'status' | 'reason'>): Promise<TaskRecord> {
    await this.ensureMigrated()
    const now = new Date(toIso(options.now))

    return await withClient(this.pool, async client => {
      await client.query('BEGIN')
      try {
        const task = await this.requireTask(client, options.taskId)
        const active = await this.assertActiveLease(client, task, options.leaseId, options.workerId, now)
        assertTaskTransition(task.status, 'running')

        await client.query(
          `UPDATE tasks
             SET status = 'running',
                 started_at = COALESCE(started_at, $1),
                 updated_at = $1
           WHERE id = $2`,
          [now, task.id],
        )
        await client.query(
          `UPDATE task_attempts
             SET status = 'running',
                 started_at = COALESCE(started_at, $1)
           WHERE id = $2`,
          [now, active.attempt.id],
        )

        await this.insertEvent(client, task.runId, task.id, active.attempt.id, 'task.running', {
          workerId: options.workerId,
          leaseId: options.leaseId,
        }, now)
        await this.recomputeRunStatus(client, task.runId, now)

        const result = await this.requireTask(client, task.id)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
    })
  }

  async pauseTask(options: PauseTaskOptions): Promise<TaskRecord> {
    await this.ensureMigrated()
    const now = new Date(toIso(options.now))

    return await withClient(this.pool, async client => {
      await client.query('BEGIN')
      try {
        const task = await this.requireTask(client, options.taskId)
        const active = await this.assertActiveLease(client, task, options.leaseId, options.workerId, now)
        assertTaskTransition(task.status, options.status)

        await client.query(
          `UPDATE tasks
             SET status = $1,
                 lease_id = NULL,
                 leased_by = NULL,
                 lease_expires_at = NULL,
                 updated_at = $2,
                 started_at = COALESCE(started_at, $2)
           WHERE id = $3`,
          [options.status, now, task.id],
        )
        await client.query(
          `UPDATE task_attempts
             SET status = 'released', ended_at = COALESCE(ended_at, $1)
           WHERE id = $2`,
          [now, active.attempt.id],
        )
        await client.query(
          `UPDATE task_leases
             SET status = 'released',
                 released_at = COALESCE(released_at, $1),
                 heartbeat_at = $1
           WHERE id = $2`,
          [now, active.lease.id],
        )

        await this.insertEvent(client, task.runId, task.id, active.attempt.id, `task.${options.status}`, {
          workerId: options.workerId,
          reason: options.reason ?? null,
        }, now)
        await this.recomputeRunStatus(client, task.runId, now)

        const result = await this.requireTask(client, task.id)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
    })
  }

  async resumeTask(options: ResumeTaskOptions): Promise<TaskRecord> {
    await this.ensureMigrated()
    const now = new Date(toIso(options.now))

    return await withClient(this.pool, async client => {
      await client.query('BEGIN')
      try {
        const task = await this.requireTask(client, options.taskId)
        if (task.status !== 'blocked' && task.status !== 'waiting_input') {
          throw new InvalidTransitionError('task', task.status, 'queued')
        }
        assertTaskTransition(task.status, 'queued')

        await client.query(
          `UPDATE tasks SET status = 'queued', updated_at = $1 WHERE id = $2`,
          [now, task.id],
        )
        await this.insertEvent(client, task.runId, task.id, null, 'task.resumed', {}, now)
        await this.recomputeRunStatus(client, task.runId, now)

        const result = await this.requireTask(client, task.id)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
    })
  }

  async completeTask(options: CompleteTaskOptions): Promise<TaskRecord> {
    await this.ensureMigrated()
    const now = new Date(toIso(options.now))
    if (options.clientToken !== undefined) {
      const prior = await this.lookupCompletion(this.pool, options.clientToken, options.taskId, 'completed')
      if (prior) return prior
    }

    return await withClient(this.pool, async client => {
      await client.query('BEGIN')
      try {
        const task = await this.requireTask(client, options.taskId)
        const active = await this.assertActiveLease(client, task, options.leaseId, options.workerId, now)
        assertTaskTransition(task.status, 'completed')

        if (options.nextContext !== undefined) {
          const parentSnapshotId = task.contextSnapshotId
            ?? (await this.requireRun(client, task.runId)).currentContextSnapshotId
            ?? null
          await this.appendContextSnapshotTx(client, {
            runId: task.runId,
            taskId: task.id,
            scope: 'run',
            ...(parentSnapshotId ? { parentSnapshotId } : {}),
            label: options.nextContextLabel ?? `${task.kind}.completed`,
            payload: options.nextContext,
            now: now.toISOString(),
          })
        }

        await client.query(
          `UPDATE tasks
             SET status = 'completed',
                 output = $1::jsonb,
                 metadata = COALESCE($2::jsonb, metadata),
                 lease_id = NULL,
                 leased_by = NULL,
                 lease_expires_at = NULL,
                 updated_at = $3,
                 started_at = COALESCE(started_at, $3),
                 completed_at = $3
           WHERE id = $4`,
          [JSON.stringify(jsonOrNull(options.output)), JSON.stringify(jsonOrNull(options.metadata)), now, task.id],
        )
        await client.query(
          `UPDATE task_attempts
             SET status = 'completed',
                 output = $1::jsonb,
                 metadata = COALESCE($2::jsonb, metadata),
                 started_at = COALESCE(started_at, $3),
                 ended_at = $3
           WHERE id = $4`,
          [JSON.stringify(jsonOrNull(options.output)), JSON.stringify(jsonOrNull(options.metadata)), now, active.attempt.id],
        )
        await client.query(
          `UPDATE task_leases
             SET status = 'released',
                 released_at = $1,
                 heartbeat_at = $1
           WHERE id = $2`,
          [now, active.lease.id],
        )

        await this.insertEvent(client, task.runId, task.id, active.attempt.id, 'task.completed', {
          workerId: options.workerId,
          output: options.output ?? null,
        }, now)
        if (options.clientToken !== undefined) {
          await this.recordCompletion(client, options.clientToken, task.id, task.runId, 'completed', now)
        }
        await this.recomputeRunStatus(client, task.runId, now)

        const result = await this.requireTask(client, task.id)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
    })
  }

  async failTask(options: FailTaskOptions): Promise<TaskRecord> {
    await this.ensureMigrated()
    const now = new Date(toIso(options.now))
    if (options.clientToken !== undefined) {
      const prior = await this.lookupCompletion(this.pool, options.clientToken, options.taskId, 'failed')
      if (prior) return prior
    }

    return await withClient(this.pool, async client => {
      await client.query('BEGIN')
      try {
        const task = await this.requireTask(client, options.taskId)
        const active = await this.assertActiveLease(client, task, options.leaseId, options.workerId, now)
        assertTaskTransition(task.status, 'failed')

        await client.query(
          `UPDATE tasks
             SET status = 'failed',
                 error = $1,
                 metadata = COALESCE($2::jsonb, metadata),
                 lease_id = NULL,
                 leased_by = NULL,
                 lease_expires_at = NULL,
                 updated_at = $3,
                 started_at = COALESCE(started_at, $3),
                 completed_at = $3
           WHERE id = $4`,
          [options.error, JSON.stringify(jsonOrNull(options.metadata)), now, task.id],
        )
        await client.query(
          `UPDATE task_attempts
             SET status = 'failed',
                 error = $1,
                 metadata = COALESCE($2::jsonb, metadata),
                 started_at = COALESCE(started_at, $3),
                 ended_at = $3
           WHERE id = $4`,
          [options.error, JSON.stringify(jsonOrNull(options.metadata)), now, active.attempt.id],
        )
        await client.query(
          `UPDATE task_leases
             SET status = 'released',
                 released_at = $1,
                 heartbeat_at = $1
           WHERE id = $2`,
          [now, active.lease.id],
        )

        await this.insertEvent(client, task.runId, task.id, active.attempt.id, 'task.failed', {
          workerId: options.workerId,
          error: options.error,
        }, now)
        if (options.clientToken !== undefined) {
          await this.recordCompletion(client, options.clientToken, task.id, task.runId, 'failed', now)
        }
        await this.recomputeRunStatus(client, task.runId, now)

        const result = await this.requireTask(client, task.id)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
    })
  }

  async releaseTask(options: ReleaseTaskOptions): Promise<TaskRecord> {
    await this.ensureMigrated()
    const now = new Date(toIso(options.now))

    return await withClient(this.pool, async client => {
      await client.query('BEGIN')
      try {
        const task = await this.requireTask(client, options.taskId)
        const active = await this.assertActiveLease(client, task, options.leaseId, options.workerId, now)
        assertTaskTransition(task.status, 'queued')

        await client.query(
          `UPDATE tasks
             SET status = 'queued',
                 lease_id = NULL,
                 leased_by = NULL,
                 lease_expires_at = NULL,
                 updated_at = $1
           WHERE id = $2`,
          [now, task.id],
        )
        await client.query(
          `UPDATE task_attempts
             SET status = 'released', ended_at = COALESCE(ended_at, $1)
           WHERE id = $2`,
          [now, active.attempt.id],
        )
        await client.query(
          `UPDATE task_leases
             SET status = 'released',
                 released_at = COALESCE(released_at, $1),
                 heartbeat_at = $1
           WHERE id = $2`,
          [now, active.lease.id],
        )

        await this.insertEvent(client, task.runId, task.id, active.attempt.id, 'task.released', {
          workerId: options.workerId,
          reason: options.reason ?? null,
        }, now)
        await this.recomputeRunStatus(client, task.runId, now)

        const result = await this.requireTask(client, task.id)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
    })
  }

  async appendContextSnapshot(options: AppendContextSnapshotOptions): Promise<ContextSnapshotRecord> {
    await this.ensureMigrated()
    return await withClient(this.pool, async client => {
      await client.query('BEGIN')
      try {
        const snapshot = await this.appendContextSnapshotTx(client, options)
        await client.query('COMMIT')
        return snapshot
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
    })
  }

  private async appendContextSnapshotTx(
    client: PoolClient,
    options: AppendContextSnapshotOptions,
  ): Promise<ContextSnapshotRecord> {
    const run = await this.requireRun(client, options.runId)
    const now = new Date(toIso(options.now))
    const snapshotId = options.id ?? randomUUID()

    await client.query(
      `INSERT INTO context_snapshots (id, run_id, task_id, scope, parent_snapshot_id, label, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        snapshotId,
        options.runId,
        options.taskId ?? null,
        options.scope ?? 'run',
        options.parentSnapshotId ?? run.currentContextSnapshotId,
        options.label ?? null,
        JSON.stringify(options.payload),
        now,
      ],
    )

    if ((options.scope ?? 'run') === 'run') {
      await client.query(
        `UPDATE runs SET current_context_snapshot_id = $1, updated_at = $2 WHERE id = $3`,
        [snapshotId, now, options.runId],
      )
    }

    if (options.taskId) {
      await client.query(
        `UPDATE tasks SET context_snapshot_id = $1, updated_at = $2 WHERE id = $3`,
        [snapshotId, now, options.taskId],
      )
    }

    await this.insertEvent(client, options.runId, options.taskId ?? null, null, 'context.snapshot.created', {
      snapshotId,
      scope: options.scope ?? 'run',
      label: options.label ?? null,
    }, now)

    return await this.requireContextSnapshot(client, snapshotId)
  }

  async cancelRun(options: CancelRunOptions): Promise<RunRecord> {
    await this.ensureMigrated()
    const now = new Date(toIso(options.now))

    await withClient(this.pool, async client => {
      await client.query('BEGIN')
      try {
        const run = await this.requireRun(client, options.runId)
        if (run.status === 'cancelled') {
          await client.query('COMMIT')
          return
        }

        await client.query(
          `UPDATE runs SET status = 'cancelled', updated_at = $1 WHERE id = $2`,
          [now, options.runId],
        )
        await client.query(
          `UPDATE tasks
             SET status = 'cancelled',
                 lease_id = NULL,
                 leased_by = NULL,
                 lease_expires_at = NULL,
                 updated_at = $1,
                 completed_at = COALESCE(completed_at, $1)
           WHERE run_id = $2
             AND status NOT IN ('completed', 'failed', 'cancelled')`,
          [now, options.runId],
        )
        await client.query(
          `UPDATE task_attempts
             SET status = 'cancelled',
                 ended_at = COALESCE(ended_at, $1)
           WHERE run_id = $2
             AND status IN ('leased', 'running')`,
          [now, options.runId],
        )
        await client.query(
          `UPDATE task_leases
             SET status = 'cancelled',
                 released_at = COALESCE(released_at, $1),
                 heartbeat_at = $1
           WHERE run_id = $2
             AND status = 'active'`,
          [now, options.runId],
        )

        await this.insertEvent(client, options.runId, null, null, 'run.cancelled', {
          reason: options.reason ?? null,
        }, now)

        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
    })

    return this.requireRun(this.pool, options.runId)
  }

  async expireLeases(options: { now?: TimestampLike } = {}): Promise<ExpireLeaseResult> {
    await this.ensureMigrated()
    const now = new Date(toIso(options.now))
    const expiredIds = await withClient(this.pool, async client => {
      await client.query('BEGIN')
      try {
        const ids = await this.expireLeasesTx(client, now)
        await client.query('COMMIT')
        return ids
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
    })
    return { expiredTaskIds: expiredIds, count: expiredIds.length }
  }

  private async expireLeasesTx(client: PoolClient, now: Date): Promise<string[]> {
    const rows = await client.query<{ id: string }>(
      `SELECT id FROM tasks
         WHERE status IN ('leased', 'running')
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at < $1`,
      [now],
    )

    const expired: string[] = []
    for (const row of rows.rows) {
      const task = await this.requireTask(client, row.id)
      if (!task.leaseId) continue
      const lease = await this.requireLease(client, task.leaseId)
      const attempt = await this.requireAttempt(client, lease.attemptId)

      await client.query(
        `UPDATE task_attempts SET status = 'expired', ended_at = COALESCE(ended_at, $1) WHERE id = $2`,
        [now, attempt.id],
      )
      await client.query(
        `UPDATE task_leases SET status = 'expired',
           released_at = COALESCE(released_at, $1),
           heartbeat_at = $1
         WHERE id = $2`,
        [now, lease.id],
      )

      const exhausted = task.maxAttempts !== null && task.attemptCount >= task.maxAttempts
      if (exhausted) {
        await client.query(
          `UPDATE tasks
             SET status = 'failed',
                 error = 'max_attempts_exceeded',
                 lease_id = NULL,
                 leased_by = NULL,
                 lease_expires_at = NULL,
                 not_before = NULL,
                 dead = TRUE,
                 updated_at = $1,
                 completed_at = $1
           WHERE id = $2`,
          [now, task.id],
        )
        await this.insertEvent(client, task.runId, task.id, attempt.id, 'task.failed', {
          workerId: task.leasedBy,
          error: 'max_attempts_exceeded',
          attemptCount: task.attemptCount,
          maxAttempts: task.maxAttempts,
        }, now)
        await this.insertEvent(client, task.runId, task.id, attempt.id, 'task.dead_lettered', {
          workerId: task.leasedBy,
          attemptCount: task.attemptCount,
          maxAttempts: task.maxAttempts,
          lastError: 'max_attempts_exceeded',
        }, now)
      } else {
        const notBefore = computeNotBefore(task, now)
        await client.query(
          `UPDATE tasks
             SET status = 'queued',
                 lease_id = NULL,
                 leased_by = NULL,
                 lease_expires_at = NULL,
                 not_before = $1,
                 updated_at = $2
           WHERE id = $3`,
          [notBefore, now, task.id],
        )
        await this.insertEvent(client, task.runId, task.id, attempt.id, 'task.lease_expired', {
          workerId: task.leasedBy,
          previousStatus: task.status,
          leaseId: lease.id,
          notBefore: notBefore ? notBefore.toISOString() : null,
        }, now)
      }
      await this.recomputeRunStatus(client, task.runId, now)
      expired.push(task.id)
    }
    return expired
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    await this.ensureMigrated()
    const rows = await this.pool.query<RunRow>(`SELECT * FROM runs WHERE id = $1`, [runId])
    const row = rows.rows[0]
    return row ? asRunRecord(row) : null
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    await this.ensureMigrated()
    return this.getTaskOn(this.pool, taskId)
  }

  private async getTaskOn(runner: Runner, taskId: string): Promise<TaskRecord | null> {
    const rows = await runner.query<TaskRow>(`SELECT * FROM tasks WHERE id = $1`, [taskId])
    const row = rows.rows[0]
    if (!row) return null
    return this.hydrateTaskRecord(runner, row)
  }

  async listRunTasks(runId: string): Promise<TaskRecord[]> {
    await this.ensureMigrated()
    const rows = await this.pool.query<TaskRow>(
      `SELECT * FROM tasks WHERE run_id = $1 ORDER BY priority DESC, created_at ASC`,
      [runId],
    )
    return Promise.all(rows.rows.map(row => this.hydrateTaskRecord(this.pool, row)))
  }

  async listRunEvents(runId: string): Promise<EventRecord[]> {
    await this.ensureMigrated()
    const rows = await this.pool.query<EventRow>(
      `SELECT * FROM events WHERE run_id = $1 ORDER BY id ASC`,
      [runId],
    )
    return rows.rows.map(asEventRecord)
  }

  async listRuns(options: ListRunsOptions = {}): Promise<RunRecord[]> {
    await this.ensureMigrated()
    const clauses: string[] = []
    const params: unknown[] = []
    let idx = 0

    if (options.namespace !== undefined) {
      clauses.push(`namespace IS NOT DISTINCT FROM $${++idx}`)
      params.push(options.namespace)
    }
    if (options.externalId !== undefined) {
      clauses.push(`external_id IS NOT DISTINCT FROM $${++idx}`)
      params.push(options.externalId)
    }
    if (options.statuses && options.statuses.length > 0) {
      clauses.push(`status = ANY($${++idx}::text[])`)
      params.push(options.statuses)
    }
    if (options.updatedAfter !== undefined) {
      clauses.push(`updated_at >= $${++idx}`)
      params.push(new Date(toIso(options.updatedAfter)))
    }
    if (options.updatedBefore !== undefined) {
      clauses.push(`updated_at < $${++idx}`)
      params.push(new Date(toIso(options.updatedBefore)))
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const orderCol = options.orderBy === 'created_at' ? 'created_at' : 'updated_at'
    const orderDir = options.orderDir === 'asc' ? 'ASC' : 'DESC'
    const limit = options.limit ?? 100
    const offset = options.offset ?? 0

    const rows = await this.pool.query<RunRow>(
      `SELECT * FROM runs ${where}
       ORDER BY ${orderCol} ${orderDir}, id ASC
       LIMIT $${++idx} OFFSET $${++idx}`,
      [...params, limit, offset],
    )
    return rows.rows.map(asRunRecord)
  }

  async listPendingTasks(options: ListPendingTasksOptions = {}): Promise<TaskRecord[]> {
    await this.ensureMigrated()
    const clauses: string[] = [`status = 'queued'`]
    const params: unknown[] = []
    let idx = 0

    if (options.runId !== undefined) {
      clauses.push(`run_id = $${++idx}`)
      params.push(options.runId)
    }
    if (options.kinds && options.kinds.length > 0) {
      clauses.push(`kind = ANY($${++idx}::text[])`)
      params.push(options.kinds)
    }
    if (options.readyBy !== undefined) {
      clauses.push(`(not_before IS NULL OR not_before <= $${++idx})`)
      params.push(new Date(toIso(options.readyBy)))
    }

    const where = `WHERE ${clauses.join(' AND ')}`
    const limit = options.limit ?? 100

    const rows = await this.pool.query<TaskRow>(
      `SELECT * FROM tasks ${where}
       ORDER BY priority DESC, created_at ASC
       LIMIT $${++idx}`,
      [...params, limit],
    )
    return Promise.all(rows.rows.map(row => this.hydrateTaskRecord(this.pool, row)))
  }

  async listEventsSince(options: ListEventsSinceOptions = {}): Promise<ListEventsResult> {
    await this.ensureMigrated()
    const clauses: string[] = []
    const params: unknown[] = []
    let idx = 0

    if (options.afterId !== undefined) {
      clauses.push(`id > $${++idx}`)
      params.push(options.afterId)
    }
    if (options.runId !== undefined) {
      clauses.push(`run_id = $${++idx}`)
      params.push(options.runId)
    }
    if (options.eventTypes && options.eventTypes.length > 0) {
      clauses.push(`event_type = ANY($${++idx}::text[])`)
      params.push(options.eventTypes)
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.max(1, options.limit ?? 200)

    const rows = await this.pool.query<EventRow>(
      `SELECT * FROM events ${where}
       ORDER BY id ASC
       LIMIT $${++idx}`,
      [...params, limit],
    )
    const events = rows.rows.map(asEventRecord)
    const last = events.length > 0 ? events[events.length - 1] : undefined
    const nextCursor = last ? last.id : (options.afterId ?? null)
    return { events, nextCursor }
  }

  async pruneRuns(options: PruneRunsOptions): Promise<PruneRunsResult> {
    await this.ensureMigrated()
    const cutoff = new Date(toIso(options.olderThan))
    const statuses = options.statuses && options.statuses.length > 0
      ? options.statuses
      : (['completed', 'failed', 'cancelled'] as const)
    const limit = options.limit ?? 500

    return await withClient(this.pool, async client => {
      await client.query('BEGIN')
      try {
        const candidates = await client.query<{ id: string }>(
          `SELECT id FROM runs
             WHERE status = ANY($1::text[])
               AND updated_at < $2
             ORDER BY updated_at ASC
             LIMIT $3`,
          [[...statuses], cutoff, limit],
        )

        const ids: string[] = []
        for (const row of candidates.rows) {
          // FK cascades handle most rows; delete the run and let Postgres sweep.
          await client.query(`DELETE FROM runs WHERE id = $1`, [row.id])
          ids.push(row.id)
        }
        await client.query('COMMIT')
        return { prunedRunIds: ids, count: ids.length }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
    })
  }

  async listDeadTasks(options: ListDeadTasksOptions = {}): Promise<TaskRecord[]> {
    await this.ensureMigrated()
    const clauses: string[] = ['dead = TRUE']
    const params: unknown[] = []
    let idx = 0

    if (options.runId) {
      clauses.push(`run_id = $${++idx}`)
      params.push(options.runId)
    }
    if (options.kinds && options.kinds.length > 0) {
      clauses.push(`kind = ANY($${++idx}::text[])`)
      params.push(options.kinds)
    }

    const limit = options.limit ?? 100
    const offset = options.offset ?? 0

    const rows = await this.pool.query<TaskRow>(
      `SELECT * FROM tasks
         WHERE ${clauses.join(' AND ')}
         ORDER BY updated_at DESC, id ASC
         LIMIT $${++idx} OFFSET $${++idx}`,
      [...params, limit, offset],
    )
    return Promise.all(rows.rows.map(row => this.hydrateTaskRecord(this.pool, row)))
  }

  async requeueDeadTask(options: RequeueDeadTaskOptions): Promise<TaskRecord> {
    await this.ensureMigrated()
    const now = new Date(toIso(options.now))
    const resetAttempts = options.resetAttempts !== false
    const notBefore = toDateOrNull(options.notBefore)

    await withClient(this.pool, async client => {
      await client.query('BEGIN')
      try {
        const task = await this.requireTask(client, options.taskId)
        if (!task.dead) {
          throw new InvalidTransitionError('task', task.status, 'queued')
        }

        await client.query(
          `UPDATE tasks
             SET status = 'queued',
                 dead = FALSE,
                 error = NULL,
                 lease_id = NULL,
                 leased_by = NULL,
                 lease_expires_at = NULL,
                 started_at = NULL,
                 completed_at = NULL,
                 not_before = $1,
                 attempt_count = CASE WHEN $2 THEN 0 ELSE attempt_count END,
                 updated_at = $3
           WHERE id = $4`,
          [notBefore, resetAttempts, now, options.taskId],
        )

        await this.insertEvent(client, task.runId, task.id, null, 'task.requeued_from_dlq', {
          resetAttempts,
          notBefore: notBefore ? notBefore.toISOString() : null,
          reason: options.reason ?? null,
          previousAttemptCount: task.attemptCount,
        }, now)

        await this.recomputeRunStatus(client, task.runId, now)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      }
    })

    return this.requireTask(this.pool, options.taskId)
  }

  async getCurrentContextSnapshot(runId: string): Promise<ContextSnapshotRecord | null> {
    await this.ensureMigrated()
    const run = await this.getRun(runId)
    if (!run?.currentContextSnapshotId) return null
    return this.requireContextSnapshot(this.pool, run.currentContextSnapshotId)
  }

  private async ensureMigrated(): Promise<void> {
    if (this.autoMigratePromise) await this.autoMigratePromise
  }

  private async requireRun(runner: Runner, runId: string): Promise<RunRecord> {
    const rows = await runner.query<RunRow>(`SELECT * FROM runs WHERE id = $1`, [runId])
    const row = rows.rows[0]
    if (!row) throw new RecordNotFoundError(`Run ${runId} was not found`)
    return asRunRecord(row)
  }

  private async requireTask(runner: Runner, taskId: string): Promise<TaskRecord> {
    const task = await this.getTaskOn(runner, taskId)
    if (!task) throw new RecordNotFoundError(`Task ${taskId} was not found`)
    return task
  }

  private async requireAttempt(runner: Runner, attemptId: string): Promise<TaskAttemptRecord> {
    const rows = await runner.query<AttemptRow>(`SELECT * FROM task_attempts WHERE id = $1`, [attemptId])
    const row = rows.rows[0]
    if (!row) throw new RecordNotFoundError(`Task attempt ${attemptId} was not found`)
    return asTaskAttemptRecord(row)
  }

  private async requireLease(runner: Runner, leaseId: string): Promise<TaskLeaseRecord> {
    const rows = await runner.query<LeaseRow>(`SELECT * FROM task_leases WHERE id = $1`, [leaseId])
    const row = rows.rows[0]
    if (!row) throw new RecordNotFoundError(`Task lease ${leaseId} was not found`)
    return asTaskLeaseRecord(row)
  }

  private async requireContextSnapshot(runner: Runner, snapshotId: string): Promise<ContextSnapshotRecord> {
    const rows = await runner.query<ContextSnapshotRow>(
      `SELECT * FROM context_snapshots WHERE id = $1`,
      [snapshotId],
    )
    const row = rows.rows[0]
    if (!row) throw new RecordNotFoundError(`Context snapshot ${snapshotId} was not found`)
    return asContextSnapshotRecord(row)
  }

  private async hydrateTaskRecord(runner: Runner, row: TaskRow): Promise<TaskRecord> {
    const depRows: QueryResult<{ depends_on_task_id: string }> = await runner.query(
      `SELECT depends_on_task_id FROM task_dependencies WHERE task_id = $1 ORDER BY depends_on_task_id ASC`,
      [row.id],
    )

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
      notBefore: row.not_before ? row.not_before.toISOString() : null,
      input: row.input ?? null,
      output: row.output ?? null,
      metadata: row.metadata ?? null,
      error: row.error,
      contextSnapshotId: row.context_snapshot_id,
      leaseId: row.lease_id,
      leasedBy: row.leased_by,
      leaseExpiresAt: row.lease_expires_at ? row.lease_expires_at.toISOString() : null,
      dependsOnTaskIds: depRows.rows.map(r => r.depends_on_task_id),
      dead: row.dead,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      startedAt: tsToIsoOrNull(row.started_at),
      completedAt: tsToIsoOrNull(row.completed_at),
    }
  }

  private async insertEvent(
    client: PoolClient,
    runId: string,
    taskId: string | null,
    attemptId: string | null,
    eventType: string,
    payload: JsonValue,
    createdAt: Date,
  ): Promise<void> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO events (run_id, task_id, attempt_id, event_type, payload, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING id`,
      [runId, taskId, attemptId, eventType, JSON.stringify(payload), createdAt],
    )
    if (this.eventListeners.length === 0) return
    const idRow = result.rows[0]
    if (!idRow) return
    const record: EventRecord = {
      id: Number(idRow.id),
      runId,
      taskId,
      attemptId,
      eventType,
      payload,
      createdAt: createdAt.toISOString(),
    }
    for (const listener of this.eventListeners) {
      try {
        const maybe = listener(record)
        if (maybe && typeof (maybe as Promise<unknown>).then === 'function') {
          void (maybe as Promise<unknown>).catch(() => {})
        }
      } catch {
        // Listeners are observability callbacks; swallow to avoid breaking durable writes.
      }
    }
  }

  private async recomputeRunStatus(client: PoolClient, runId: string, now: Date): Promise<RunRecord> {
    const current = await this.requireRun(client, runId)
    const rows = await client.query<{ status: TaskRecord['status'] }>(
      `SELECT status FROM tasks WHERE run_id = $1`,
      [runId],
    )
    const nextStatus = deriveRunStatus(current.status, rows.rows.map(r => r.status))
    if (nextStatus !== current.status) {
      await client.query(
        `UPDATE runs SET status = $1, updated_at = $2 WHERE id = $3`,
        [nextStatus, now, runId],
      )
      await this.insertEvent(client, runId, null, null, 'run.status.changed', {
        from: current.status,
        to: nextStatus,
      }, now)
    } else {
      await client.query(`UPDATE runs SET updated_at = $1 WHERE id = $2`, [now, runId])
    }
    return this.requireRun(client, runId)
  }

  private async lookupCompletion(
    runner: Runner,
    clientToken: string,
    taskId: string,
    expectedOutcome: 'completed' | 'failed',
  ): Promise<TaskRecord | null> {
    const rows = await runner.query<{ task_id: string; outcome: string }>(
      `SELECT task_id, outcome FROM task_completions WHERE client_token = $1`,
      [clientToken],
    )
    const row = rows.rows[0]
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
    return this.requireTask(runner, taskId)
  }

  private async recordCompletion(
    client: PoolClient,
    clientToken: string,
    taskId: string,
    runId: string,
    outcome: 'completed' | 'failed',
    now: Date,
  ): Promise<void> {
    await client.query(
      `INSERT INTO task_completions (client_token, task_id, run_id, outcome, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [clientToken, taskId, runId, outcome, now],
    )
  }

  private async assertActiveLease(
    client: PoolClient,
    task: TaskRecord,
    leaseId: string,
    workerId: string,
    now: Date,
  ): Promise<{ lease: TaskLeaseRecord; attempt: TaskAttemptRecord }> {
    if (!task.leaseId || task.leaseId !== leaseId || task.leasedBy !== workerId) {
      throw new LeaseConflictError(task.id)
    }
    if (!task.leaseExpiresAt || new Date(task.leaseExpiresAt).getTime() < now.getTime()) {
      throw new LeaseExpiredError(task.id)
    }
    const lease = await this.requireLease(client, leaseId)
    if (lease.status !== 'active' || lease.workerId !== workerId) {
      throw new LeaseConflictError(task.id)
    }
    return { lease, attempt: await this.requireAttempt(client, lease.attemptId) }
  }
}

/**
 * Run `fn` with a dedicated client checked out from the pool. Used by
 * atomic operations that must run multiple statements on a single session.
 */
export async function withClient<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}

/** Generate a uuid-v4 id suitable for run / task / lease primary keys. */
export function newId(): string {
  return randomUUID()
}
