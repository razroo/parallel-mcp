import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SqliteParallelMcpStore } from '@razroo/parallel-mcp'
import {
  createParallelMcpHttpServer,
  type ParallelMcpHttpServerHandle,
} from '../src/index.js'

interface ToolCallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
  structuredContent?: Record<string, unknown>
}

async function boot(options: Parameters<typeof createParallelMcpHttpServer>[0] = {}): Promise<{
  handle: ParallelMcpHttpServerHandle
  url: string
}> {
  const store = new SqliteParallelMcpStore({ filename: ':memory:' })
  const handle = createParallelMcpHttpServer({
    store,
    defaultLeaseMs: 1_000,
    port: 0,
    ...options,
  })
  const info = await handle.listen()
  return { handle, url: info.url }
}

describe('parallel-mcp http server', () => {
  const handles: ParallelMcpHttpServerHandle[] = []

  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop()
      if (handle) {
        await handle.close()
      }
    }
  })

  it('serves the MCP tool surface over Streamable HTTP', async () => {
    const { handle, url } = await boot()
    handles.push(handle)

    const client = new Client({ name: 'http-test-client', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(url))
    await client.connect(transport)

    const { tools } = await client.listTools()
    const names = tools.map(tool => tool.name)
    expect(names).toContain('create_run')
    expect(names).toContain('enqueue_task')
    expect(names).toContain('claim_next_task')

    const created = (await client.callTool({
      name: 'create_run',
      arguments: { namespace: 'http' },
    })) as ToolCallResult
    const text = created.content[0]?.text ?? ''
    const parsed = JSON.parse(text) as { run: { id: string; namespace: string } }
    expect(parsed.run.namespace).toBe('http')

    await client.close()
  })

  it('rejects requests that miss the required bearer token', async () => {
    const { handle, url } = await boot({ authToken: 'secret' })
    handles.push(handle)

    const unauthorizedRes = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(unauthorizedRes.status).toBe(401)

    const authorizedRes = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer secret',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'curl-test', version: '0.0.0' },
        },
      }),
    })
    expect(authorizedRes.status).toBe(200)
  })

  it('returns 405 for GET and DELETE on the MCP path', async () => {
    const { handle, url } = await boot()
    handles.push(handle)

    const get = await fetch(url, { method: 'GET' })
    expect(get.status).toBe(405)

    const del = await fetch(url, { method: 'DELETE' })
    expect(del.status).toBe(405)
  })
})
