import type { ParallelMcpOrchestrator } from './orchestrator.js'
import type { ClaimTaskResult, ExpireLeaseResult, JsonValue, TaskLeaseRecord, TaskRecord } from './types.js'

/** Outcome a {@link WorkerHandler} returns to tell `runWorker` what to do next. */
export interface WorkerHandleResult {
  status: 'completed' | 'failed' | 'paused' | 'released'
  output?: JsonValue
  error?: string
  metadata?: JsonValue
  nextContext?: JsonValue
  nextContextLabel?: string
  pauseAs?: 'blocked' | 'waiting_input'
  reason?: string
}

/** Arguments handed to each invocation of a {@link WorkerHandler}. */
export interface WorkerHandlerContext {
  /** The claimed task. Already marked `running` by the time the handler runs. */
  task: TaskRecord
  /** The lease that proves ownership of this task. */
  lease: ClaimTaskResult['lease']
  /** The worker id that won the claim. */
  workerId: string
  /**
   * Aborted when **either** the worker is asked to stop **or** the run
   * containing this task is cancelled via `orchestrator.cancelRun()`. Honor
   * this for long-running I/O so cancellation propagates promptly.
   *
   * This is the composition of:
   *   - the worker-wide stop signal,
   *   - an external `signal` passed to `runWorker`,
   *   - a per-task run-cancellation signal sourced from the event log.
   */
  signal: AbortSignal
  /** Manually bump the lease. Rarely needed — `runWorker` heartbeats on its own timer. */
  heartbeat: (leaseMs?: number) => void
}

/**
 * Observer hooks for structured logging / metrics. Every callback is
 * optional and synchronous; exceptions inside a callback are routed to
 * `onError` so observability cannot break the worker loop.
 */
export interface WorkerObservers {
  /** Fires whenever `claimNextTask` returns a task. */
  onClaim?: (event: { task: TaskRecord; lease: TaskLeaseRecord; workerId: string }) => void
  /** Fires right before the user handler is invoked. */
  onHandlerStart?: (event: { task: TaskRecord; workerId: string }) => void
  /**
   * Fires after the user handler settles (resolved or thrown). `durationMs`
   * is the wall-clock time spent inside the handler.
   */
  onHandlerEnd?: (event: {
    task: TaskRecord
    workerId: string
    durationMs: number
    outcome: WorkerHandleResult | { status: 'threw'; error: unknown } | { status: 'drain_timeout' }
  }) => void
  /** Fires after each successful heartbeat bump of a task's lease. */
  onHeartbeat?: (event: { task: TaskRecord; lease: TaskLeaseRecord; workerId: string }) => void
  /**
   * Fires when the run containing the currently-executing task is
   * cancelled. The handler's `signal` has already been aborted before this
   * fires; this hook is a hint for structured logs.
   */
  onRunCancelled?: (event: { runId: string; task: TaskRecord; workerId: string }) => void
}

/**
 * Handler invoked for each claimed task. Return one of the standard outcomes
 * to let `runWorker` apply the right state transition. Throwing is treated as
 * `{ status: 'failed', error: err.message }`.
 */
export type WorkerHandler = (context: WorkerHandlerContext) => Promise<WorkerHandleResult> | WorkerHandleResult

