import {
  ParallelMcpOrchestrator,
  SqliteParallelMcpStore,
  type SqliteParallelMcpStoreOptions,
} from '@razroo/parallel-mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { registerOrchestratorTools } from './tools.js'

export interface ParallelMcpServerOptions {
  orchestrator?: ParallelMcpOrchestrator
  store?: SqliteParallelMcpStore
  storeOptions?: SqliteParallelMcpStoreOptions
  defaultLeaseMs?: number
  name?: string
  version?: string
}

export interface ParallelMcpServerHandle {
  server: McpServer
  orchestrator: ParallelMcpOrchestrator
  close: () => void
}

export function createParallelMcpServer(options: ParallelMcpServerOptions = {}): ParallelMcpServerHandle {
  const ownedStore = options.orchestrator === undefined && options.store === undefined
    ? new SqliteParallelMcpStore(options.storeOptions)
    : undefined
  const store = options.store ?? ownedStore
  const orchestrator = options.orchestrator
    ?? new ParallelMcpOrchestrator(store!, options.defaultLeaseMs !== undefined ? { defaultLeaseMs: options.defaultLeaseMs } : {})

  const server = new McpServer({
    name: options.name ?? '@razroo/parallel-mcp-server',
    version: options.version ?? '0.1.0',
  })

  registerOrchestratorTools(server, orchestrator)

  return {
    server,
    orchestrator,
    close: () => {
      if (options.orchestrator === undefined) {
        orchestrator.close()
      }
    },
  }
}

export { z }
