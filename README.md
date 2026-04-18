# @razroo/parallel-mcp

[![npm](https://img.shields.io/npm/v/@razroo/parallel-mcp.svg)](https://www.npmjs.com/package/@razroo/parallel-mcp)
[![license](https://img.shields.io/npm/l/@razroo/parallel-mcp.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@razroo/parallel-mcp.svg)](./package.json)

`@razroo/parallel-mcp` is a durable orchestration core for parallel MCP workloads.

It is not another MCP transport or browser automation server. The package exists to solve the failure mode where live sockets, warm caches, and implicit session defaults become the de facto source of truth for multi-job execution. In `parallel-mcp`, the source of truth is a SQLite database with explicit state transitions, leases, context snapshots, and an append-only event log.

## What it gives you

- Durable `runs` and `tasks`
- Dependency-aware task claiming for parallel workers
- Lease acquisition, heartbeat, release, and expiry
- Retry policies with `maxAttempts` enforcement and fixed/exponential backoff
- Explicit paused states: `blocked` and `waiting_input`
- Run-level context snapshots instead of implicit shared memory
- Append-only events for replay, debugging, and auditing
- Versioned schema migrations

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
npm install @razroo/parallel-mcp
```

Requires Node.js `>=22`. SQLite persistence is backed by [`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3).

## Quick start

```ts
import { ParallelMcpOrchestrator, SqliteParallelMcpStore } from '@razroo/parallel-mcp'

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

## Retry policy

`enqueueTask` accepts `maxAttempts` and an optional `retry` policy. The core only enforces the policy on lease expiry — `failTask` is always treated as a terminal decision by the worker, and `releaseTask` requeues without consuming an attempt.

```ts
orchestrator.enqueueTask({
  runId: run.id,
  kind: 'site.apply',
  maxAttempts: 5,
  retry: {
    delayMs: 1_000,
    backoff: 'exponential',
    maxDelayMs: 30_000,
  },
})
```

When a lease expires:

- `attempt_count >= maxAttempts` → task transitions to `failed` with `error = 'max_attempts_exceeded'`.
- Otherwise the task is requeued with `not_before = now + computedDelay`. `claimNextTask` will not return tasks whose `not_before` is in the future.

## Concurrency model

The SQLite store is built for **single-process, many-worker** deployments. Claims run inside a transaction with `busy_timeout` set (default 5000ms) and WAL mode enabled; that's sufficient when one Node process owns the database and claims tasks across concurrent async workers.

If you need **multiple processes** pointing at the same `parallel-mcp.db`, you should treat this as an adapter responsibility for now: run a single orchestrator process and expose claim/heartbeat/complete over your transport of choice. A future release will add a conditional-`UPDATE`-with-`RETURNING` claim path for multi-writer safety.

## API surface

`ParallelMcpOrchestrator` is a thin facade over `SqliteParallelMcpStore`. Both are exported, along with the full set of record and option types and error classes.

Runs:

- `createRun(options?)`
- `getRun(runId)`
- `cancelRun({ runId, reason?, now? })`

Tasks:

- `enqueueTask({ runId, kind, key?, priority?, maxAttempts?, input?, metadata?, dependsOnTaskIds?, ... })`
- `claimNextTask({ workerId, leaseMs?, kinds?, now? })`
- `markTaskRunning({ taskId, leaseId, workerId })`
- `pauseTask({ taskId, leaseId, workerId, status: 'blocked' | 'waiting_input', reason? })`
- `resumeTask({ taskId })`
- `completeTask({ taskId, leaseId, workerId, output?, metadata?, nextContext?, nextContextLabel? })`
- `failTask({ taskId, leaseId, workerId, error, metadata? })`
- `releaseTask({ taskId, leaseId, workerId, reason? })`
- `getTask(taskId)`
- `listRunTasks(runId)`

Leases:

- `heartbeatLease({ taskId, leaseId, workerId, leaseMs? })`
- `expireLeases(now?)` → `{ expiredTaskIds, count }`

Context and events:

- `appendContextSnapshot({ runId, payload, scope?, label?, taskId?, parentSnapshotId? })`
- `getCurrentContextSnapshot(runId)`
- `listRunEvents(runId)`

Errors (all extend `ParallelMcpError`):

- `RecordNotFoundError`
- `InvalidTransitionError`
- `LeaseConflictError`
- `LeaseExpiredError`
- `RunTerminalError`
- `DuplicateTaskKeyError`
- `MaxAttemptsExceededError`
- `DependencyCycleError`

## Suggested adapter boundary

Use the package like this:

1. An MCP server or worker claims a task from `@razroo/parallel-mcp`.
2. The worker launches its own isolated execution environment.
3. The worker heartbeats its lease while work is active.
4. If the worker needs user input, it pauses the task as `waiting_input`.
5. On success or failure, the worker writes terminal state back to the store.

If the worker dies, lease expiry re-queues the task. If a browser crashes, that is an adapter failure, not a state-authority failure.

## Current scope

This version ships:

- SQLite persistence with versioned migrations
- durable runs/tasks/attempts/leases/events
- dependency-aware claiming
- lease expiry and requeue
- `maxAttempts` enforcement with fixed / exponential backoff
- context snapshots

Next logical additions:

- multi-writer-safe claim path for multi-process deployments
- remote store backends
- worker polling / event subscription helpers

## MCP server adapter

If you want to drive this orchestrator from an MCP client (Cursor, Claude Desktop, etc.) instead of in-process, the companion package [`@razroo/parallel-mcp-server`](./server) exposes every public orchestrator method as an MCP tool over stdio.

```bash
npx @razroo/parallel-mcp-server
```

See [`server/README.md`](./server/README.md) for the full tool reference and embedding guide.

## Release

The repository includes a tag-driven GitHub Actions workflow at `.github/workflows/release.yml`.

- Push a semver tag like `v0.1.0`
- GitHub Actions runs typecheck, tests, build, and `npm pack`
- If the tag matches `package.json` version, the workflow publishes `@razroo/parallel-mcp` to npm and creates a GitHub release

Required repository secrets:

- `NPM_TOKEN`: npm automation token with publish access to the `@razroo` scope
