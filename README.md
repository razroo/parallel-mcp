# parallel-mcp

`parallel-mcp` is a durable orchestration core for parallel MCP workloads.

It is not another MCP transport or browser automation server. The package exists to solve the failure mode where live sockets, warm caches, and implicit session defaults become the de facto source of truth for multi-job execution. In `parallel-mcp`, the source of truth is a SQLite database with explicit state transitions, leases, context snapshots, and an append-only event log.

## What it gives you

- Durable `runs` and `tasks`
- Dependency-aware task claiming for parallel workers
- Lease acquisition, heartbeat, release, and expiry
- Explicit paused states: `blocked` and `waiting_input`
- Run-level context snapshots instead of implicit shared memory
- Append-only events for replay, debugging, and auditing

## What it does not do

- It does not speak MCP over stdio, HTTP, SSE, or WebSocket
- It does not manage browsers or proxy tabs
- It does not decide how you execute a task once a worker claims it

That boundary is deliberate: MCP servers, browsers, queues, and workers are adapters around this library, not the authority.

## State model

Run states:

- `pending`
- `active`
- `waiting`
- `completed`
- `failed`
- `cancelled`

Task states:

- `queued`
- `leased`
- `running`
- `blocked`
- `waiting_input`
- `completed`
- `failed`
- `cancelled`

## Install

```bash
npm install parallel-mcp better-sqlite3
```

## Quick start

```ts
import { ParallelMcpOrchestrator, SqliteParallelMcpStore } from 'parallel-mcp'

const store = new SqliteParallelMcpStore({ filename: './parallel-mcp.db' })
const orchestrator = new ParallelMcpOrchestrator(store, { defaultLeaseMs: 60_000 })

const run = orchestrator.createRun({
  namespace: 'job-apply',
  externalId: 'candidate-42',
  context: {
    candidateId: 'candidate-42',
    browserProfile: null,
  },
})

const parseResume = orchestrator.enqueueTask({
  runId: run.id,
  kind: 'resume.parse',
  key: 'resume.parse',
  input: { path: '/tmp/resume.pdf' },
})

orchestrator.enqueueTask({
  runId: run.id,
  kind: 'site.apply',
  key: 'site.apply',
  dependsOnTaskIds: [parseResume.id],
  input: { url: 'https://jobs.example.com/roles/123' },
})

const claimed = orchestrator.claimNextTask({ workerId: 'worker-a' })
if (!claimed) {
  throw new Error('No runnable task was available')
}

orchestrator.markTaskRunning({
  taskId: claimed.task.id,
  leaseId: claimed.lease.id,
  workerId: claimed.lease.workerId,
})

orchestrator.completeTask({
  taskId: claimed.task.id,
  leaseId: claimed.lease.id,
  workerId: claimed.lease.workerId,
  output: { parsed: true },
  nextContext: {
    candidateId: 'candidate-42',
    browserProfile: null,
    parsedResumeId: 'resume-123',
  },
  nextContextLabel: 'resume.parse.completed',
})
```

## Suggested adapter boundary

Use the package like this:

1. An MCP server or worker claims a task from `parallel-mcp`.
2. The worker launches its own isolated execution environment.
3. The worker heartbeats its lease while work is active.
4. If the worker needs user input, it pauses the task as `waiting_input`.
5. On success or failure, the worker writes terminal state back to the store.

If the worker dies, lease expiry re-queues the task. If a browser crashes, that is an adapter failure, not a state-authority failure.

## Current scope

This first version ships:

- SQLite persistence
- durable runs/tasks/attempts/leases/events
- dependency-aware claiming
- lease expiry and requeue
- context snapshots

Next logical additions:

- retry policies
- remote store backends
- advisory sharding and worker polling helpers
- MCP adapter package on top of this core