/** Options accepted by {@link runWorker}. */
export interface RunWorkerOptions extends WorkerObservers {
  orchestrator: ParallelMcpOrchestrator
  workerId: string
  handler: WorkerHandler
  /** Only claim tasks whose `kind` is in this list. Omit to accept any kind. */
  kinds?: string[]
  /** Lease duration in ms applied to every claim. Defaults to `orchestrator.defaultLeaseMs`. */
  leaseMs?: number
  /** Heartbeat interval in ms. Defaults to `max(1_000, leaseMs/3)`. */
  heartbeatIntervalMs?: number
  /** Sleep between successful iterations. Set to 0 for a tight loop. */
  pollIntervalMs?: number
  /** Initial back-off when the queue is empty. */
  idleBackoffMs?: number
  /** Cap for the exponential idle back-off. */
  idleMaxBackoffMs?: number
  /** External `AbortSignal` that can stop the worker. Combined with `stop()`. */
  signal?: AbortSignal
  /** Observer for unexpected errors. Called with the offending task when available. */
  onError?: (error: unknown, task: TaskRecord | null) => void
  /** Whether each poll should opportunistically run `orchestrator.expireLeases()`. Default `true`. */
  expireLeasesOnPoll?: boolean
  /**
   * Grace period for an in-flight handler after `stop()` is called. If the
   * handler has not returned within this window, the task is released back to
   * the queue so another worker can pick it up; the original handler promise
   * is still awaited in the background.
   */
  drainTimeoutMs?: number
  /**
   * Automatically attach `SIGINT` and `SIGTERM` handlers that call `stop()`
   * once. Convenience for the 80% case where you are running a worker as its
   * own process. Prefer supplying your own `signal` / `stop()` when composing
   * with an existing shutdown orchestration.
   */
  installSignalHandlers?: boolean
  /**
   * When a `run.cancelled` event fires for the currently-executing task,
   * abort the handler's `signal` so it can wind down promptly. Default
   * `true`; set to `false` to keep running handlers oblivious to cancel
   * events (you'll still see the lease expire eventually).
   */
  propagateRunCancellation?: boolean
}

/** Handle returned by {@link runWorker}. */
export interface WorkerHandle {
  /** Resolves when the loop has fully exited. */
  stopped: Promise<void>
  /** Ask the worker to finish what it is doing and exit. Idempotent. */
  stop: () => void
  /** The `workerId` you passed in. */
  workerId: string
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void reject
  })
}

/**
 * Polling worker loop. Claims runnable tasks for a single `workerId`, runs
 * the supplied `handler` with lease ownership and a heartbeat, and applies
 * the returned outcome back to the store.
 *
 * Shape of the resulting handle: `{ stop, stopped, workerId }`. Await
 * `stopped` after `stop()` for a clean shutdown, or pass `signal` in to let
 * an external controller drive cancellation.
 */
