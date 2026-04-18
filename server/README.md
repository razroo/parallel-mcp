# @razroo/parallel-mcp-server

[![npm](https://img.shields.io/npm/v/@razroo/parallel-mcp-server.svg)](https://www.npmjs.com/package/@razroo/parallel-mcp-server)
[![license](https://img.shields.io/npm/l/@razroo/parallel-mcp-server.svg)](../LICENSE)
[![node](https://img.shields.io/node/v/@razroo/parallel-mcp-server.svg)](./package.json)

`@razroo/parallel-mcp-server` is a thin [Model Context Protocol](https://modelcontextprotocol.io) server on top of [`@razroo/parallel-mcp`](https://www.npmjs.com/package/@razroo/parallel-mcp). It exposes the durable-orchestration core — runs, tasks, leases, context snapshots, the event log — as MCP tools that an agent can call over stdio.

If `@razroo/parallel-mcp` is the "engine", this package is the "steering column" that lets an MCP client drive it.

## What it gives you

- One MCP tool per public orchestrator method
- A ready-to-run `parallel-mcp-server` stdio binary
- A `createParallelMcpServer(...)` factory for embedding the server in your own process
- Typed errors from the core bubble up as MCP `isError` tool results with the original error name preserved

## Install

```bash
npm install @razroo/parallel-mcp-server
```

Requires Node.js `>=22`. Pulls in `@razroo/parallel-mcp` and `@modelcontextprotocol/sdk`.

## Run as a stdio server

The package ships a binary that opens a SQLite store and speaks MCP over stdio:

```bash
# in-memory store, lost when the process exits
npx parallel-mcp-server

# durable SQLite file
PARALLEL_MCP_DB=./parallel-mcp.db npx parallel-mcp-server
```

Point your MCP client (Cursor, Claude Desktop, etc.) at that binary. For example in a Cursor MCP config:

```json
{
  "mcpServers": {
    "parallel-mcp": {
      "command": "npx",
      "args": ["-y", "@razroo/parallel-mcp-server"],
      "env": {
        "PARALLEL_MCP_DB": "/absolute/path/to/parallel-mcp.db"
      }
    }
  }
}
```

## Embed in your own server

```ts
import { createParallelMcpServer } from '@razroo/parallel-mcp-server'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const handle = createParallelMcpServer({
  storeOptions: { filename: './parallel-mcp.db' },
  defaultLeaseMs: 30_000,
})

await handle.server.connect(new StdioServerTransport())
```

You can also pass in an existing `SqliteParallelMcpStore` or `ParallelMcpOrchestrator` — useful if you want to share one store between an HTTP surface and the MCP surface.

## Tool reference

All tools accept JSON objects and return JSON-encoded orchestrator records. Errors from the core (`DuplicateTaskKeyError`, `RunTerminalError`, `LeaseConflictError`, `LeaseExpiredError`, `MaxAttemptsExceededError`, etc.) are surfaced as MCP error results with the error name in the message.

Runs:

- `create_run` — `{ id?, namespace?, externalId?, metadata?, context? }`
- `get_run` — `{ runId }`
- `cancel_run` — `{ runId, reason? }`
- `list_run_tasks` — `{ runId }`
- `list_run_events` — `{ runId }`

Tasks:

- `enqueue_task` — `{ runId, kind, key?, priority?, maxAttempts?, retry?, input?, metadata?, contextSnapshotId?, dependsOnTaskIds? }`
- `claim_next_task` — `{ workerId, leaseMs?, kinds? }`
- `mark_task_running` — `{ taskId, leaseId, workerId }`
- `pause_task` — `{ taskId, leaseId, workerId, status: 'blocked' | 'waiting_input', reason? }`
- `resume_task` — `{ taskId }`
- `complete_task` — `{ taskId, leaseId, workerId, output?, metadata?, nextContext?, nextContextLabel? }`
- `fail_task` — `{ taskId, leaseId, workerId, error, metadata? }`
- `release_task` — `{ taskId, leaseId, workerId, reason? }`
- `get_task` — `{ taskId }`

Leases:

- `heartbeat_lease` — `{ taskId, leaseId, workerId, leaseMs? }`
- `expire_leases` — `{ now? }` → `{ expiredTaskIds, count }`

Context:

- `append_context_snapshot` — `{ runId, payload, scope?, label?, taskId?, parentSnapshotId?, id? }`
- `get_current_context_snapshot` — `{ runId }`

## Scope

This package is deliberately a thin adapter. It is not an agent, a planner, or a scheduler. The assumed topology is:

1. Your agent (an MCP client) calls these tools to enqueue work and claim tasks.
2. Actual worker processes can either be other MCP clients calling `claim_next_task` / `complete_task` / `fail_task`, or they can consume `@razroo/parallel-mcp` directly in-process.
3. The MCP surface and the in-process surface agree because they are the same orchestrator.

## License

MIT, same as `@razroo/parallel-mcp`.
