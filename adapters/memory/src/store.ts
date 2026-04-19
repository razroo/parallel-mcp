import { randomUUID } from 'node:crypto'
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

type TimestampLike = Date | string | number | undefined

function toIso(value: TimestampLike): string {
  if (value === undefined) return new Date().toISOString()
  if (value instanceof Date) return value.toISOString()
  return new Date(value).toISOString()
}

function clone<T>(value: T): T {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(clone) as unknown as T
  if (typeof value === 'object') {
    const copy: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      copy[k] = clone(v) as unknown
    }
    return copy as T
  }
  return value
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

interface CompletionRecord {
  clientToken: string
  taskId: string
  runId: string
  outcome: 'completed' | 'failed'
  createdAt: string
}

/**
 * Minimal in-memory implementation of {@link AsyncParallelMcpStore}. Kept
 * deliberately compact so adapter authors can scan the whole contract in
 * one file — every method mirrors the canonical SQLite / Postgres
 * reference stores but operates on plain Maps.
 *
 * This store is **not** durable: everything lives in RAM and evaporates
 * when the process exits. Use it for:
 *
 * - unit tests against the orchestrator
 * - ephemeral CLIs and demos
 * - new adapter authors learning the state machine
 *
 * Concurrency model: methods are async to satisfy the contract but
 * run to completion synchronously. They are safe to call from the
 * same process across parallel async stacks.
 */
export class MemoryParallelMcpStore implements AsyncParallelMcpStore {
  private runs = new Map<string, RunRecord>()
  private tasks = new Map<string, TaskRecord>()
  private attempts = new Map<string, TaskAttemptRecord>()
  private leases = new Map<string, TaskLeaseRecord>()
  private leaseByClientToken = new Map<string, string>()
  private contextSnapshots = new Map<string, ContextSnapshotRecord>()
  private events: EventRecord[] = []
  private completions = new Map<string, CompletionRecord>()
  private eventSeq = 0
  private eventListeners: AsyncParallelMcpEventListener[] = []
  private closed = false

  addEventListener(listener: AsyncParallelMcpEventListener): () => void {
    this.eventListeners.push(listener)
    return () => {
      this.eventListeners = this.eventListeners.filter(l => l !== listener)
    }
  }

  async close(): Promise<void> {
    this.closed = true
  }