export function runWorker(options: RunWorkerOptions): WorkerHandle {
  const {
    orchestrator,
    workerId,
    handler,
    kinds,
    leaseMs,
    heartbeatIntervalMs,
    pollIntervalMs = 250,
    idleBackoffMs = 500,
    idleMaxBackoffMs = 5_000,
    signal: externalSignal,
    onError,
    expireLeasesOnPoll = true,
    drainTimeoutMs,
    installSignalHandlers = false,
    propagateRunCancellation = true,
    onClaim,
    onHandlerStart,
    onHandlerEnd,
    onHeartbeat,
    onRunCancelled,
  } = options

  const controller = new AbortController()
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const signal = controller.signal

  let detachSignals: (() => void) | null = null
  if (installSignalHandlers) {
    const onSignal = (): void => controller.abort()
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    detachSignals = () => {
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
    }
  }

  const runCancelWatchers = new Map<string, () => void>()
  const detachRunCancelListener = orchestrator.addEventListener(event => {
    if (event.eventType !== 'run.cancelled') return
    const cb = runCancelWatchers.get(event.runId)
    if (cb) cb()
  })

  const observers: WorkerObservers = {}
  if (onClaim) observers.onClaim = onClaim
  if (onHandlerStart) observers.onHandlerStart = onHandlerStart
  if (onHandlerEnd) observers.onHandlerEnd = onHandlerEnd
  if (onHeartbeat) observers.onHeartbeat = onHeartbeat
  if (onRunCancelled) observers.onRunCancelled = onRunCancelled

  const effectiveLeaseMs = leaseMs ?? orchestrator.defaultLeaseMs
  const effectiveHeartbeatMs = heartbeatIntervalMs ?? Math.max(1_000, Math.floor(effectiveLeaseMs / 3))

  const loop = (async (): Promise<void> => {
    let idleDelay = idleBackoffMs
    try {
      while (!signal.aborted) {
        if (expireLeasesOnPoll) {
          try {
            orchestrator.expireLeases()
          } catch (error) {
            onError?.(error, null)
          }
        }

        let claim: ClaimTaskResult | null
        try {
          claim = orchestrator.claimNextTask({
            workerId,
            leaseMs: effectiveLeaseMs,
            ...(kinds ? { kinds } : {}),
          })
        } catch (error) {
          onError?.(error, null)
          await sleep(idleDelay, signal)
          idleDelay = Math.min(idleMaxBackoffMs, idleDelay * 2)
          continue
        }

        if (!claim) {
          await sleep(idleDelay, signal)
          idleDelay = Math.min(idleMaxBackoffMs, idleDelay * 2)
          continue
        }

        idleDelay = idleBackoffMs
        safeObserver(observers.onClaim, { task: claim.task, lease: claim.lease, workerId }, onError)

        await runOneTask({
          orchestrator,
          workerId,
          handler,
          claim,
          workerSignal: signal,
          heartbeatIntervalMs: effectiveHeartbeatMs,
          drainTimeoutMs,
          propagateRunCancellation,
          runCancelWatchers,
          observers,
          onError,
        })

        if (!signal.aborted && pollIntervalMs > 0) {
          await sleep(pollIntervalMs, signal)
        }
      }
    } finally {
      detachRunCancelListener()
      detachSignals?.()
    }
  })()

  return {
    workerId,
    stopped: loop,
    stop: () => controller.abort(),
  }
}

function safeObserver<T>(
  observer: ((event: T) => void) | undefined,
  event: T,
  onError?: (error: unknown, task: TaskRecord | null) => void,
): void {
  if (!observer) return
  try {
    observer(event)
  } catch (error) {
    onError?.(error, null)
  }
}

const DRAIN_TIMEOUT = Symbol('drain-timeout')

interface RunOneTaskOptions {
  orchestrator: ParallelMcpOrchestrator
  workerId: string
  handler: WorkerHandler
  claim: ClaimTaskResult
  workerSignal: AbortSignal
  heartbeatIntervalMs: number
  drainTimeoutMs: number | undefined
  propagateRunCancellation: boolean
  runCancelWatchers: Map<string, () => void>
  observers: WorkerObservers
  onError: ((error: unknown, task: TaskRecord | null) => void) | undefined
}

