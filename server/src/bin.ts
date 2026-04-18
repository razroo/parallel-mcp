#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createParallelMcpServer } from './server.js'

async function main(): Promise<void> {
  const filename = process.env.PARALLEL_MCP_DB ?? ':memory:'
  const handle = createParallelMcpServer({
    storeOptions: { filename },
    name: '@razroo/parallel-mcp-server',
    version: '0.1.0',
  })

  const transport = new StdioServerTransport()

  const shutdown = async (): Promise<void> => {
    try {
      await handle.server.close()
    } catch {}
    handle.close()
    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown()
  })
  process.on('SIGTERM', () => {
    void shutdown()
  })

  await handle.server.connect(transport)
  process.stderr.write(
    `parallel-mcp-server connected (db=${filename}). Tools registered for run/task orchestration.\n`,
  )
}

void main().catch(error => {
  process.stderr.write(`parallel-mcp-server failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
