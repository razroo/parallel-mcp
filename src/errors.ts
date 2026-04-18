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