async function runOneTask(opts: RunOneTaskOptions): Promise<void> {
  const {
    orchestrator,
    workerId,
    handler,
    claim,
    workerSignal,
    heartbeatIntervalMs,
    drainTimeoutMs,
    propagateRunCancellation,
    runCancelWatchers,
    observers,
    onError,
  } = opts
  let task = claim.task
  let lease = claim.lease

  try {
    task = orchestrator.markTaskRunning({
      taskId: task.id,
      leaseId: lease.id,
      workerId,
    })
  } catch (error) {
    onError?.(error, task)
    return
  }

  const taskController = new AbortController()
  const abortForStop = (): void => taskController.abort()
  if (workerSignal.aborted) taskController.abort()
  else workerSignal.addEventListener('abort', abortForStop, { once: true })

  let detachRunWatcher: (() => void) | null = null
  if (propagateRunCancellation) {
    const runId = task.runId
    const onRunCancel = (): void => {
      taskController.abort()
      safeObserver(observers.onRunCancelled, { runId, task, workerId }, onError)
    }
    if (runCancelWatchers.has(runId)) {
      const existing = runCancelWatchers.get(runId)!
      const combined = (): void => {
        existing()
        onRunCancel()
      }
      runCancelWatchers.set(runId, combined)
      detachRunWatcher = () => {
        if (runCancelWatchers.get(runId) === combined) {
          runCancelWatchers.set(runId, existing)
        }
      }
    } else {
      runCancelWatchers.set(runId, onRunCancel)
      detachRunWatcher = () => {
        if (runCancelWatchers.get(runId) === onRunCancel) {
          runCancelWatchers.delete(runId)
        }
      }
    }
  }

  const taskSignal = taskController.signal

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  const requestHeartbeat = (leaseMs?: number): void => {
    try {
      const next = orchestrator.heartbeatLease({
        taskId: task.id,
        leaseId: lease.id,
        workerId,
        ...(leaseMs !== undefined ? { leaseMs } : {}),
      })
      lease = next
      safeObserver(observers.onHeartbeat, { task, lease, workerId }, onError)
    } catch (error) {
      onError?.(error, task)
    }
  }
  heartbeatTimer = setInterval(() => {
    if (taskSignal.aborted) return
    requestHeartbeat()
  }, heartbeatIntervalMs)

  safeObserver(observers.onHandlerStart, { task, workerId }, onError)
  const startedAt = Date.now()

  const handlerPromise = Promise.resolve().then(async () => handler({
    task,
    lease,
    workerId,
    signal: taskSignal,
    heartbeat: requestHeartbeat,
  }))

  try {
    const racePromise: Promise<WorkerHandleResult | typeof DRAIN_TIMEOUT> = drainTimeoutMs !== undefined
      ? Promise.race([handlerPromise, drainWatchdog(workerSignal, drainTimeoutMs)])
      : handlerPromise

    const result = await racePromise
    if (result === DRAIN_TIMEOUT) {
      safeObserver(
        observers.onHandlerEnd,
        { task, workerId, durationMs: Date.now() - startedAt, outcome: { status: 'drain_timeout' as const } },
        onError,
      )
      try {
        orchestrator.releaseTask({
          taskId: task.id,
          leaseId: lease.id,
          workerId,
          reason: 'worker_drain_timeout',
        })
      } catch (error) {
        onError?.(error, task)
      }
      handlerPromise.catch(error => onError?.(error, task))
      return
    }
    safeObserver(
      observers.onHandlerEnd,
      { task, workerId, durationMs: Date.now() - startedAt, outcome: result },
      onError,
    )
    applyResult(orchestrator, workerId, task, lease, result)
  } catch (error) {
    safeObserver(
      observers.onHandlerEnd,
      { task, workerId, durationMs: Date.now() - startedAt, outcome: { status: 'threw' as const, error } },
      onError,
    )
    onError?.(error, task)
    try {
      orchestrator.failTask({
        taskId: task.id,
        leaseId: lease.id,
        workerId,
        error: error instanceof Error ? error.message : String(error),
      })
    } catch (failError) {
      onError?.(failError, task)
    }
  } finally {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    workerSignal.removeEventListener('abort', abortForStop)
    detachRunWatcher?.()
  }
}

function drainWatchdog(signal: AbortSignal, drainTimeoutMs: number): Promise<typeof DRAIN_TIMEOUT> {
  return new Promise(resolve => {
    if (signal.aborted) {
      setTimeout(() => resolve(DRAIN_TIMEOUT), drainTimeoutMs)
      return
    }
    signal.addEventListener(
      'abort',
      () => {
        setTimeout(() => resolve(DRAIN_TIMEOUT), drainTimeoutMs)
      },
      { once: true },
    )
  })
}

