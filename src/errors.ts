export class ParallelMcpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class RecordNotFoundError extends ParallelMcpError {}

export class InvalidTransitionError extends ParallelMcpError {
  constructor(entity: string, from: string, to: string) {
    super(`Invalid ${entity} transition: ${from} -> ${to}`)
  }
}

export class LeaseConflictError extends ParallelMcpError {
  constructor(taskId: string) {
    super(`Task ${taskId} is not owned by the provided worker/lease pair`)
  }
}

export class LeaseExpiredError extends ParallelMcpError {
  constructor(taskId: string) {
    super(`Lease for task ${taskId} has already expired`)
  }
}

export class RunTerminalError extends ParallelMcpError {
  constructor(runId: string, status: string) {
    super(`Run ${runId} is ${status} and cannot accept new tasks`)
  }
}

export class DuplicateTaskKeyError extends ParallelMcpError {
  constructor(runId: string, key: string) {
    super(`Task with key ${key} already exists in run ${runId}`)
  }
}

export class MaxAttemptsExceededError extends ParallelMcpError {
  constructor(taskId: string, attempts: number) {
    super(`Task ${taskId} exceeded max attempts (${attempts})`)
  }
}

export class DependencyCycleError extends ParallelMcpError {
  constructor(message: string) {
    super(message)
  }
}
