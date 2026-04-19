import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type {
  CreateRunOptions,
  EnqueueTaskOptions,
  ListDeadTasksOptions,
  ParallelMcpOrchestrator,
  RequeueDeadTaskOptions,
} from '@razroo/parallel-mcp'

type ToolHandlerResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  structuredContent?: Record<string, unknown>
}

function jsonResult(payload: unknown): ToolHandlerResult {
  const text = JSON.stringify(payload, null, 2)
  return {
    content: [{ type: 'text', text }],
    structuredContent: typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : { value: payload },
  }
}

function errorResult(error: unknown): ToolHandlerResult {
  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : 'Error'
  return {
    content: [{ type: 'text', text: `${name}: ${message}` }],
    isError: true,
  }
}

const jsonValueSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
)

const retryPolicySchema = z.object({
  delayMs: z.number().int().positive().optional(),
  backoff: z.enum(['fixed', 'exponential']).optional(),
  maxDelayMs: z.number().int().positive().optional(),
})

export function registerOrchestratorTools(server: McpServer, orchestrator: ParallelMcpOrchestrator): void {
  server.registerTool(
    'create_run',
    {
      title: 'Create run',
      description: 'Create a durable run that groups tasks. Optionally seeds an initial context snapshot.',
      inputSchema: {
        id: z.string().optional(),
        namespace: z.string().optional(),
        externalId: z.string().optional(),
        metadata: jsonValueSchema.optional(),
        context: jsonValueSchema.optional(),
      },
    },
    async input => {
      try {
        const options: CreateRunOptions = {}
        if (input.id !== undefined) options.id = input.id
        if (input.namespace !== undefined) options.namespace = input.namespace
        if (input.externalId !== undefined) options.externalId = input.externalId
        if (input.metadata !== undefined) options.metadata = input.metadata
        if (input.context !== undefined) options.context = input.context
        const run = orchestrator.createRun(options)
        return jsonResult({ run })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'enqueue_task',
    {
      title: 'Enqueue task',
      description:
        'Enqueue a task onto an existing run. Supports dependencies, priority, maxAttempts, retry policy, and an optional per-attempt timeoutMs wall-clock budget.',
      inputSchema: {
        id: z.string().optional(),
        runId: z.string(),
        key: z.string().optional(),
        kind: z.string(),
        priority: z.number().int().optional(),
        maxAttempts: z.number().int().positive().optional(),
        retry: retryPolicySchema.optional(),
        timeoutMs: z.number().int().positive().optional(),
        input: jsonValueSchema.optional(),
        metadata: jsonValueSchema.optional(),
        contextSnapshotId: z.string().optional(),
        dependsOnTaskIds: z.array(z.string()).optional(),
      },
    },
    async input => {
      try {
        const options: EnqueueTaskOptions = {
          runId: input.runId,
          kind: input.kind,
        }
        if (input.id !== undefined) options.id = input.id
        if (input.key !== undefined) options.key = input.key
        if (input.priority !== undefined) options.priority = input.priority
        if (input.maxAttempts !== undefined) options.maxAttempts = input.maxAttempts
        if (input.retry !== undefined) {
          const retry: NonNullable<EnqueueTaskOptions['retry']> = {}
          if (input.retry.delayMs !== undefined) retry.delayMs = input.retry.delayMs
          if (input.retry.backoff !== undefined) retry.backoff = input.retry.backoff
          if (input.retry.maxDelayMs !== undefined) retry.maxDelayMs = input.retry.maxDelayMs
          options.retry = retry
        }
        if (input.timeoutMs !== undefined) options.timeoutMs = input.timeoutMs
        if (input.input !== undefined) options.input = input.input
        if (input.metadata !== undefined) options.metadata = input.metadata
        if (input.contextSnapshotId !== undefined) options.contextSnapshotId = input.contextSnapshotId
        if (input.dependsOnTaskIds !== undefined) options.dependsOnTaskIds = input.dependsOnTaskIds
        const task = orchestrator.enqueueTask(options)
        return jsonResult({ task })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'claim_next_task',
    {
      title: 'Claim next task',
      description: 'Claim the next runnable task for a worker. Returns null if no task is currently runnable. Pass clientToken to make retries idempotent.',
      inputSchema: {
        workerId: z.string(),
        leaseMs: z.number().int().positive().optional(),
        kinds: z.array(z.string()).optional(),
        clientToken: z.string().optional(),
      },
    },
    async input => {
      try {
        const claim = orchestrator.claimNextTask({
          workerId: input.workerId,
          ...(input.leaseMs !== undefined ? { leaseMs: input.leaseMs } : {}),
          ...(input.kinds !== undefined ? { kinds: input.kinds } : {}),
          ...(input.clientToken !== undefined ? { clientToken: input.clientToken } : {}),
        })
        return jsonResult({ claim })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'heartbeat_lease',
    {
      title: 'Heartbeat lease',
      description: 'Extend the lease on a claimed task so it does not expire while work is in progress.',
      inputSchema: {
        taskId: z.string(),
        leaseId: z.string(),
        workerId: z.string(),
        leaseMs: z.number().int().positive().optional(),
      },
    },
    async input => {
      try {
        const lease = orchestrator.heartbeatLease({
          taskId: input.taskId,
          leaseId: input.leaseId,
          workerId: input.workerId,
          ...(input.leaseMs !== undefined ? { leaseMs: input.leaseMs } : {}),
        })
        return jsonResult({ lease })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'mark_task_running',
    {
      title: 'Mark task running',
      description: 'Transition a leased task into the running state.',
      inputSchema: {
        taskId: z.string(),
        leaseId: z.string(),
        workerId: z.string(),
      },
    },
    async input => {
      try {
        const task = orchestrator.markTaskRunning({
          taskId: input.taskId,
          leaseId: input.leaseId,
          workerId: input.workerId,
        })
        return jsonResult({ task })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'pause_task',
    {
      title: 'Pause task',
      description: 'Pause a running task as blocked or waiting_input. Releases the lease.',
      inputSchema: {
        taskId: z.string(),
        leaseId: z.string(),
        workerId: z.string(),
        status: z.enum(['blocked', 'waiting_input']),
        reason: z.string().optional(),
      },
    },
    async input => {
      try {
        const task = orchestrator.pauseTask({
          taskId: input.taskId,
          leaseId: input.leaseId,
          workerId: input.workerId,
          status: input.status,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        })
        return jsonResult({ task })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'resume_task',
    {
      title: 'Resume task',
      description: 'Return a paused task to the queued state so a worker can claim it.',
      inputSchema: {
        taskId: z.string(),
      },
    },
    async input => {
      try {
        const task = orchestrator.resumeTask({ taskId: input.taskId })
        return jsonResult({ task })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'complete_task',
    {
      title: 'Complete task',
      description: 'Mark a running task as completed. Optionally append a new run context snapshot. Pass clientToken to make retries idempotent.',
      inputSchema: {
        taskId: z.string(),
        leaseId: z.string(),
        workerId: z.string(),
        output: jsonValueSchema.optional(),
        metadata: jsonValueSchema.optional(),
        nextContext: jsonValueSchema.optional(),
        nextContextLabel: z.string().optional(),
        clientToken: z.string().optional(),
      },
    },
    async input => {
      try {
        const task = orchestrator.completeTask({
          taskId: input.taskId,
          leaseId: input.leaseId,
          workerId: input.workerId,
          ...(input.output !== undefined ? { output: input.output } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          ...(input.nextContext !== undefined ? { nextContext: input.nextContext } : {}),
          ...(input.nextContextLabel !== undefined ? { nextContextLabel: input.nextContextLabel } : {}),
          ...(input.clientToken !== undefined ? { clientToken: input.clientToken } : {}),
        })
        return jsonResult({ task })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'fail_task',
    {
      title: 'Fail task',
      description: 'Mark a running task as failed. This is terminal; retries happen via lease expiry, not failTask. Pass clientToken to make retries idempotent.',
      inputSchema: {
        taskId: z.string(),
        leaseId: z.string(),
        workerId: z.string(),
        error: z.string(),
        metadata: jsonValueSchema.optional(),
        clientToken: z.string().optional(),
      },
    },
    async input => {
      try {
        const task = orchestrator.failTask({
          taskId: input.taskId,
          leaseId: input.leaseId,
          workerId: input.workerId,
          error: input.error,
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          ...(input.clientToken !== undefined ? { clientToken: input.clientToken } : {}),
        })
        return jsonResult({ task })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'release_task',
    {
      title: 'Release task',
      description: 'Release a claimed task back to the queue without consuming an attempt.',
      inputSchema: {
        taskId: z.string(),
        leaseId: z.string(),
        workerId: z.string(),
        reason: z.string().optional(),
      },
    },
    async input => {
      try {
        const task = orchestrator.releaseTask({
          taskId: input.taskId,
          leaseId: input.leaseId,
          workerId: input.workerId,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        })
        return jsonResult({ task })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'cancel_run',
    {
      title: 'Cancel run',
      description: 'Cancel a run and all of its non-terminal tasks and active leases.',
      inputSchema: {
        runId: z.string(),
        reason: z.string().optional(),
      },
    },
    async input => {
      try {
        const run = orchestrator.cancelRun({
          runId: input.runId,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        })
        return jsonResult({ run })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'expire_leases',
    {
      title: 'Expire leases',
      description: 'Expire all active leases that have passed their deadline. Requeues or marks tasks failed per retry policy.',
      inputSchema: {
        now: z.string().optional(),
      },
    },
    async input => {
      try {
        const result = orchestrator.expireLeases(input.now)
        return jsonResult(result)
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'append_context_snapshot',
    {
      title: 'Append context snapshot',
      description: 'Append an explicit context snapshot for a run or a task.',
      inputSchema: {
        id: z.string().optional(),
        runId: z.string(),
        taskId: z.string().optional(),
        scope: z.enum(['run', 'task']).optional(),
        parentSnapshotId: z.string().optional(),
        label: z.string().optional(),
        payload: jsonValueSchema,
      },
    },
    async input => {
      try {
        const snapshot = orchestrator.appendContextSnapshot({
          runId: input.runId,
          payload: input.payload,
          ...(input.id !== undefined ? { id: input.id } : {}),
          ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
          ...(input.scope !== undefined ? { scope: input.scope } : {}),
          ...(input.parentSnapshotId !== undefined ? { parentSnapshotId: input.parentSnapshotId } : {}),
          ...(input.label !== undefined ? { label: input.label } : {}),
        })
        return jsonResult({ snapshot })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'get_run',
    {
      title: 'Get run',
      description: 'Fetch a run by id.',
      inputSchema: {
        runId: z.string(),
      },
    },
    async input => {
      try {
        const run = orchestrator.getRun(input.runId)
        return jsonResult({ run })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'get_task',
    {
      title: 'Get task',
      description: 'Fetch a task by id.',
      inputSchema: {
        taskId: z.string(),
      },
    },
    async input => {
      try {
        const task = orchestrator.getTask(input.taskId)
        return jsonResult({ task })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'list_run_tasks',
    {
      title: 'List run tasks',
      description: 'List all tasks in a run, ordered by priority and creation time.',
      inputSchema: {
        runId: z.string(),
      },
    },
    async input => {
      try {
        const tasks = orchestrator.listRunTasks(input.runId)
        return jsonResult({ tasks })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'list_run_events',
    {
      title: 'List run events',
      description: 'List the append-only event log for a run.',
      inputSchema: {
        runId: z.string(),
      },
    },
    async input => {
      try {
        const events = orchestrator.listRunEvents(input.runId)
        return jsonResult({ events })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'get_current_context_snapshot',
    {
      title: 'Get current context snapshot',
      description: 'Get the current context snapshot for a run.',
      inputSchema: {
        runId: z.string(),
      },
    },
    async input => {
      try {
        const snapshot = orchestrator.getCurrentContextSnapshot(input.runId)
        return jsonResult({ snapshot })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  const runStatusSchema = z.enum(['pending', 'active', 'waiting', 'completed', 'failed', 'cancelled'])

  server.registerTool(
    'list_runs',
    {
      title: 'List runs',
      description: 'List runs, optionally filtered by namespace, statuses, externalId, and updated-at range.',
      inputSchema: {
        namespace: z.string().optional(),
        statuses: z.array(runStatusSchema).optional(),
        externalId: z.string().optional(),
        updatedAfter: z.string().optional(),
        updatedBefore: z.string().optional(),
        limit: z.number().int().positive().max(1000).optional(),
        offset: z.number().int().nonnegative().optional(),
        orderBy: z.enum(['created_at', 'updated_at']).optional(),
        orderDir: z.enum(['asc', 'desc']).optional(),
      },
    },
    async input => {
      try {
        const runs = orchestrator.listRuns({
          ...(input.namespace !== undefined ? { namespace: input.namespace } : {}),
          ...(input.statuses !== undefined ? { statuses: input.statuses } : {}),
          ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
          ...(input.updatedAfter !== undefined ? { updatedAfter: input.updatedAfter } : {}),
          ...(input.updatedBefore !== undefined ? { updatedBefore: input.updatedBefore } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.offset !== undefined ? { offset: input.offset } : {}),
          ...(input.orderBy !== undefined ? { orderBy: input.orderBy } : {}),
          ...(input.orderDir !== undefined ? { orderDir: input.orderDir } : {}),
        })
        return jsonResult({ runs })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'list_pending_tasks',
    {
      title: 'List pending tasks',
      description: 'List queued tasks across runs, optionally filtered by runId, kinds, and readyBy cutoff.',
      inputSchema: {
        runId: z.string().optional(),
        kinds: z.array(z.string()).optional(),
        readyBy: z.string().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    async input => {
      try {
        const tasks = orchestrator.listPendingTasks({
          ...(input.runId !== undefined ? { runId: input.runId } : {}),
          ...(input.kinds !== undefined ? { kinds: input.kinds } : {}),
          ...(input.readyBy !== undefined ? { readyBy: input.readyBy } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        return jsonResult({ tasks })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'list_events_since',
    {
      title: 'List events since',
      description: 'Paginate the append-only event log. Returns events and a nextCursor to pass as afterId on the next call.',
      inputSchema: {
        afterId: z.number().int().nonnegative().optional(),
        runId: z.string().optional(),
        eventTypes: z.array(z.string()).optional(),
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    async input => {
      try {
        const result = orchestrator.listEventsSince({
          ...(input.afterId !== undefined ? { afterId: input.afterId } : {}),
          ...(input.runId !== undefined ? { runId: input.runId } : {}),
          ...(input.eventTypes !== undefined ? { eventTypes: input.eventTypes } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        return jsonResult(result)
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'prune_runs',
    {
      title: 'Prune runs',
      description: 'Hard-delete terminal runs older than the cutoff, cascading to tasks, leases, attempts, snapshots, and events.',
      inputSchema: {
        olderThan: z.string(),
        statuses: z.array(runStatusSchema).optional(),
        limit: z.number().int().positive().max(10_000).optional(),
      },
    },
    async input => {
      try {
        const result = orchestrator.pruneRuns({
          olderThan: input.olderThan,
          ...(input.statuses !== undefined ? { statuses: input.statuses } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        return jsonResult(result)
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'list_dead_tasks',
    {
      title: 'List dead tasks',
      description:
        'List tasks that have been moved to the dead-letter queue (attempt budget exhausted via lease expiry). Use requeue_dead_task to revive.',
      inputSchema: {
        runId: z.string().optional(),
        kinds: z.array(z.string()).optional(),
        limit: z.number().int().positive().max(1000).optional(),
        offset: z.number().int().nonnegative().optional(),
      },
    },
    async input => {
      try {
        const options: ListDeadTasksOptions = {}
        if (input.runId !== undefined) options.runId = input.runId
        if (input.kinds !== undefined) options.kinds = input.kinds
        if (input.limit !== undefined) options.limit = input.limit
        if (input.offset !== undefined) options.offset = input.offset
        const tasks = orchestrator.listDeadTasks(options)
        return jsonResult({ tasks })
      } catch (error) {
        return errorResult(error)
      }
    },
  )

  server.registerTool(
    'requeue_dead_task',
    {
      title: 'Requeue dead task',
      description:
        'Move a task out of the dead-letter queue back to the queue. Emits task.requeued_from_dlq. Resets attemptCount by default.',
      inputSchema: {
        taskId: z.string(),
        resetAttempts: z.boolean().optional(),
        notBefore: z.string().optional(),
        reason: z.string().optional(),
      },
    },
    async input => {
      try {
        const options: RequeueDeadTaskOptions = { taskId: input.taskId }
        if (input.resetAttempts !== undefined) options.resetAttempts = input.resetAttempts
        if (input.notBefore !== undefined) options.notBefore = input.notBefore
        if (input.reason !== undefined) options.reason = input.reason
        const task = orchestrator.requeueDeadTask(options)
        return jsonResult({ task })
      } catch (error) {
        return errorResult(error)
      }
    },
  )
}
