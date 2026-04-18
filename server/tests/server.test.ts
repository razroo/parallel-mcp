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
        'list_run_events',
        'list_run_tasks',
        'mark_task_running',
        'pause_task',
        'release_task',
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
