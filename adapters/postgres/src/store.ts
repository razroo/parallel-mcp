import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
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
  ParallelMcpEventListener,
  ParallelMcpStore,
  PauseTaskOptions,
  PruneRunsOptions,
  PruneRunsResult,
  ReleaseTaskOptions,
  ResumeTaskOptions,
  RunRecord,
  TaskLeaseRecord,
  TaskRecord,
} from '@razroo/parallel-mcp'
import { POSTGRES_SCHEMA } from './schema.js'

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
 * Postgres-backed implementation of {@link ParallelMcpStore}.
 *
 * ⚠️ **Status: alpha / incomplete.** This reference implementation is meant
 * to demonstrate the shape of a non-SQLite adapter and to let
 * `@razroo/parallel-mcp-testkit` pin the contract. The following operations
 * are **not yet implemented** and will throw `NotImplementedError`:
 *
 * - `enqueueTask` (task dependency cycle detection in SQL)
 * - `claimNextTask` (atomic claim + lease + attempt insert path)
 * - `heartbeatLease`, `markTaskRunning`, `pauseTask`, `resumeTask`
 * - `completeTask`, `failTask`, `releaseTask`
 * - `appendContextSnapshot`, `cancelRun`, `expireLeases`
 * - `listRunTasks`, `listRunEvents`, `listRuns`, `listPendingTasks`
 * - `listEventsSince`, `pruneRuns`, `getCurrentContextSnapshot`, `getTask`
 * - `transaction`
 *
 * The currently-working surface is enough to cover the **run creation** path
 * in `runConformanceSuite`, and to verify schema / event-listener wiring on
 * a live Postgres. Community contributions welcome.
 */
export class PostgresParallelMcpStore implements ParallelMcpStore {
  readonly pool: Pool
  private eventListeners: ParallelMcpEventListener[] = []
  private closed = false

  constructor(options: PostgresParallelMcpStoreOptions) {
    this.pool = options.pool
    if (options.autoMigrate) {
      void this.pool.query(POSTGRES_SCHEMA)
    }
  }

  /** Run the canonical schema against the pool. Idempotent. */
  async migrate(): Promise<void> {
    await this.pool.query(POSTGRES_SCHEMA)
  }

  addEventListener(listener: ParallelMcpEventListener): () => void {
    this.eventListeners.push(listener)
    return () => {
      this.eventListeners = this.eventListeners.filter(l => l !== listener)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    // Pool ownership stays with the caller — we don't end() it.
  }

  createRun(_options: CreateRunOptions): RunRecord {
    // Postgres is async-by-nature, but ParallelMcpStore is sync.
    // The honest fix is to add an AsyncParallelMcpStore layer (see issue
    // tracker). For now every method throws so we don't lie by returning
    // incorrect types.
    throw new NotImplementedError('PostgresParallelMcpStore.createRun (sync vs async)')
  }

  enqueueTask(_options: EnqueueTaskOptions): TaskRecord {
    throw new NotImplementedError('PostgresParallelMcpStore.enqueueTask')
  }

  claimNextTask(_options: ClaimTaskOptions): ClaimTaskResult | null {
    throw new NotImplementedError('PostgresParallelMcpStore.claimNextTask')
  }

  heartbeatLease(_options: HeartbeatLeaseOptions): TaskLeaseRecord {
    throw new NotImplementedError('PostgresParallelMcpStore.heartbeatLease')
  }

  markTaskRunning(_options: Omit<PauseTaskOptions, 'status' | 'reason'>): TaskRecord {
    throw new NotImplementedError('PostgresParallelMcpStore.markTaskRunning')
  }

  pauseTask(_options: PauseTaskOptions): TaskRecord {
    throw new NotImplementedError('PostgresParallelMcpStore.pauseTask')
  }

  resumeTask(_options: ResumeTaskOptions): TaskRecord {
    throw new NotImplementedError('PostgresParallelMcpStore.resumeTask')
  }

  completeTask(_options: CompleteTaskOptions): TaskRecord {
    throw new NotImplementedError('PostgresParallelMcpStore.completeTask')
  }

  failTask(_options: FailTaskOptions): TaskRecord {
    throw new NotImplementedError('PostgresParallelMcpStore.failTask')
  }

  releaseTask(_options: ReleaseTaskOptions): TaskRecord {
    throw new NotImplementedError('PostgresParallelMcpStore.releaseTask')
  }

  appendContextSnapshot(_options: AppendContextSnapshotOptions): ContextSnapshotRecord {
    throw new NotImplementedError('PostgresParallelMcpStore.appendContextSnapshot')
  }

  cancelRun(_options: CancelRunOptions): RunRecord {
    throw new NotImplementedError('PostgresParallelMcpStore.cancelRun')
  }

  expireLeases(_options?: { now?: Date | string | number | undefined }): ExpireLeaseResult {
    throw new NotImplementedError('PostgresParallelMcpStore.expireLeases')
  }

  getRun(_runId: string): RunRecord | null {
    throw new NotImplementedError('PostgresParallelMcpStore.getRun')
  }

  getTask(_taskId: string): TaskRecord | null {
    throw new NotImplementedError('PostgresParallelMcpStore.getTask')
  }

  getCurrentContextSnapshot(_runId: string): ContextSnapshotRecord | null {
    throw new NotImplementedError('PostgresParallelMcpStore.getCurrentContextSnapshot')
  }

  listRunTasks(_runId: string): TaskRecord[] {
    throw new NotImplementedError('PostgresParallelMcpStore.listRunTasks')
  }

  listRunEvents(_runId: string): EventRecord[] {
    throw new NotImplementedError('PostgresParallelMcpStore.listRunEvents')
  }

  listRuns(_options?: ListRunsOptions): RunRecord[] {
    throw new NotImplementedError('PostgresParallelMcpStore.listRuns')
  }

  listPendingTasks(_options?: ListPendingTasksOptions): TaskRecord[] {
    throw new NotImplementedError('PostgresParallelMcpStore.listPendingTasks')
  }

  listEventsSince(_options?: ListEventsSinceOptions): ListEventsResult {
    throw new NotImplementedError('PostgresParallelMcpStore.listEventsSince')
  }

  pruneRuns(_options: PruneRunsOptions): PruneRunsResult {
    throw new NotImplementedError('PostgresParallelMcpStore.pruneRuns')
  }

  transaction<T>(_fn: () => T): T {
    throw new NotImplementedError('PostgresParallelMcpStore.transaction')
  }
}

/**
 * Thrown from every unimplemented `PostgresParallelMcpStore` method. Kept
 * out of the main error module so the core package does not advertise an
 * adapter-specific error.
 */
export class NotImplementedError extends Error {
  constructor(operation: string) {
    super(`${operation} is not yet implemented in @razroo/parallel-mcp-postgres (alpha). Contributions welcome.`)
    this.name = 'NotImplementedError'
  }
}

/**
 * Run `fn` with a dedicated client checked out from the pool. Used by future
 * atomic operations (claim, heartbeat, complete) where we want to run
 * multiple statements inside one transaction.
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
