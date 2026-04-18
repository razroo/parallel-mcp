import type { ParallelMcpOrchestrator } from './orchestrator.js'
import type { ClaimTaskResult, JsonValue, TaskRecord } from './types.js'

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

export interface WorkerHandlerContext {
  task: TaskRecord
  lease: ClaimTaskResult['lease']
  workerId: string
  signal: AbortSignal
  heartbeat: (leaseMs?: number) => void
}

export type WorkerHandler = (context: WorkerHandlerContext) => Promise<WorkerHandleResult> | WorkerHandleResult

export interface RunWorkerOptions {
  orchestrator: ParallelMcpOrchestrator
  workerId: string
  handler: WorkerHandler
  kinds?: string[]
  leaseMs?: number
  heartbeatIntervalMs?: number
  pollIntervalMs?: number
  idleBackoffMs?: number
  idleMaxBackoffMs?: number
  signal?: AbortSignal
  onError?: (error: unknown, task: TaskRecord | null) => void
  expireLeasesOnPoll?: boolean
  drainTimeoutMs?: number
}

export interface WorkerHandle {
  stopped: Promise<void>
  stop: () => void
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
  } = options

  const controller = new AbortController()
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const signal = controller.signal

  const effectiveLeaseMs = leaseMs ?? orchestrator.defaultLeaseMs
  const effectiveHeartbeatMs = heartbeatIntervalMs ?? Math.max(1_000, Math.floor(effectiveLeaseMs / 3))

  const loop = (async (): Promise<void> => {
    let idleDelay = idleBackoffMs
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
      await runOneTask(
        orchestrator,
        workerId,
        handler,
        claim,
        signal,
        effectiveHeartbeatMs,
        drainTimeoutMs,
        onError,
      )

      if (!signal.aborted && pollIntervalMs > 0) {
        await sleep(pollIntervalMs, signal)
      }
    }
  })()

  return {
    workerId,
    stopped: loop,
    stop: () => controller.abort(),
  }
}

const DRAIN_TIMEOUT = Symbol('drain-timeout')

async function runOneTask(
  orchestrator: ParallelMcpOrchestrator,
  workerId: string,
  handler: WorkerHandler,
  claim: ClaimTaskResult,
  signal: AbortSignal,
  heartbeatIntervalMs: number,
  drainTimeoutMs: number | undefined,
  onError?: (error: unknown, task: TaskRecord | null) => void,
): Promise<void> {
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
    } catch (error) {
      onError?.(error, task)
    }
  }
  heartbeatTimer = setInterval(() => {
    if (signal.aborted) return
    requestHeartbeat()
  }, heartbeatIntervalMs)

  const handlerPromise = Promise.resolve().then(async () => handler({
    task,
    lease,
    workerId,
    signal,
    heartbeat: requestHeartbeat,
  }))

  try {
    const racePromise: Promise<WorkerHandleResult | typeof DRAIN_TIMEOUT> = drainTimeoutMs !== undefined
      ? Promise.race([handlerPromise, drainWatchdog(signal, drainTimeoutMs)])
      : handlerPromise

    const result = await racePromise
    if (result === DRAIN_TIMEOUT) {
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
    applyResult(orchestrator, workerId, task, lease, result)
  } catch (error) {
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
