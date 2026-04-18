#!/usr/bin/env node
import { createParallelMcpHttpServer } from './http.js'

async function main(): Promise<void> {
  const filename = process.env.PARALLEL_MCP_DB ?? ':memory:'
  const portEnv = process.env.PARALLEL_MCP_PORT
  const port = portEnv !== undefined ? Number.parseInt(portEnv, 10) : 3333
  if (Number.isNaN(port)) {
    throw new Error(`PARALLEL_MCP_PORT is not a valid integer: ${portEnv}`)
  }
  const host = process.env.PARALLEL_MCP_HOST ?? '127.0.0.1'
  const path = process.env.PARALLEL_MCP_PATH ?? '/mcp'
  const authToken = process.env.PARALLEL_MCP_TOKEN

  const handle = createParallelMcpHttpServer({
    storeOptions: { filename },
    port,
    host,
    path,
    name: '@razroo/parallel-mcp-server',
    version: '0.1.0',
    ...(authToken ? { authToken } : {}),
  })

  const info = await handle.listen()
  process.stderr.write(
    `parallel-mcp-server (http) listening on ${info.url} (db=${filename}${authToken ? ', auth=bearer' : ''})\n`,
  )

  const shutdown = async (): Promise<void> => {
    try {
      await handle.close()
    } finally {
      process.exit(0)
    }
  }

  process.on('SIGINT', () => {
    void shutdown()
  })
  process.on('SIGTERM', () => {
    void shutdown()
  })
}

void main().catch(error => {
  process.stderr.write(
    `parallel-mcp-server (http) failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  )
  process.exit(1)
})