function applyResult(
  orchestrator: ParallelMcpOrchestrator,
  workerId: string,
  task: TaskRecord,
  lease: ClaimTaskResult['lease'],
  result: WorkerHandleResult,
): void {
  switch (result.status) {
    case 'completed':
      orchestrator.completeTask({
        taskId: task.id,
        leaseId: lease.id,
        workerId,
        ...(result.output !== undefined ? { output: result.output } : {}),
        ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
        ...(result.nextContext !== undefined ? { nextContext: result.nextContext } : {}),
        ...(result.nextContextLabel !== undefined ? { nextContextLabel: result.nextContextLabel } : {}),
      })
      return
    case 'failed':
      orchestrator.failTask({
        taskId: task.id,
        leaseId: lease.id,
        workerId,
        error: result.error ?? 'unknown',
        ...(result.metadata !== undefined ? { metadata: result.metadata } : {}),
      })
      return
    case 'paused':
      orchestrator.pauseTask({
        taskId: task.id,
        leaseId: lease.id,
        workerId,
        status: result.pauseAs ?? 'blocked',
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      })
      return
    case 'released':
      orchestrator.releaseTask({
        taskId: task.id,
        leaseId: lease.id,
        workerId,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      })
      return
    default: {
      const _exhaustive: never = result.status
      throw new Error(`Unhandled worker result status: ${String(_exhaustive)}`)
    }
  }
}

/** Options for {@link scheduleExpireLeases}. */
export interface ScheduleExpireLeasesOptions {
  orchestrator: ParallelMcpOrchestrator
  /** How often to sweep expired leases. */
  intervalMs: number
  /** Stop the timer when this aborts. */
  signal?: AbortSignal
  /** Optional observer for unexpected errors from `expireLeases()`. */
  onError?: (error: unknown) => void
  /** Optional observer invoked with the per-tick result, useful for metrics. */
  onTick?: (result: ExpireLeaseResult) => void
  /**
   * Also install `SIGINT` / `SIGTERM` handlers that stop the timer. Handy for
   * one-process maintenance workers; skip it when composing with an existing
   * shutdown controller.
   */
  installSignalHandlers?: boolean
  /**
   * Run the first sweep immediately instead of waiting `intervalMs`. Default `true`.
   */
  runImmediately?: boolean
}

/** Handle returned by {@link scheduleExpireLeases}. */
export interface ScheduleExpireLeasesHandle {
  /** Cancel the timer. Idempotent. */
  stop: () => void
  /** Resolves when the timer has fully exited after `stop()` / `signal` abort. */
  stopped: Promise<void>
}

/**
 * Run `orchestrator.expireLeases()` on a timer. Useful as a dedicated
 * maintenance loop when workers pass `expireLeasesOnPoll: false`, or simply
 * to centralize retries under one sweeper process.
 *
 * This function is cheap; it's a thin `setInterval` with abort-signal and
 * signal-handler wiring. It does not hold a lock itself — concurrent
 * sweepers are safe because `expireLeases` is atomic in SQL.
 */
export function scheduleExpireLeases(
  options: ScheduleExpireLeasesOptions,
): ScheduleExpireLeasesHandle {
  const {
    orchestrator,
    intervalMs,
    signal: externalSignal,
    onError,
    onTick,
    installSignalHandlers = false,
    runImmediately = true,
  } = options

  if (!(intervalMs > 0)) {
    throw new Error('scheduleExpireLeases: intervalMs must be > 0')
  }

  const controller = new AbortController()
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  let detachSignals: (() => void) | null = null
  if (installSignalHandlers) {
    const onSignal = (): void => controller.abort()
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    detachSignals = () => {
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
    }
  }

  const tick = (): void => {
    if (controller.signal.aborted) return
    try {
      const result = orchestrator.expireLeases()
      onTick?.(result)
    } catch (error) {
      onError?.(error)
    }
  }

  const timer = setInterval(tick, intervalMs)
  // Node timers on recent versions support unref; guard for safety.
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    ;(timer as { unref: () => void }).unref()
  }

  const stopped = new Promise<void>(resolve => {
    controller.signal.addEventListener(
      'abort',
      () => {
        clearInterval(timer)
        detachSignals?.()
        resolve()
      },
      { once: true },
    )
  })

  if (runImmediately) tick()

  return {
    stop: () => controller.abort(),
    stopped,
  }
}
