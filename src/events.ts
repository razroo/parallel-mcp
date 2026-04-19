import type {
  EventRecord,
  JsonValue,
  RunStatus,
  TaskStatus,
} from './types.js'

/**
 * String enum of every event type emitted by this library's durable log.
 *
 * Stability: **additive-only** within a major version. A new event type is
 * a minor-version change; removing / renaming one is a major-version change.
 *
 * Consumers of `listEventsSince` / `listRunEvents` / `onEvent` that need
 * exhaustive pattern matching should prefer the {@link TypedEvent}
 * discriminated union over raw strings.
 */
export type EventType =
  | 'run.created'
  | 'run.cancelled'
  | 'run.status.changed'
  | 'task.enqueued'
  | 'task.claimed'
  | 'task.lease_heartbeat'
  | 'task.running'
  | 'task.blocked'
  | 'task.waiting_input'
  | 'task.resumed'
  | 'task.completed'
  | 'task.failed'
  | 'task.released'
  | 'task.lease_expired'
  | 'context.snapshot.created'

/** Payload shape for `run.created`. */
export interface RunCreatedPayload {
  namespace: string
  externalId: string | null
  metadata: JsonValue | null
}

/** Payload shape for `run.cancelled`. */
export interface RunCancelledPayload {
  reason: string | null
}

/** Payload shape for `run.status.changed`. */
export interface RunStatusChangedPayload {
  from: RunStatus
  to: RunStatus
}

/** Payload shape for `task.enqueued`. */
export interface TaskEnqueuedPayload {
  kind: string
  priority: number
  dependsOnTaskIds: string[]
}

/** Payload shape for `task.claimed`. */
export interface TaskClaimedPayload {
  workerId: string
  leaseId: string
  leaseExpiresAt: string
}

/** Payload shape for `task.lease_heartbeat`. */
export interface TaskLeaseHeartbeatPayload {
  workerId: string
  leaseId: string
  leaseExpiresAt: string
}

/** Payload shape for `task.running`. */
export interface TaskRunningPayload {
  workerId: string
  leaseId: string
}

/** Payload shape for `task.blocked` and `task.waiting_input`. */
export interface TaskPausedPayload {
  workerId: string
  reason: string | null
}

/** Payload shape for `task.resumed`. Intentionally empty for now. */
export type TaskResumedPayload = Record<string, never>

/** Payload shape for `task.completed`. */
export interface TaskCompletedPayload {
  workerId: string
  output: JsonValue | null
}

/** Payload shape for `task.failed`. */
export interface TaskFailedPayload {
  workerId: string
  error: string
  /** Present when `task.failed` was emitted by the lease-expiry sweeper. */
  attemptCount?: number
  maxAttempts?: number | null
}

/** Payload shape for `task.released`. */
export interface TaskReleasedPayload {
  workerId: string
  reason: string | null
}

/** Payload shape for `task.lease_expired`. */
export interface TaskLeaseExpiredPayload {
  workerId: string
  previousStatus: TaskStatus
  leaseId: string
  notBefore: string | null
}

/** Payload shape for `context.snapshot.created`. */
export interface ContextSnapshotCreatedPayload {
  snapshotId: string
  scope: 'run' | 'task'
  label: string | null
}

/**
 * Mapping from {@link EventType} to its strongly-typed payload. Use this in
 * combination with {@link narrowEvent} (or your own helper) to do exhaustive
 * pattern matching on `orchestrator.listEventsSince` output.
 */
export interface EventPayloadByType {
  'run.created': RunCreatedPayload
  'run.cancelled': RunCancelledPayload
  'run.status.changed': RunStatusChangedPayload
  'task.enqueued': TaskEnqueuedPayload
  'task.claimed': TaskClaimedPayload
  'task.lease_heartbeat': TaskLeaseHeartbeatPayload
  'task.running': TaskRunningPayload
  'task.blocked': TaskPausedPayload
  'task.waiting_input': TaskPausedPayload
  'task.resumed': TaskResumedPayload
  'task.completed': TaskCompletedPayload
  'task.failed': TaskFailedPayload
  'task.released': TaskReleasedPayload
  'task.lease_expired': TaskLeaseExpiredPayload
  'context.snapshot.created': ContextSnapshotCreatedPayload
}

/**
 * Strongly-typed event record. Every `EventType` has a matching payload
 * shape. Useful for exhaustive `switch` statements:
 *
 * ```ts
 * function handle(event: TypedEvent) {
 *   switch (event.eventType) {
 *     case 'task.completed': return onCompleted(event.payload)
 *     case 'task.failed':    return onFailed(event.payload)
 *     // ...
 *   }
 * }
 * ```
 */
export type TypedEvent = {
  [K in EventType]: Omit<EventRecord, 'eventType' | 'payload'> & {
    eventType: K
    payload: EventPayloadByType[K]
  }
}[EventType]

/**
 * Narrow a raw {@link EventRecord} to its {@link TypedEvent} counterpart.
 * This is a pure cast — the library has already produced a well-shaped
 * payload, and validating the payload every read would be wasteful — but
 * having a single helper gives consumers one canonical entry point that
 * can add runtime validation later without a breaking change.
 */
export function asTypedEvent(event: EventRecord): TypedEvent {
  return event as unknown as TypedEvent
}

/** Narrowed event record where `eventType = K`. */
export type TypedEventOf<K extends EventType> = Extract<TypedEvent, { eventType: K }>

/**
 * Type predicate that narrows an {@link EventRecord} to a specific event
 * type. Prefer this over string comparisons in consumers that want
 * TypeScript to do the narrowing work.
 *
 * ```ts
 * if (isEventOfType(event, 'task.completed')) {
 *   event.payload.output // JsonValue | null
 * }
 * ```
 *
 * The first type argument is inferred from `type`, so call sites stay
 * concise: `isEventOfType(event, 'task.completed')`.
 */
export function isEventOfType<K extends EventType>(
  event: EventRecord,
  type: K,
): event is EventRecord & TypedEventOf<K> {
  return event.eventType === type
}
