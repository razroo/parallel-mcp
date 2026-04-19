/**
 * Base class for every error thrown by `@razroo/parallel-mcp`. All typed
 * errors extend this, so a single `instanceof ParallelMcpError` check in an
 * adapter is enough to tell "this is the library failing cleanly" apart from
 * "this is an unexpected runtime error".
 */
export class ParallelMcpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** Thrown when a run / task / attempt / lease / snapshot id does not exist. */
export class RecordNotFoundError extends ParallelMcpError {}

/** Thrown when the caller drives a task through an illegal state transition. */
export class InvalidTransitionError extends ParallelMcpError {
  constructor(entity: string, from: string, to: string) {
    super(`Invalid ${entity} transition: ${from} -> ${to}`)
  }
}

/**
 * Thrown when a write carries a `leaseId` / `workerId` that does not match the
 * current lease on the task. Usually means another worker took over after a
 * missed heartbeat — abandon this task and loop back to `claimNextTask`.
 */
export class LeaseConflictError extends ParallelMcpError {
  constructor(taskId: string) {
    super(`Task ${taskId} is not owned by the provided worker/lease pair`)
  }
}

/**
 * Thrown when the lease has passed `lease_expires_at` at the current
 * timestamp. Heartbeat more often (at least every `leaseMs/3`) to avoid this.
 */
export class LeaseExpiredError extends ParallelMcpError {
  constructor(taskId: string) {
    super(`Lease for task ${taskId} has already expired`)
  }
}

/** Thrown when a mutating write targets a run already in a terminal status. */
export class RunTerminalError extends ParallelMcpError {
  constructor(runId: string, status: string) {
    super(`Run ${runId} is ${status} and cannot accept new tasks`)
  }
}

/** Thrown when `enqueueTask` reuses a `key` inside the same run. */
export class DuplicateTaskKeyError extends ParallelMcpError {
  constructor(runId: string, key: string) {
    super(`Task with key ${key} already exists in run ${runId}`)
  }
}

/**
 * Thrown when the task has been attempted `maxAttempts` times. The task is
 * moved to `failed` with `error = 'max_attempts_exceeded'` before this is
 * surfaced to callers.
 */
export class MaxAttemptsExceededError extends ParallelMcpError {
  constructor(taskId: string, attempts: number) {
    super(`Task ${taskId} exceeded max attempts (${attempts})`)
  }
}

/** Thrown when `enqueueTask`'s dependency graph would introduce a cycle. */
export class DependencyCycleError extends ParallelMcpError {
  constructor(message: string) {
    super(message)
  }
}
