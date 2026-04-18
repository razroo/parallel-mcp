import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ParallelMcpOrchestrator, SqliteParallelMcpStore, type SqliteParallelMcpStoreOptions } from '@razroo/parallel-mcp'
import { registerOrchestratorTools } from './tools.js'

export interface ParallelMcpHttpServerOptions {
  orchestrator?: ParallelMcpOrchestrator
  store?: SqliteParallelMcpStore
  storeOptions?: SqliteParallelMcpStoreOptions
  defaultLeaseMs?: number
  port?: number
  host?: string
  path?: string
  name?: string
  version?: string
  mode?: 'stateless' | 'stateful'
  authToken?: string
}

export interface ParallelMcpHttpServerHandle {
  orchestrator: ParallelMcpOrchestrator
  httpServer: Server
  listen: () => Promise<{ host: string; port: number; url: string }>
  close: () => Promise<void>
}

interface Resolved {
  orchestrator: ParallelMcpOrchestrator
  ownsOrchestrator: boolean
  serverName: string
  serverVersion: string
  path: string
  host: string
  port: number
  mode: 'stateless' | 'stateful'
  authToken: string | undefined
}

function resolveOptions(options: ParallelMcpHttpServerOptions): Resolved {
  const ownedStore = options.orchestrator === undefined && options.store === undefined
    ? new SqliteParallelMcpStore(options.storeOptions)
    : undefined
  const store = options.store ?? ownedStore
  const orchestrator = options.orchestrator
    ?? new ParallelMcpOrchestrator(store!, options.defaultLeaseMs !== undefined ? { defaultLeaseMs: options.defaultLeaseMs } : {})

  return {
    orchestrator,
    ownsOrchestrator: options.orchestrator === undefined,
    serverName: options.name ?? '@razroo/parallel-mcp-server',
    serverVersion: options.version ?? '0.1.0',
    path: options.path ?? '/mcp',
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 0,
    mode: options.mode ?? 'stateless',
    authToken: options.authToken,
  }
}

function methodNotAllowed(res: ServerResponse): void {
  res.writeHead(405, { 'content-type': 'application/json' }).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    }),
  )
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, { 'content-type': 'application/json' }).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized.' },
      id: null,
    }),
  )
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST') return undefined
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return undefined
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function checkAuth(req: IncomingMessage, authToken: string | undefined): boolean {
  if (!authToken) return true
  const header = req.headers.authorization
  if (!header || typeof header !== 'string') return false
  return header === `Bearer ${authToken}`
}

export function createParallelMcpHttpServer(options: ParallelMcpHttpServerOptions = {}): ParallelMcpHttpServerHandle {
  const resolved = resolveOptions(options)

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (url.pathname !== resolved.path) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32004, message: 'Not found.' },
          id: null,
        }),
      )
      return
    }

    if (!checkAuth(req, resolved.authToken)) {
      unauthorized(res)
      return
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      methodNotAllowed(res)
      return
    }

    if (req.method !== 'POST') {
      methodNotAllowed(res)
      return
    }

    const body = await readJsonBody(req)

    const mcp = new McpServer({
      name: resolved.serverName,
      version: resolved.serverVersion,
    })
    registerOrchestratorTools(mcp, resolved.orchestrator)

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: resolved.mode === 'stateful' ? () => crypto.randomUUID() : undefined,
    })

    try {
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : 'Internal server error',
            },
            id: null,
          }),
        )
      }
    }

    res.on('close', () => {
      void transport.close()
      void mcp.close()
    })
  })

  const listen = async (): Promise<{ host: string; port: number; url: string }> => {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        httpServer.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        httpServer.off('error', onError)
        resolve()
      }
      httpServer.once('error', onError)
      httpServer.once('listening', onListening)
      httpServer.listen(resolved.port, resolved.host)
    })
    const address = httpServer.address()
    if (!address || typeof address === 'string') {
      throw new Error('HTTP server did not bind to a network address')
    }
    return {
      host: address.address,
      port: address.port,
      url: `http://${address.address}:${address.port}${resolved.path}`,
    }
  }

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close(error => {
        if (error) reject(error)
        else resolve()
      })
    })
    if (resolved.ownsOrchestrator) {
      resolved.orchestrator.close()
    }
  }

  return {
    orchestrator: resolved.orchestrator,
    httpServer,
    listen,
    close,
  }
}
