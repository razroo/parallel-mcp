import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { SqliteParallelMcpStore } from '@razroo/parallel-mcp'
import { createParallelMcpServer, type ParallelMcpServerHandle } from '../src/index.js'

interface ToolCallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
  structuredContent?: Record<string, unknown>
}

async function connectInMemoryPair(): Promise<{
  client: Client
  handle: ParallelMcpServerHandle
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  const store = new SqliteParallelMcpStore({ filename: ':memory:' })
  const handle = createParallelMcpServer({ store, defaultLeaseMs: 1_000 })

  const client = new Client({ name: 'test-client', version: '0.0.0' })

  await Promise.all([
    handle.server.connect(serverTransport),
    client.connect(clientTransport),
  ])

  return { client, handle }
}

function parseToolResult(result: ToolCallResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent
  const first = result.content[0]
  if (!first || first.type !== 'text' || first.text === undefined) return null
  return JSON.parse(first.text)
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = (await client.callTool({ name, arguments: args })) as ToolCallResult
  if (result.isError) {
    const first = result.content[0]
    throw new Error(first?.text ?? 'tool call failed')
  }
  return parseToolResult(result)
}

describe('parallel-mcp MCP server', () => {
  const handles: ParallelMcpServerHandle[] = []

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop()
      if (!handle) continue
      try {
        await handle.server.close()
      } catch {}
      handle.close()
    }
  })

  it('lists every orchestrator tool', async () => {
    const { client, handle } = await connectInMemoryPair()
    handles.push(handle)

    const { tools } = await client.listTools()
    const names = tools.map(tool => tool.name).sort()

    expect(names).toEqual(
      [
        'append_context_snapshot',
        'cancel_run',
        'claim_next_task',
        'complete_task',
        'create_run',
        'enqueue_task',
        'expire_leases',
        'fail_task',
        'get_current_context_snapshot',
        'get_run',
        'get_task',
        'heartbeat_lease',
        'list_dead_tasks',
        'list_events_since',
        'list_pending_tasks',
        'list_run_events',
        'list_run_tasks',
        'list_runs',
        'mark_task_running',
        'pause_task',
        'prune_runs',
        'release_task',
        'requeue_dead_task',
        'resume_task',
      ].sort(),
    )
  })

  it('runs an end-to-end create_run / enqueue / claim / complete flow over MCP', async () => {
    const { client, handle } = await connectInMemoryPair()
    handles.push(handle)

    const created = (await call(client, 'create_run', {
      namespace: 'mcp-test',
      context: { candidateId: 'c1' },
    })) as { run: { id: string; status: string } }
    expect(created.run.status).toBe('pending')
    const runId = created.run.id

    const parseTask = (await call(client, 'enqueue_task', {
      runId,
      kind: 'resume.parse',
      key: 'parse',
      input: { path: '/tmp/resume.pdf' },
    })) as { task: { id: string; status: string } }
    expect(parseTask.task.status).toBe('queued')

    await call(client, 'enqueue_task', {
      runId,
      kind: 'site.apply',
      key: 'apply',
      dependsOnTaskIds: [parseTask.task.id],
    })

    const claimed = (await call(client, 'claim_next_task', {
      workerId: 'worker-a',
    })) as {
      claim: { task: { id: string }; lease: { id: string; workerId: string } } | null
    }
    expect(claimed.claim?.task.id).toBe(parseTask.task.id)

    const running = (await call(client, 'mark_task_running', {
      taskId: claimed.claim!.task.id,
      leaseId: claimed.claim!.lease.id,
      workerId: claimed.claim!.lease.workerId,
    })) as { task: { status: string } }
    expect(running.task.status).toBe('running')

    const completed = (await call(client, 'complete_task', {
      taskId: claimed.claim!.task.id,
      leaseId: claimed.claim!.lease.id,
      workerId: claimed.claim!.lease.workerId,
      output: { parsed: true },
      nextContext: { candidateId: 'c1', parsedResumeId: 'r1' },
      nextContextLabel: 'resume.parse.completed',
    })) as { task: { status: string } }
    expect(completed.task.status).toBe('completed')

    const snapshot = (await call(client, 'get_current_context_snapshot', {
      runId,
    })) as { snapshot: { label: string; payload: { parsedResumeId: string } } }
    expect(snapshot.snapshot.label).toBe('resume.parse.completed')
    expect(snapshot.snapshot.payload.parsedResumeId).toBe('r1')

    const nextClaim = (await call(client, 'claim_next_task', { workerId: 'worker-b' })) as {
      claim: { task: { kind: string } } | null
    }
    expect(nextClaim.claim?.task.kind).toBe('site.apply')
  })

  it('exposes admin tools for listing runs, pending tasks, and paginated events', async () => {
    const { client, handle } = await connectInMemoryPair()
    handles.push(handle)

    const runA = (await call(client, 'create_run', { namespace: 'admin' })) as {
      run: { id: string }
    }
    const runB = (await call(client, 'create_run', { namespace: 'admin' })) as {
      run: { id: string }
    }
    await call(client, 'enqueue_task', { runId: runA.run.id, kind: 'x' })
    await call(client, 'enqueue_task', { runId: runB.run.id, kind: 'y' })

    const runs = (await call(client, 'list_runs', { namespace: 'admin' })) as {
      runs: Array<{ id: string }>
    }
    const runIds = new Set(runs.runs.map(r => r.id))
    expect(runIds.has(runA.run.id)).toBe(true)
    expect(runIds.has(runB.run.id)).toBe(true)

    const pending = (await call(client, 'list_pending_tasks', { kinds: ['x'] })) as {
      tasks: Array<{ kind: string }>
    }
    expect(pending.tasks.every(t => t.kind === 'x')).toBe(true)
    expect(pending.tasks).toHaveLength(1)

    const page1 = (await call(client, 'list_events_since', { limit: 2 })) as {
      events: Array<{ id: number }>
      nextCursor: number | null
    }
    expect(page1.events).toHaveLength(2)
    expect(page1.nextCursor).toBe(page1.events.at(-1)!.id)

    const page2 = (await call(client, 'list_events_since', {
      afterId: page1.nextCursor ?? 0,
      limit: 2,
    })) as { events: Array<{ id: number }> }
    for (const event of page2.events) {
      expect(event.id).toBeGreaterThan(page1.nextCursor!)
    }
  })

  it('makes complete_task idempotent when clientToken is supplied', async () => {
    const { client, handle } = await connectInMemoryPair()
    handles.push(handle)

    const run = (await call(client, 'create_run', { namespace: 'idem' })) as {
      run: { id: string }
    }
    const task = (await call(client, 'enqueue_task', {
      runId: run.run.id,
      kind: 'k',
    })) as { task: { id: string } }

    const claim = (await call(client, 'claim_next_task', {
      workerId: 'w',
      clientToken: 'claim-1',
    })) as {
      claim: { task: { id: string }; lease: { id: string; workerId: string } }
    }
    expect(claim.claim.task.id).toBe(task.task.id)

    const replay = (await call(client, 'claim_next_task', {
      workerId: 'w',
      clientToken: 'claim-1',
    })) as {
      claim: { task: { id: string }; lease: { id: string } }
    }
    expect(replay.claim.task.id).toBe(claim.claim.task.id)
    expect(replay.claim.lease.id).toBe(claim.claim.lease.id)

    const completeArgs = {
      taskId: task.task.id,
      leaseId: claim.claim.lease.id,
      workerId: claim.claim.lease.workerId,
      output: { ok: true },
      clientToken: 'complete-1',
    }
    const first = (await call(client, 'complete_task', completeArgs)) as {
      task: { status: string }
    }
    expect(first.task.status).toBe('completed')

    const second = (await call(client, 'complete_task', completeArgs)) as {
      task: { status: string }
    }
    expect(second.task.status).toBe('completed')
  })

  it('prune_runs hard-deletes terminal runs and surfaces the count', async () => {
    const { client, handle } = await connectInMemoryPair()
    handles.push(handle)

    const run = (await call(client, 'create_run', { namespace: 'prune' })) as {
      run: { id: string }
    }
    await call(client, 'enqueue_task', { runId: run.run.id, kind: 'k' })
    await call(client, 'cancel_run', { runId: run.run.id })

    const far = new Date(Date.now() + 60_000).toISOString()
    const result = (await call(client, 'prune_runs', {
      olderThan: far,
      statuses: ['cancelled'],
    })) as { count: number; prunedRunIds: string[] }
    expect(result.count).toBe(1)
    expect(result.prunedRunIds).toContain(run.run.id)

    const after = (await call(client, 'get_run', { runId: run.run.id })) as {
      run: unknown | null
    }
    expect(after.run).toBeNull()
  })

  it('enqueue_task round-trips timeoutMs onto the task record', async () => {
    const { client, handle } = await connectInMemoryPair()
    handles.push(handle)

    const run = (await call(client, 'create_run', { namespace: 'timeouts' })) as {
      run: { id: string }
    }

    const enqueued = (await call(client, 'enqueue_task', {
      runId: run.run.id,
      kind: 'work',
      timeoutMs: 2500,
    })) as { task: { id: string; timeoutMs: number | null } }

    expect(enqueued.task.timeoutMs).toBe(2500)

    const fetched = (await call(client, 'get_task', { taskId: enqueued.task.id })) as {
      task: { timeoutMs: number | null }
    }
    expect(fetched.task.timeoutMs).toBe(2500)
  })

  it('list_dead_tasks + requeue_dead_task round-trip via MCP', async () => {
    const { client, handle } = await connectInMemoryPair()
    handles.push(handle)

    const run = (await call(client, 'create_run', { namespace: 'dlq-mcp' })) as {
      run: { id: string }
    }

    const enqueued = (await call(client, 'enqueue_task', {
      runId: run.run.id,
      kind: 'work',
      maxAttempts: 1,
    })) as { task: { id: string } }

    await call(client, 'claim_next_task', {
      workerId: 'w1',
      leaseMs: 10,
    })

    await new Promise(resolve => setTimeout(resolve, 30))
    await call(client, 'expire_leases', {})

    const dead = (await call(client, 'list_dead_tasks', { runId: run.run.id })) as {
      tasks: Array<{ id: string; dead: boolean; status: string }>
    }
    expect(dead.tasks.map(t => t.id)).toEqual([enqueued.task.id])
    expect(dead.tasks[0]?.dead).toBe(true)
    expect(dead.tasks[0]?.status).toBe('failed')

    const requeued = (await call(client, 'requeue_dead_task', {
      taskId: enqueued.task.id,
      reason: 'operator replay',
    })) as { task: { id: string; status: string; dead: boolean; attemptCount: number } }
    expect(requeued.task.status).toBe('queued')
    expect(requeued.task.dead).toBe(false)
    expect(requeued.task.attemptCount).toBe(0)

    const stillDead = (await call(client, 'list_dead_tasks', { runId: run.run.id })) as {
      tasks: unknown[]
    }
    expect(stillDead.tasks).toEqual([])
  })

  it('surfaces typed errors from the core as MCP tool errors', async () => {
    const { client, handle } = await connectInMemoryPair()
    handles.push(handle)

    const run = (await call(client, 'create_run', { namespace: 'errors' })) as {
      run: { id: string }
    }

    await call(client, 'enqueue_task', {
      runId: run.run.id,
      kind: 'work',
      key: 'step-1',
    })

    const duplicate = (await client.callTool({
      name: 'enqueue_task',
      arguments: { runId: run.run.id, kind: 'work', key: 'step-1' },
    })) as ToolCallResult

    expect(duplicate.isError).toBe(true)
    const firstMsg = duplicate.content[0]
    expect(firstMsg?.text ?? '').toMatch(/DuplicateTaskKeyError/)
  })
})
