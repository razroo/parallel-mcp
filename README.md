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
- Per-attempt `timeoutMs` wall-clock budget with `AbortSignal`-driven handler cancellation
- Dead-letter queue for tasks that exhaust `maxAttempts` — triage with `listDeadTasks` / `requeueDeadTask`
- Explicit paused states: `blocked` and `waiting_input`
- Run-level context snapshots instead of implicit shared memory
- Append-only events for replay, debugging, and auditing
- Versioned schema migrations
- Dual sync (`ParallelMcpStore`) and async (`AsyncParallelMcpStore`) store contracts — pick the one that matches your backend

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

Requires Node.js `>=22`. SQLite persistence is backed by [`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3). The core is tested against `better-sqlite3` `^11 || ^12` — see [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) for the compat matrix.

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

- `attempt_count >= maxAttempts` → task transitions to `failed` with `error = 'max_attempts_exceeded'` and is moved to the **dead-letter queue** (`dead = true`). It will not be handed to workers again until an operator requeues it.
- Otherwise the task is requeued with `not_before = now + computedDelay`. `claimNextTask` will not return tasks whose `not_before` is in the future.

### Per-attempt `timeoutMs`

`enqueueTask({ timeoutMs })` sets a hard wall-clock budget for a single attempt. The worker (`runWorker`) aborts the handler's `AbortSignal` after `timeoutMs` elapses and records a timeout-fail outcome — the task then retries normally, respecting `maxAttempts` and retry backoff. `timeoutMs` is independent of `leaseMs`, which is purely a crash-detection signal.

```ts
orchestrator.enqueueTask({
  runId: run.id,
  kind: 'site.apply',
  timeoutMs: 60_000,
  maxAttempts: 3,
  retry: { delayMs: 5_000, backoff: 'exponential' },
})
```

### Dead-letter queue

Tasks that exhaust their attempt budget via lease expiry are parked in the dead-letter queue instead of silently dropped. Two orchestrator methods drive the triage loop:

```ts
const dead = orchestrator.listDeadTasks({ runId, kinds: ['site.apply'] })

for (const task of dead) {
  console.log(task.id, task.error, task.attemptCount)
  orchestrator.requeueDeadTask({ taskId: task.id, reason: 'operator replay' })
}
```

`requeueDeadTask` resets `attemptCount` to `0` by default (pass `resetAttempts: false` to preserve it) and emits a `task.requeued_from_dlq` event so the replay is auditable. The original dead-lettering emits `task.dead_lettered`.

## Worker loop

The package ships a `runWorker` helper so callers don't have to hand-roll the claim / heartbeat / complete loop.

```ts
import { ParallelMcpOrchestrator, SqliteParallelMcpStore, runWorker } from '@razroo/parallel-mcp'

const orchestrator = new ParallelMcpOrchestrator(new SqliteParallelMcpStore({ filename: './parallel-mcp.db' }))

const worker = runWorker({
  orchestrator,
  workerId: 'worker-1',
  kinds: ['site.apply'],
  leaseMs: 30_000,
  handler: async ({ task, heartbeat, signal }) => {
    heartbeat()
    const result = await doTheWork(task.input, { signal })
    return { status: 'completed', output: result }
  },
})

process.on('SIGTERM', () => worker.stop())
await worker.stopped
```

Handler return values map 1:1 to orchestrator state transitions:

- `{ status: 'completed', output?, metadata?, nextContext?, nextContextLabel? }` → `completeTask`
- `{ status: 'failed', error, metadata? }` → `failTask` (terminal; retries happen via lease expiry, not `failTask`)
- `{ status: 'paused', pauseAs: 'blocked' | 'waiting_input', reason? }` → `pauseTask`
- `{ status: 'released', reason? }` → `releaseTask` (requeues without consuming an attempt)

If the handler throws, the task is failed with the error message. An `onError` option is available for observability.

## Async store and orchestrator

The default `ParallelMcpOrchestrator` + `SqliteParallelMcpStore` pair is synchronous because `better-sqlite3` is synchronous. For backends that are truly async (Postgres, a remote service, a queue) the package ships a parallel `AsyncParallelMcpStore` contract and an `AsyncParallelMcpOrchestrator` facade with 1:1 feature parity:

```ts
import { AsyncParallelMcpOrchestrator } from '@razroo/parallel-mcp'
import { PostgresParallelMcpStore } from '@razroo/parallel-mcp-postgres'
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const store = new PostgresParallelMcpStore({ pool, autoMigrate: true })
await store.migrate()

const orchestrator = new AsyncParallelMcpOrchestrator(store, { defaultLeaseMs: 30_000 })

for (;;) {
  const claim = await orchestrator.claimNextTask({ workerId: 'worker-1' })
  if (!claim) {
    await new Promise(r => setTimeout(r, 200))
    continue
  }
  await orchestrator.markTaskRunning({
    taskId: claim.task.id,
    leaseId: claim.lease.id,
    workerId: claim.lease.workerId,
  })
  try {
    const output = await doTheWork(claim.task.input)
    await orchestrator.completeTask({
      taskId: claim.task.id,
      leaseId: claim.lease.id,
      workerId: claim.lease.workerId,
      output,
    })
  } catch (error) {
    await orchestrator.failTask({
      taskId: claim.task.id,
      leaseId: claim.lease.id,
      workerId: claim.lease.workerId,
      error: (error as Error).message,
    })
  }
}
```

`runWorker` (the packaged helper that owns claim / heartbeat / drain / timeout) is currently sync-only — it drives `ParallelMcpOrchestrator`. Driving `AsyncParallelMcpOrchestrator` means hand-rolling the loop, as above, or using the `toAsyncStore` escape hatch when the backing store is sync. A first-class `runAsyncWorker` is on the roadmap for a follow-up release.

Two first-party adapters live in this repo:

- [`@razroo/parallel-mcp-memory`](./adapters/memory/) — a tiny, non-durable, dependency-free reference implementation. Great for tests, demos, and adapter-author onboarding. Passes the full async conformance suite.
- [`@razroo/parallel-mcp-postgres`](./adapters/postgres/) — a complete `AsyncParallelMcpStore` on `pg`, using `SELECT ... FOR UPDATE SKIP LOCKED` for atomic claims and real `BEGIN/COMMIT` transactions. Runs the live conformance suite in CI.

If you need to expose an existing `ParallelMcpStore` (e.g. `SqliteParallelMcpStore`) through the async API, wrap it with `toAsyncStore(sync)`. See [`docs/authoring-adapters.md`](./docs/authoring-adapters.md) for the full adapter-author guide, including the transaction-isolation caveat of `toAsyncStore`.

## Concurrency model

The SQLite store is built for single-process, many-worker deployments and is safe to open concurrently from multiple processes pointing at the same database file:

- `journal_mode = WAL` and `busy_timeout` (default 5000ms) on every connection.
- `claimNextTask` runs inside a `BEGIN IMMEDIATE` transaction, so every candidate `SELECT` is serialized with writers.
- The actual transition to `leased` is a conditional `UPDATE ... WHERE status = 'queued' AND lease_id IS NULL`, and the caller double-checks the affected row count. Two concurrent orchestrators racing for the same task will only ever succeed once; the loser returns `null` and polls again.
- `claimNextTask` also accepts an optional `clientToken`. If a lease with that token already exists, the same `{ task, attempt, lease }` is returned instead of claiming a second task. That keeps MCP tool calls retry-safe across flaky transports.

## Idempotency

`completeTask` and `failTask` both accept an optional `clientToken`. The first successful call writes a row to `task_completions`; subsequent calls with the same token return the existing task record instead of re-applying the transition. Reusing a token for a different task, or a different outcome, throws — that's a caller bug, not a retry.

```ts
orchestrator.completeTask({
  taskId: task.id,
  leaseId: claim.lease.id,
  workerId: 'worker-1',
  output: { ok: true },
  clientToken: 'apply-candidate-42-attempt-1',
})
```

## Observability

`ParallelMcpOrchestrator` accepts an `onEvent` hook that is called synchronously after every durable event is written to the `events` table. Listener errors are swallowed so they can't corrupt the commit path.

```ts
const orchestrator = new ParallelMcpOrchestrator(store, {
  defaultLeaseMs: 60_000,
  onEvent: event => {
    metrics.increment(`parallel_mcp.${event.eventType}`, { runId: event.runId })
  },
})
```

## Examples

The `examples/` directory contains runnable demos that exercise the full surface end-to-end.

```bash
npm run example:fan-out
```

`examples/fan-out.ts` spins up three concurrent `runWorker` loops against an in-memory store, fans out a batch of `fetch` tasks with retry policy, and prints the `onEvent` stream as they flow to a terminal run state. See [`examples/README.md`](./examples/README.md).

## API surface

`ParallelMcpOrchestrator` is a thin facade over `SqliteParallelMcpStore`. `AsyncParallelMcpOrchestrator` is its async twin over any `AsyncParallelMcpStore`. Both are exported, along with the full set of record and option types and error classes. Every method below exists on both orchestrators with the same signature — the async version returns `Promise<T>`.

Runs:

- `createRun(options?)`
- `getRun(runId)`
- `cancelRun({ runId, reason?, now? })`

Tasks:

- `enqueueTask({ runId, kind, key?, priority?, maxAttempts?, retry?, timeoutMs?, input?, metadata?, dependsOnTaskIds?, ... })`
- `claimNextTask({ workerId, leaseMs?, kinds?, clientToken?, now? })`
- `markTaskRunning({ taskId, leaseId, workerId })`
- `pauseTask({ taskId, leaseId, workerId, status: 'blocked' | 'waiting_input', reason? })`
- `resumeTask({ taskId })`
- `completeTask({ taskId, leaseId, workerId, output?, metadata?, nextContext?, nextContextLabel?, clientToken? })`
- `failTask({ taskId, leaseId, workerId, error, metadata?, clientToken? })`
- `releaseTask({ taskId, leaseId, workerId, reason? })`
- `getTask(taskId)`
- `listRunTasks(runId)`

Dead-letter queue:

- `listDeadTasks({ runId?, kinds?, limit?, offset? })` — tasks parked after exhausting `maxAttempts`
- `requeueDeadTask({ taskId, resetAttempts?, notBefore?, reason? })` — emits `task.requeued_from_dlq`

Leases:

- `heartbeatLease({ taskId, leaseId, workerId, leaseMs? })`
- `expireLeases(now?)` → `{ expiredTaskIds, count }`

Context and events:

- `appendContextSnapshot({ runId, payload, scope?, label?, taskId?, parentSnapshotId? })`
- `getCurrentContextSnapshot(runId)`
- `listRunEvents(runId)`
- `listEventsSince({ afterId?, runId?, eventTypes?, limit? })` → `{ events, nextCursor }` for paginated / resumable event consumption

Introspection and retention:

- `listRuns({ namespace?, statuses?, externalId?, updatedAfter?, updatedBefore?, limit?, offset?, orderBy?, orderDir? })`
- `listPendingTasks({ runId?, kinds?, readyBy?, limit? })`
- `pruneRuns({ olderThan, statuses?, limit? })` → hard-deletes terminal runs and cascades to tasks, leases, attempts, snapshots, and events

Transactions:

- `transaction(fn)` runs `fn` inside an `IMMEDIATE` SQLite transaction (sync) or a real `BEGIN/COMMIT` (async native stores) so multiple writes commit or roll back as one unit. `toAsyncStore` can only isolate synchronous bodies — see [`docs/authoring-adapters.md`](./docs/authoring-adapters.md#bridging-a-sync-store-into-the-async-world).

Workers:

- `runWorker({ orchestrator, workerId, handler, kinds?, leaseMs?, heartbeatIntervalMs?, pollIntervalMs?, idleBackoffMs?, idleMaxBackoffMs?, drainTimeoutMs?, signal?, onError?, expireLeasesOnPoll?, installSignalHandlers? })` → `{ stop(), stopped, workerId }`
- `scheduleExpireLeases({ orchestrator, intervalMs, signal?, onTick?, onError?, installSignalHandlers?, runImmediately? })` → `{ stop(), stopped }` — standalone maintenance loop that calls `expireLeases()` on a timer.

When `drainTimeoutMs` is set, calling `stop()` while a handler is still running gives the handler that long to finish. If it does not, `runWorker` calls `releaseTask` so the task returns to `queued` and another worker can pick it up. The stored handler promise is still awaited in the background so its side effects can unwind cleanly.

Pass `installSignalHandlers: true` to `runWorker` or `scheduleExpireLeases` when the loop owns the process — it attaches `SIGINT` / `SIGTERM` handlers that call `stop()` once and removes them on exit.

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

- SQLite persistence with versioned migrations (sync)
- Native async `AsyncParallelMcpStore` / `AsyncParallelMcpOrchestrator` for Postgres and custom async backends
- In-memory async reference adapter (`@razroo/parallel-mcp-memory`)
- Full `AsyncParallelMcpStore` implementation on top of `pg` (`@razroo/parallel-mcp-postgres`, beta)
- durable runs/tasks/attempts/leases/events
- dependency-aware claiming
- lease expiry and requeue
- `maxAttempts` enforcement with fixed / exponential backoff
- per-attempt `timeoutMs` with `AbortSignal` cancellation inside `runWorker`
- dead-letter queue + triage (`listDeadTasks` / `requeueDeadTask`)
- context snapshots
- MCP server adapter exposing every public method as an MCP tool

Next logical additions:

- richer event subscription (push stream) in addition to the synchronous `onEvent` hook and the `listEventsSince` cursor
- async variant of the MCP server so remote async stores can be driven over stdio without bridging through `toAsyncStore`

See also:

- [`docs/lifecycle.md`](./docs/lifecycle.md) — task / run state machine and event types
- [`docs/failure-modes.md`](./docs/failure-modes.md) — typed errors and how to handle each failure
- [`docs/authoring-adapters.md`](./docs/authoring-adapters.md) — writing a sync or async adapter and running the conformance suite
- [`testkit/`](./testkit) — `@razroo/parallel-mcp-testkit`, drop-in Vitest conformance suites (sync + async) for alternative adapter implementations
- [`adapters/memory/`](./adapters/memory/) — `@razroo/parallel-mcp-memory`, the minimal async reference adapter
- [`adapters/postgres/`](./adapters/postgres/) — `@razroo/parallel-mcp-postgres`, beta Postgres `AsyncParallelMcpStore`
- [`bench/`](./bench/) — local throughput benches for the claim path (sync and async)

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
