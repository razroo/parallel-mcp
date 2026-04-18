import type { RunStatus, TaskStatus } from './types.js'
import { InvalidTransitionError } from './errors.js'

const TASK_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  queued: new Set(['leased', 'cancelled']),
  leased: new Set(['running', 'queued', 'blocked', 'waiting_input', 'completed', 'failed', 'cancelled']),
  running: new Set(['queued', 'blocked', 'waiting_input', 'completed', 'failed', 'cancelled']),
  blocked: new Set(['queued', 'cancelled']),
  waiting_input: new Set(['queued', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
}

const ACTIVE_TASK_STATUSES = new Set<TaskStatus>(['queued', 'leased', 'running'])
const WAITING_TASK_STATUSES = new Set<TaskStatus>(['blocked', 'waiting_input'])

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!TASK_TRANSITIONS[from].has(to)) {
    throw new InvalidTransitionError('task', from, to)
  }
}

export function deriveRunStatus(currentStatus: RunStatus, taskStatuses: TaskStatus[]): RunStatus {
  if (currentStatus === 'cancelled' && !taskStatuses.some(status => status === 'leased' || status === 'running')) {
    return 'cancelled'
  }

  if (taskStatuses.length === 0) return 'pending'

  if (taskStatuses.every(status => status === 'cancelled')) return 'cancelled'

  if (taskStatuses.every(status => status === 'completed' || status === 'cancelled')) {
    return taskStatuses.some(status => status === 'completed') ? 'completed' : 'cancelled'
  }

  if (taskStatuses.some(status => ACTIVE_TASK_STATUSES.has(status))) return 'active'

  if (taskStatuses.some(status => WAITING_TASK_STATUSES.has(status))) return 'waiting'

  if (taskStatuses.some(status => status === 'failed')) return 'failed'

  return currentStatus
}