  /**
   * The sync in-memory store runs transactions as plain closures — there
   * are no `await` boundaries that could interleave another caller's
   * writes. For adapters with real I/O this is the place to wire up a
   * `BEGIN`/`COMMIT` pair.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.ensureOpen()
    return await fn()
  }

  async createRun(options: CreateRunOptions = {}): Promise<RunRecord> {
    this.ensureOpen()
    const runId = options.id ?? randomUUID()
    const now = toIso(options.now)
    const snapshotId = options.context === undefined ? null : randomUUID()

    const run: RunRecord = {
      id: runId,
      namespace: options.namespace ?? 'default',
      externalId: options.externalId ?? null,
      status: 'pending',
      metadata: options.metadata ?? null,
      currentContextSnapshotId: snapshotId,
      createdAt: now,
      updatedAt: now,
    }
    this.runs.set(runId, run)

    await this.emitEvent(runId, null, null, 'run.created', {
      namespace: run.namespace,
      externalId: run.externalId,
      metadata: run.metadata,
    }, now)

    if (snapshotId !== null) {
      const snapshot: ContextSnapshotRecord = {
        id: snapshotId,
        runId,
        taskId: null,
        scope: 'run',
        parentSnapshotId: null,
        label: 'run.initial',
        payload: options.context ?? null,
        createdAt: now,
      }
      this.contextSnapshots.set(snapshotId, snapshot)
      await this.emitEvent(runId, null, null, 'context.snapshot.created', {
        snapshotId,
        scope: 'run',
        label: 'run.initial',
      }, now)
    }

    return clone(run)
  }

  async enqueueTask(options: EnqueueTaskOptions): Promise<TaskRecord> {
    this.ensureOpen()
    const run = this.requireRun(options.runId)
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      throw new RunTerminalError(run.id, run.status)
    }

    const taskId = options.id ?? randomUUID()
    const now = toIso(options.now)
    const dependencies = options.dependsOnTaskIds ?? []

    if (options.key !== undefined) {
      for (const existing of this.tasks.values()) {
        if (existing.runId === options.runId && existing.key === options.key) {
          throw new DuplicateTaskKeyError(options.runId, options.key)
        }
      }
    }

    if (dependencies.length > 0) {
      if (dependencies.includes(taskId)) {
        throw new DependencyCycleError(`Task ${taskId} cannot depend on itself`)
      }
      for (const dep of dependencies) {
        const depTask = this.tasks.get(dep)
        if (!depTask || depTask.runId !== options.runId) {
          throw new Error(`One or more dependency task ids do not belong to run ${options.runId}`)
        }
      }
    }

    const task: TaskRecord = {
      id: taskId,
      runId: options.runId,
      key: options.key ?? null,
      kind: options.kind,
      status: 'queued',
      priority: options.priority ?? 0,
      maxAttempts: options.maxAttempts ?? null,
      attemptCount: 0,
      retryDelayMs: options.retry?.delayMs ?? null,
      retryBackoff: options.retry?.backoff ?? null,
      retryMaxDelayMs: options.retry?.maxDelayMs ?? null,
      timeoutMs: options.timeoutMs ?? null,
      notBefore: null,
      input: options.input ?? null,
      output: null,
      metadata: options.metadata ?? null,
      error: null,
      contextSnapshotId: options.contextSnapshotId ?? run.currentContextSnapshotId,
      leaseId: null,
      leasedBy: null,
      leaseExpiresAt: null,
      dependsOnTaskIds: [...dependencies].sort(),
      dead: false,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    }
    this.tasks.set(taskId, task)

    await this.emitEvent(options.runId, taskId, null, 'task.enqueued', {
      kind: task.kind,
      priority: task.priority,
      dependsOnTaskIds: task.dependsOnTaskIds,
    }, now)

    this.recomputeRunStatus(options.runId, now)
    return clone(task)
  }

  async claimNextTask(options: ClaimTaskOptions): Promise<ClaimTaskResult | null> {
    this.ensureOpen()
    const now = toIso(options.now)
    const expiresAt = toIso(new Date(new Date(now).getTime() + (options.leaseMs ?? 30_000)))
    const kinds = options.kinds ?? []
    const clientToken = options.clientToken ?? null

    if (clientToken !== null) {
      const existingLeaseId = this.leaseByClientToken.get(clientToken)
      if (existingLeaseId) {
        return this.rehydrateLease(existingLeaseId)
      }
    }

    this.expireLeasesSync(now)

    const eligible: TaskRecord[] = []
    for (const task of this.tasks.values()) {
      if (task.status !== 'queued') continue
      const run = this.runs.get(task.runId)
      if (!run) continue
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') continue
      if (task.notBefore !== null && task.notBefore > now) continue
      if (task.maxAttempts !== null && task.attemptCount >= task.maxAttempts) continue
      if (kinds.length > 0 && !kinds.includes(task.kind)) continue

      const depsComplete = task.dependsOnTaskIds.every(depId => {
        const dep = this.tasks.get(depId)
        return dep?.status === 'completed'
      })
      if (!depsComplete) continue

      eligible.push(task)
    }

    eligible.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority
      return a.createdAt.localeCompare(b.createdAt)
    })
    const picked = eligible[0]
    if (!picked) return null

    assertTaskTransition(picked.status, 'leased')
    const attemptId = randomUUID()
    const leaseId = randomUUID()

    const updatedTask: TaskRecord = {
      ...picked,
      status: 'leased',
      attemptCount: picked.attemptCount + 1,
      leaseId,
      leasedBy: options.workerId,
      leaseExpiresAt: expiresAt,
      notBefore: null,
      updatedAt: now,
    }
    this.tasks.set(picked.id, updatedTask)

    const attempt: TaskAttemptRecord = {
      id: attemptId,
      runId: picked.runId,
      taskId: picked.id,
      workerId: options.workerId,
      status: 'leased',
      leasedAt: now,
      startedAt: null,
      endedAt: null,
      leaseExpiresAt: expiresAt,
      error: null,
      output: null,
      metadata: null,
    }
    this.attempts.set(attemptId, attempt)

    const lease: TaskLeaseRecord = {
      id: leaseId,
      runId: picked.runId,
      taskId: picked.id,
      attemptId,
      workerId: options.workerId,
      status: 'active',
      acquiredAt: now,
      expiresAt,
      heartbeatAt: now,
      releasedAt: null,
      clientToken,
    }
    this.leases.set(leaseId, lease)
    if (clientToken !== null) this.leaseByClientToken.set(clientToken, leaseId)

    await this.emitEvent(picked.runId, picked.id, attemptId, 'task.claimed', {
      workerId: options.workerId,
      leaseId,
      leaseExpiresAt: expiresAt,
    }, now)
    this.recomputeRunStatus(picked.runId, now)

    return {
      run: clone(this.requireRun(picked.runId)),
      task: clone(updatedTask),
      attempt: clone(attempt),
      lease: clone(lease),
    }
  }

  private async rehydrateLease(leaseId: string): Promise<ClaimTaskResult> {
    const lease = this.requireLease(leaseId)
    return {
      run: clone(this.requireRun(lease.runId)),
      task: clone(this.requireTask(lease.taskId)),
      attempt: clone(this.requireAttempt(lease.attemptId)),
      lease: clone(lease),
    }
  }

  async heartbeatLease(options: HeartbeatLeaseOptions): Promise<TaskLeaseRecord> {
    this.ensureOpen()
    const now = toIso(options.now)
    const expiresAt = toIso(new Date(new Date(now).getTime() + (options.leaseMs ?? 30_000)))
    const task = this.requireTask(options.taskId)
    const active = this.assertActiveLease(task, options.leaseId, options.workerId, now)

    this.tasks.set(task.id, { ...task, leaseExpiresAt: expiresAt, updatedAt: now })
    this.attempts.set(active.attempt.id, { ...active.attempt, leaseExpiresAt: expiresAt })
    const updatedLease: TaskLeaseRecord = { ...active.lease, expiresAt, heartbeatAt: now }
    this.leases.set(active.lease.id, updatedLease)

    await this.emitEvent(task.runId, task.id, active.attempt.id, 'task.lease_heartbeat', {
      workerId: options.workerId,
      leaseId: options.leaseId,
      leaseExpiresAt: expiresAt,
    }, now)

    return clone(updatedLease)
  }

  async markTaskRunning(options: Omit<PauseTaskOptions, 'status' | 'reason'>): Promise<TaskRecord> {
    this.ensureOpen()
    const now = toIso(options.now)
    const task = this.requireTask(options.taskId)
    const active = this.assertActiveLease(task, options.leaseId, options.workerId, now)
    assertTaskTransition(task.status, 'running')

    const updated: TaskRecord = {
      ...task,
      status: 'running',
      startedAt: task.startedAt ?? now,
      updatedAt: now,
    }
    this.tasks.set(task.id, updated)
    this.attempts.set(active.attempt.id, {
      ...active.attempt,
      status: 'running',
      startedAt: active.attempt.startedAt ?? now,
    })

    await this.emitEvent(task.runId, task.id, active.attempt.id, 'task.running', {
      workerId: options.workerId,
      leaseId: options.leaseId,
    }, now)
    this.recomputeRunStatus(task.runId, now)
    return clone(updated)
  }

  async pauseTask(options: PauseTaskOptions): Promise<TaskRecord> {
    this.ensureOpen()
    const now = toIso(options.now)
    const task = this.requireTask(options.taskId)
    const active = this.assertActiveLease(task, options.leaseId, options.workerId, now)
    assertTaskTransition(task.status, options.status)

    const updated: TaskRecord = {
      ...task,
      status: options.status,
      leaseId: null,
      leasedBy: null,
      leaseExpiresAt: null,
      startedAt: task.startedAt ?? now,
      updatedAt: now,
    }
    this.tasks.set(task.id, updated)
    this.attempts.set(active.attempt.id, {
      ...active.attempt,
      status: 'released',
      endedAt: active.attempt.endedAt ?? now,
    })
    this.leases.set(active.lease.id, {
      ...active.lease,
      status: 'released',
      releasedAt: active.lease.releasedAt ?? now,
      heartbeatAt: now,
    })

    await this.emitEvent(task.runId, task.id, active.attempt.id, `task.${options.status}`, {
      workerId: options.workerId,
      reason: options.reason ?? null,
    }, now)
    this.recomputeRunStatus(task.runId, now)
    return clone(updated)
  }

  async resumeTask(options: ResumeTaskOptions): Promise<TaskRecord> {
    this.ensureOpen()
    const now = toIso(options.now)
    const task = this.requireTask(options.taskId)
    if (task.status !== 'blocked' && task.status !== 'waiting_input') {
      throw new InvalidTransitionError('task', task.status, 'queued')
    }
    assertTaskTransition(task.status, 'queued')

    const updated: TaskRecord = { ...task, status: 'queued', updatedAt: now }
    this.tasks.set(task.id, updated)

    await this.emitEvent(task.runId, task.id, null, 'task.resumed', {}, now)
    this.recomputeRunStatus(task.runId, now)
    return clone(updated)
  }

  async completeTask(options: CompleteTaskOptions): Promise<TaskRecord> {
    this.ensureOpen()
    const now = toIso(options.now)
    if (options.clientToken !== undefined) {
      const prior = this.lookupCompletion(options.clientToken, options.taskId, 'completed')
      if (prior) return clone(prior)
    }
    const task = this.requireTask(options.taskId)
    const active = this.assertActiveLease(task, options.leaseId, options.workerId, now)
    assertTaskTransition(task.status, 'completed')

    if (options.nextContext !== undefined) {
      const parentSnapshotId = task.contextSnapshotId ?? this.requireRun(task.runId).currentContextSnapshotId ?? null
      await this.appendContextSnapshot({
        runId: task.runId,
        taskId: task.id,
        scope: 'run',
        ...(parentSnapshotId ? { parentSnapshotId } : {}),
        label: options.nextContextLabel ?? `${task.kind}.completed`,
        payload: options.nextContext,
        now,
      })
    }

    const updated: TaskRecord = {
      ...task,
      status: 'completed',
      output: options.output ?? null,
      metadata: options.metadata ?? task.metadata,
      leaseId: null,
      leasedBy: null,
      leaseExpiresAt: null,
      startedAt: task.startedAt ?? now,
      completedAt: now,
      updatedAt: now,
    }
    this.tasks.set(task.id, updated)
    this.attempts.set(active.attempt.id, {
      ...active.attempt,
      status: 'completed',
      output: options.output ?? null,
      metadata: options.metadata ?? active.attempt.metadata,
      startedAt: active.attempt.startedAt ?? now,
      endedAt: now,
    })
    this.leases.set(active.lease.id, {
      ...active.lease,
      status: 'released',
      releasedAt: now,
      heartbeatAt: now,
    })

    await this.emitEvent(task.runId, task.id, active.attempt.id, 'task.completed', {
      workerId: options.workerId,
      output: options.output ?? null,
    }, now)
    if (options.clientToken !== undefined) {
      this.recordCompletion(options.clientToken, task.id, task.runId, 'completed', now)
    }
    this.recomputeRunStatus(task.runId, now)
    return clone(updated)
  }

  async failTask(options: FailTaskOptions): Promise<TaskRecord> {
    this.ensureOpen()
    const now = toIso(options.now)
    if (options.clientToken !== undefined) {
      const prior = this.lookupCompletion(options.clientToken, options.taskId, 'failed')
      if (prior) return clone(prior)
    }
    const task = this.requireTask(options.taskId)
    const active = this.assertActiveLease(task, options.leaseId, options.workerId, now)
    assertTaskTransition(task.status, 'failed')

    const updated: TaskRecord = {
      ...task,
      status: 'failed',
      error: options.error,
      metadata: options.metadata ?? task.metadata,
      leaseId: null,
      leasedBy: null,
      leaseExpiresAt: null,
      startedAt: task.startedAt ?? now,
      completedAt: now,
      updatedAt: now,
    }
    this.tasks.set(task.id, updated)
    this.attempts.set(active.attempt.id, {
      ...active.attempt,
      status: 'failed',
      error: options.error,
      metadata: options.metadata ?? active.attempt.metadata,
      startedAt: active.attempt.startedAt ?? now,
      endedAt: now,
    })
    this.leases.set(active.lease.id, {
      ...active.lease,
      status: 'released',
      releasedAt: now,
      heartbeatAt: now,
    })

    await this.emitEvent(task.runId, task.id, active.attempt.id, 'task.failed', {
      workerId: options.workerId,
      error: options.error,
    }, now)
    if (options.clientToken !== undefined) {
      this.recordCompletion(options.clientToken, task.id, task.runId, 'failed', now)
    }
    this.recomputeRunStatus(task.runId, now)
    return clone(updated)
  }

  async releaseTask(options: ReleaseTaskOptions): Promise<TaskRecord> {
    this.ensureOpen()
    const now = toIso(options.now)
    const task = this.requireTask(options.taskId)
    const active = this.assertActiveLease(task, options.leaseId, options.workerId, now)
    assertTaskTransition(task.status, 'queued')

    const updated: TaskRecord = {
      ...task,
      status: 'queued',
      leaseId: null,
      leasedBy: null,
      leaseExpiresAt: null,
      updatedAt: now,
    }
    this.tasks.set(task.id, updated)
    this.attempts.set(active.attempt.id, {
      ...active.attempt,
      status: 'released',
      endedAt: active.attempt.endedAt ?? now,
    })
    this.leases.set(active.lease.id, {
      ...active.lease,
      status: 'released',
      releasedAt: active.lease.releasedAt ?? now,
      heartbeatAt: now,
    })

    await this.emitEvent(task.runId, task.id, active.attempt.id, 'task.released', {
      workerId: options.workerId,
      reason: options.reason ?? null,
    }, now)
    this.recomputeRunStatus(task.runId, now)
    return clone(updated)
  }

  async appendContextSnapshot(options: AppendContextSnapshotOptions): Promise<ContextSnapshotRecord> {
    this.ensureOpen()
    const run = this.requireRun(options.runId)
    const now = toIso(options.now)
    const snapshotId = options.id ?? randomUUID()

    const snapshot: ContextSnapshotRecord = {
      id: snapshotId,
      runId: options.runId,
      taskId: options.taskId ?? null,
      scope: options.scope ?? 'run',
      parentSnapshotId: options.parentSnapshotId ?? run.currentContextSnapshotId,
      label: options.label ?? null,
      payload: options.payload,
      createdAt: now,
    }
    this.contextSnapshots.set(snapshotId, snapshot)

    if ((options.scope ?? 'run') === 'run') {
      this.runs.set(run.id, { ...run, currentContextSnapshotId: snapshotId, updatedAt: now })
    }
    if (options.taskId) {
      const task = this.tasks.get(options.taskId)
      if (task) {
        this.tasks.set(task.id, { ...task, contextSnapshotId: snapshotId, updatedAt: now })
      }
    }

    await this.emitEvent(options.runId, options.taskId ?? null, null, 'context.snapshot.created', {
      snapshotId,
      scope: snapshot.scope,
      label: snapshot.label,
    }, now)

    return clone(snapshot)
  }

  async cancelRun(options: CancelRunOptions): Promise<RunRecord> {
    this.ensureOpen()
    const now = toIso(options.now)
    const run = this.requireRun(options.runId)
    if (run.status === 'cancelled') return clone(run)

    this.runs.set(run.id, { ...run, status: 'cancelled', updatedAt: now })

    for (const task of this.tasks.values()) {
      if (task.runId !== options.runId) continue
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') continue
      this.tasks.set(task.id, {
        ...task,
        status: 'cancelled',
        leaseId: null,
        leasedBy: null,
        leaseExpiresAt: null,
        updatedAt: now,
        completedAt: task.completedAt ?? now,
      })
    }
    for (const attempt of this.attempts.values()) {
      if (attempt.runId !== options.runId) continue
      if (attempt.status !== 'leased' && attempt.status !== 'running') continue
      this.attempts.set(attempt.id, {
        ...attempt,
        status: 'cancelled',
        endedAt: attempt.endedAt ?? now,
      })
    }
    for (const lease of this.leases.values()) {
      if (lease.runId !== options.runId) continue
      if (lease.status !== 'active') continue
      this.leases.set(lease.id, {
        ...lease,
        status: 'cancelled',
        releasedAt: lease.releasedAt ?? now,
        heartbeatAt: now,
      })
    }

    await this.emitEvent(options.runId, null, null, 'run.cancelled', {
      reason: options.reason ?? null,
    }, now)

    return clone(this.requireRun(options.runId))
  }

  async expireLeases(options: { now?: TimestampLike } = {}): Promise<ExpireLeaseResult> {
    this.ensureOpen()
    const now = toIso(options.now)
    const expired = this.expireLeasesSync(now)
    return { expiredTaskIds: expired, count: expired.length }
  }

  private expireLeasesSync(now: string): string[] {
    const expired: string[] = []
    for (const task of Array.from(this.tasks.values())) {
      if (task.status !== 'leased' && task.status !== 'running') continue
      if (!task.leaseExpiresAt || task.leaseExpiresAt >= now) continue
      if (!task.leaseId) continue

      const lease = this.leases.get(task.leaseId)
      if (!lease) continue
      const attempt = this.attempts.get(lease.attemptId)
      if (!attempt) continue

      this.attempts.set(attempt.id, { ...attempt, status: 'expired', endedAt: attempt.endedAt ?? now })
      this.leases.set(lease.id, {
        ...lease,
        status: 'expired',
        releasedAt: lease.releasedAt ?? now,
        heartbeatAt: now,
      })

      const exhausted = task.maxAttempts !== null && task.attemptCount >= task.maxAttempts
      if (exhausted) {
        this.tasks.set(task.id, {
          ...task,
          status: 'failed',
          error: 'max_attempts_exceeded',
          leaseId: null,
          leasedBy: null,
          leaseExpiresAt: null,
          notBefore: null,
          dead: true,
          updatedAt: now,
          completedAt: now,
        })
        void this.emitEvent(task.runId, task.id, attempt.id, 'task.failed', {
          workerId: task.leasedBy,
          error: 'max_attempts_exceeded',
          attemptCount: task.attemptCount,
          maxAttempts: task.maxAttempts,
        }, now)
        void this.emitEvent(task.runId, task.id, attempt.id, 'task.dead_lettered', {
          workerId: task.leasedBy,
          attemptCount: task.attemptCount,
          maxAttempts: task.maxAttempts,
          lastError: 'max_attempts_exceeded',
        }, now)
      } else {
        const notBefore = computeNotBefore(task, now)
        this.tasks.set(task.id, {
          ...task,
          status: 'queued',
          leaseId: null,
          leasedBy: null,
          leaseExpiresAt: null,
          notBefore,
          updatedAt: now,
        })
        void this.emitEvent(task.runId, task.id, attempt.id, 'task.lease_expired', {
          workerId: task.leasedBy,
          previousStatus: task.status,
          leaseId: lease.id,
          notBefore,
        }, now)
      }
      this.recomputeRunStatus(task.runId, now)
      expired.push(task.id)
    }
    return expired
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    this.ensureOpen()
    const run = this.runs.get(runId)
    return run ? clone(run) : null
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    this.ensureOpen()
    const task = this.tasks.get(taskId)
    return task ? clone(task) : null
  }

  async getCurrentContextSnapshot(runId: string): Promise<ContextSnapshotRecord | null> {
    this.ensureOpen()
    const run = this.runs.get(runId)
    if (!run?.currentContextSnapshotId) return null
    const snapshot = this.contextSnapshots.get(run.currentContextSnapshotId)
    return snapshot ? clone(snapshot) : null
  }

  async listRunTasks(runId: string): Promise<TaskRecord[]> {
    this.ensureOpen()
    const rows = Array.from(this.tasks.values())
      .filter(task => task.runId === runId)
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority
        return a.createdAt.localeCompare(b.createdAt)
      })
    return rows.map(clone)
  }

  async listRunEvents(runId: string): Promise<EventRecord[]> {
    this.ensureOpen()
    return this.events.filter(e => e.runId === runId).map(clone)
  }

  async listRuns(options: ListRunsOptions = {}): Promise<RunRecord[]> {
    this.ensureOpen()
    let rows = Array.from(this.runs.values())
    if (options.namespace !== undefined) {
      rows = rows.filter(r => r.namespace === options.namespace)
    }
    if (options.externalId !== undefined) {
      rows = rows.filter(r => r.externalId === options.externalId)
    }
    if (options.statuses && options.statuses.length > 0) {
      const wanted = new Set(options.statuses)
      rows = rows.filter(r => wanted.has(r.status))
    }
    if (options.updatedAfter !== undefined) {
      const cutoff = toIso(options.updatedAfter)
      rows = rows.filter(r => r.updatedAt >= cutoff)
    }
    if (options.updatedBefore !== undefined) {
      const cutoff = toIso(options.updatedBefore)
      rows = rows.filter(r => r.updatedAt < cutoff)
    }

    const orderCol = options.orderBy === 'created_at' ? 'createdAt' : 'updatedAt'
    const dir = options.orderDir === 'asc' ? 1 : -1
    rows.sort((a, b) => {
      const cmp = a[orderCol].localeCompare(b[orderCol])
      if (cmp !== 0) return cmp * dir
      return a.id.localeCompare(b.id)
    })

    const offset = options.offset ?? 0
    const limit = options.limit ?? 100
    return rows.slice(offset, offset + limit).map(clone)
  }

  async listPendingTasks(options: ListPendingTasksOptions = {}): Promise<TaskRecord[]> {
    this.ensureOpen()
    let rows = Array.from(this.tasks.values()).filter(t => t.status === 'queued')
    if (options.runId !== undefined) {
      rows = rows.filter(t => t.runId === options.runId)
    }
    if (options.kinds && options.kinds.length > 0) {
      const wanted = new Set(options.kinds)
      rows = rows.filter(t => wanted.has(t.kind))
    }
    if (options.readyBy !== undefined) {
      const cutoff = toIso(options.readyBy)
      rows = rows.filter(t => t.notBefore === null || t.notBefore <= cutoff)
    }
    rows.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority
      return a.createdAt.localeCompare(b.createdAt)
    })
    const limit = options.limit ?? 100
    return rows.slice(0, limit).map(clone)
  }

  async listEventsSince(options: ListEventsSinceOptions = {}): Promise<ListEventsResult> {
    this.ensureOpen()
    let rows = this.events
    if (options.afterId !== undefined) {
      rows = rows.filter(e => e.id > options.afterId!)
    }
    if (options.runId !== undefined) {
      rows = rows.filter(e => e.runId === options.runId)
    }
    if (options.eventTypes && options.eventTypes.length > 0) {
      const wanted = new Set(options.eventTypes)
      rows = rows.filter(e => wanted.has(e.eventType))
    }
    const limit = Math.max(1, options.limit ?? 200)
    const events = rows.slice(0, limit).map(clone)
    const last = events.length > 0 ? events[events.length - 1] : undefined
    const nextCursor = last ? last.id : (options.afterId ?? null)
    return { events, nextCursor }
  }

  async pruneRuns(options: PruneRunsOptions): Promise<PruneRunsResult> {
    this.ensureOpen()
    const cutoff = toIso(options.olderThan)
    const statuses = new Set<RunRecord['status']>(
      options.statuses && options.statuses.length > 0
        ? options.statuses
        : ['completed', 'failed', 'cancelled'],
    )
    const limit = options.limit ?? 500

    const ids: string[] = []
    const candidates = Array.from(this.runs.values())
      .filter(r => statuses.has(r.status) && r.updatedAt < cutoff)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, limit)

    for (const run of candidates) {
      ids.push(run.id)
      this.runs.delete(run.id)

      for (const task of Array.from(this.tasks.values())) {
        if (task.runId === run.id) this.tasks.delete(task.id)
      }
      for (const attempt of Array.from(this.attempts.values())) {
        if (attempt.runId === run.id) this.attempts.delete(attempt.id)
      }
      for (const lease of Array.from(this.leases.values())) {
        if (lease.runId === run.id) {
          this.leases.delete(lease.id)
          if (lease.clientToken !== null) this.leaseByClientToken.delete(lease.clientToken)
        }
      }
      for (const snap of Array.from(this.contextSnapshots.values())) {
        if (snap.runId === run.id) this.contextSnapshots.delete(snap.id)
      }
      for (const completion of Array.from(this.completions.values())) {
        if (completion.runId === run.id) this.completions.delete(completion.clientToken)
      }
      this.events = this.events.filter(e => e.runId !== run.id)
    }

    return { prunedRunIds: ids, count: ids.length }
  }

  async listDeadTasks(options: ListDeadTasksOptions = {}): Promise<TaskRecord[]> {
    this.ensureOpen()
    let rows = Array.from(this.tasks.values()).filter(t => t.dead)
    if (options.runId) rows = rows.filter(t => t.runId === options.runId)
    if (options.kinds && options.kinds.length > 0) {
      const wanted = new Set(options.kinds)
      rows = rows.filter(t => wanted.has(t.kind))
    }
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    const limit = options.limit ?? 100
    const offset = options.offset ?? 0
    return rows.slice(offset, offset + limit).map(clone)
  }

  async requeueDeadTask(options: RequeueDeadTaskOptions): Promise<TaskRecord> {
    this.ensureOpen()
    const now = toIso(options.now)
    const resetAttempts = options.resetAttempts !== false
    const notBefore = options.notBefore === undefined ? null : toIso(options.notBefore)
    const task = this.requireTask(options.taskId)
    if (!task.dead) {
      throw new InvalidTransitionError('task', task.status, 'queued')
    }

    const updated: TaskRecord = {
      ...task,
      status: 'queued',
      dead: false,
      error: null,
      leaseId: null,
      leasedBy: null,
      leaseExpiresAt: null,
      startedAt: null,
      completedAt: null,
      notBefore,
      attemptCount: resetAttempts ? 0 : task.attemptCount,
      updatedAt: now,
    }
    this.tasks.set(task.id, updated)

    await this.emitEvent(task.runId, task.id, null, 'task.requeued_from_dlq', {
      resetAttempts,
      notBefore,
      reason: options.reason ?? null,
      previousAttemptCount: task.attemptCount,
    }, now)

    this.recomputeRunStatus(task.runId, now)
    return clone(updated)
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('MemoryParallelMcpStore has been closed')
  }

  private requireRun(runId: string): RunRecord {
    const run = this.runs.get(runId)
    if (!run) throw new RecordNotFoundError(`Run ${runId} was not found`)
    return run
  }

  private requireTask(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId)
    if (!task) throw new RecordNotFoundError(`Task ${taskId} was not found`)
    return task
  }

  private requireAttempt(attemptId: string): TaskAttemptRecord {
    const attempt = this.attempts.get(attemptId)
    if (!attempt) throw new RecordNotFoundError(`Task attempt ${attemptId} was not found`)
    return attempt
  }

  private requireLease(leaseId: string): TaskLeaseRecord {
    const lease = this.leases.get(leaseId)
    if (!lease) throw new RecordNotFoundError(`Task lease ${leaseId} was not found`)
    return lease
  }

  private async emitEvent(
    runId: string,
    taskId: string | null,
    attemptId: string | null,
    eventType: string,
    payload: JsonValue,
    createdAt: string,
  ): Promise<void> {
    this.eventSeq += 1
    const record: EventRecord = {
      id: this.eventSeq,
      runId,
      taskId,
      attemptId,
      eventType,
      payload: clone(payload),
      createdAt,
    }
    this.events.push(record)
    if (this.eventListeners.length === 0) return
    for (const listener of this.eventListeners) {
      try {
        const maybe = listener(clone(record))
        if (maybe && typeof (maybe as Promise<unknown>).then === 'function') {
          void (maybe as Promise<unknown>).catch(() => {})
        }
      } catch {
        // observability must not break writes
      }
    }
  }

  private recomputeRunStatus(runId: string, now: string): void {
    const current = this.runs.get(runId)
    if (!current) return
    const statuses: TaskRecord['status'][] = []
    for (const task of this.tasks.values()) {
      if (task.runId === runId) statuses.push(task.status)
    }
    const next = deriveRunStatus(current.status, statuses)
    if (next !== current.status) {
      this.runs.set(runId, { ...current, status: next, updatedAt: now })
      void this.emitEvent(runId, null, null, 'run.status.changed', {
        from: current.status,
        to: next,
      }, now)
    } else {
      this.runs.set(runId, { ...current, updatedAt: now })
    }
  }

  private lookupCompletion(
    clientToken: string,
    taskId: string,
    expectedOutcome: 'completed' | 'failed',
  ): TaskRecord | null {
    const record = this.completions.get(clientToken)
    if (!record) return null
    if (record.taskId !== taskId) {
      throw new Error(
        `clientToken ${clientToken} was already used for task ${record.taskId}; refusing to reuse it for task ${taskId}`,
      )
    }
    if (record.outcome !== expectedOutcome) {
      throw new Error(
        `clientToken ${clientToken} already recorded a ${record.outcome} outcome for task ${taskId}; refusing to re-apply as ${expectedOutcome}`,
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
    this.completions.set(clientToken, { clientToken, taskId, runId, outcome, createdAt: now })
  }

  private assertActiveLease(
    task: TaskRecord,
    leaseId: string,
    workerId: string,
    now: string,
  ): { lease: TaskLeaseRecord; attempt: TaskAttemptRecord } {
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
    return { lease, attempt: this.requireAttempt(lease.attemptId) }
  }
}
