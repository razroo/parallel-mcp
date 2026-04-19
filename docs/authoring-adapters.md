# Authoring a parallel-mcp adapter

An **adapter** is the code that translates between a concrete MCP tool, a long-
running external system (API, site, CLI, sandbox, shell), and the durable
orchestrator. This guide shows the minimum you need to do to ship one safely.

## Shape of an adapter

Most adapters boil down to a single function that takes a claimed task and
returns an outcome. You can run any number of these side-by-side using the
[`runWorker`](../src/worker.ts) helper.

```ts
import {
  ParallelMcpOrchestrator,
  SqliteParallelMcpStore,
  runWorker,
} from '@razroo/parallel-mcp'

const orchestrator = new ParallelMcpOrchestrator(
  new SqliteParallelMcpStore({ filename: '/var/lib/parallel-mcp/state.sqlite' }),
)

const worker = runWorker(orchestrator, {
  workerId: 'resume-parse-worker-1',
  kinds: ['resume.parse'],
  leaseMs: 30_000,
  heartbeatIntervalMs: 10_000,
  pollIntervalMs: 500,
  drainTimeoutMs: 30_000,

  async handler({ task, lease }) {
    const output = await parseResume(task.input)
    return { kind: 'complete', output }
  },
})
```

`handler` must return one of:

- `{ kind: 'complete', output?, metadata?, nextContext?, nextContextLabel? }`
- `{ kind: 'fail', error, metadata? }`
- `{ kind: 'pause', status: 'blocked' | 'waiting_input', reason? }`
- `{ kind: 'release', reason? }` — give the lease back without consuming an attempt

If the handler throws, `runWorker` treats it as `{ kind: 'fail', error: err.message }`.

## The rules

1. **Never skip the lease check.** Every write (`completeTask`, `failTask`,
   `pauseTask`, `releaseTask`, `heartbeatLease`) must carry the `taskId`,
   `leaseId`, and `workerId` you were given on claim. The core will reject
   writes that don't match with `LeaseConflictError` or `LeaseExpiredError`.
2. **Heartbeat.** If your handler can take more than a fraction of `leaseMs`,
   heartbeat at least every `leaseMs/3`. `runWorker` does this for you.
3. **Use `clientToken` on retries.** If the adapter process can crash between
   "work is done externally" and "we called `completeTask`", generate a stable
   `clientToken` once and reuse it on retry. The core will short-circuit the
   second call and return the already-recorded outcome.
4. **Decide retry policy at enqueue, not at handler time.** Pass
   `{ maxAttempts, retry: { delayMs, backoff, maxDelayMs } }` to `enqueueTask`.
   On failure, the core will bump `not_before` and requeue automatically.
5. **Own your inputs.** Keep `task.input` small and JSON-serializable. Large
   payloads belong in a context snapshot (`appendContextSnapshot`), referenced
   by id.

## Context snapshots

Context snapshots are the durable channel for data that survives across tasks
in the same run. Use them when a downstream task needs the upstream task's
output — don't read it back off the upstream task record in production code.

```ts
return {
  kind: 'complete',
  nextContext: { parsedResumeId, candidateId },
  nextContextLabel: 'resume.parse.completed',
}
```

Downstream tasks read `orchestrator.getCurrentContextSnapshot(runId)` or pass an
explicit `contextSnapshotId` on `enqueueTask`.

## Running alongside the MCP server

If you want your adapter reachable as a set of MCP tools (for Claude, Cursor,
etc.), compose the core orchestrator with the `@razroo/parallel-mcp-server`
package:

```ts
import { createParallelMcpServer } from '@razroo/parallel-mcp-server'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const store = new SqliteParallelMcpStore({ filename: process.env.MCP_DB! })
const handle = createParallelMcpServer({ store })

await handle.server.connect(new StdioServerTransport())
```

The same store is shared with your `runWorker` instances — the MCP server
accepts external tool calls (`create_run`, `enqueue_task`, `list_events_since`,
…) while your adapters drain the queue.

## Testing your adapter

- Use `new SqliteParallelMcpStore({ filename: ':memory:' })` for unit tests.
- Drive the full cycle end-to-end: `createRun` → `enqueueTask` → run a handler
  either directly or via `runWorker` → assert on the resulting task, events,
  and context snapshots.
- The `examples/fan-out.ts` file in this repo is a working reference for a
  multi-worker adapter with retries and event observation.

## When to reach for `orchestrator.transaction(fn)`

Use it when you need *multiple* durable writes to succeed or fail together —
for example, appending a context snapshot *and* enqueuing a new task that
references it. The callback runs inside an `IMMEDIATE` SQLite transaction; if
it throws, every write inside is rolled back.

```ts
orchestrator.transaction(() => {
  const snapshot = orchestrator.appendContextSnapshot({ runId, payload })
  orchestrator.enqueueTask({ runId, kind: 'site.apply', contextSnapshotId: snapshot.id })
})
```

## Writing an async adapter (Postgres, a remote service, etc.)

Targets other than in-process SQLite should implement
[`AsyncParallelMcpStore`](../src/async-store.ts) instead of
`ParallelMcpStore`. Every method returns `Promise<T>`, which lets you
back the store with a real async driver (`pg`, `mysql2`, a REST client,
a message queue) without faking a synchronous surface.

The async orchestrator is [`AsyncParallelMcpOrchestrator`](../src/async-orchestrator.ts).
Its API is a 1:1 async copy of `ParallelMcpOrchestrator`:

```ts
import {
  AsyncParallelMcpOrchestrator,
  runWorker,
} from '@razroo/parallel-mcp'
import { PostgresParallelMcpStore } from '@razroo/parallel-mcp-postgres'
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const store = new PostgresParallelMcpStore({ pool, autoMigrate: true })
await store.migrate()

const orchestrator = new AsyncParallelMcpOrchestrator(store, {
  defaultLeaseMs: 30_000,
})
```

`runWorker` accepts either orchestrator flavor — handlers themselves
stay `async` regardless.

### Validating your adapter

Point the async conformance suite at your implementation before
shipping. It covers the full lifecycle, DLQ, idempotency, context
snapshots, lease expiry, cancellation, and admin introspection.

```ts
// adapters/<mine>/tests/conformance.test.ts
import { AsyncParallelMcpOrchestrator } from '@razroo/parallel-mcp'
import { runAsyncConformanceSuite } from '@razroo/parallel-mcp-testkit'
import { MyAdapterStore } from '../src/index.js'

runAsyncConformanceSuite({
  label: 'my-adapter',
  createOrchestrator: async () => ({
    orchestrator: new AsyncParallelMcpOrchestrator(new MyAdapterStore(), {
      defaultLeaseMs: 500,
    }),
  }),
})
```

The [`@razroo/parallel-mcp-memory`](../adapters/memory/) workspace is
the minimum viable reference implementation — 22/22 on the async
conformance suite in ~300 lines of in-memory state. Read its `store.ts`
top-to-bottom if you want a template without any SQL noise.

### Bridging a sync store into the async world

If you have an existing `ParallelMcpStore` (e.g. `SqliteParallelMcpStore`)
and a consumer that needs the async API, wrap it with `toAsyncStore`:

```ts
import {
  AsyncParallelMcpOrchestrator,
  SqliteParallelMcpStore,
  toAsyncStore,
} from '@razroo/parallel-mcp'

const sync = new SqliteParallelMcpStore({ filename: '/var/lib/pmcp/state.sqlite' })
const orchestrator = new AsyncParallelMcpOrchestrator(toAsyncStore(sync))
```

Caveat: `toAsyncStore(sync).transaction(fn)` can only guarantee
isolation when `fn` is synchronous. If you need to `await` inside a
transaction, either use an adapter that implements native async
transactions (Postgres does) or pre-compute the async work before
entering the transaction.

## Dead-letter queue and task timeouts

Two orchestrator features that adapters should know about:

- **`timeoutMs` on `enqueueTask`** — a hard per-attempt wall-clock
  budget. When set, `runWorker` aborts the handler's `AbortSignal`
  after `timeoutMs` and records a timeout-fail outcome (still honouring
  `maxAttempts` + retry backoff). Independent of `leaseMs`, which only
  handles crash detection.
- **Dead-letter queue** — once a task has burnt through `maxAttempts`
  via lease expiry, the orchestrator marks it `dead: true` and stops
  handing it to workers. Use `orchestrator.listDeadTasks()` to triage
  and `orchestrator.requeueDeadTask({ taskId })` to revive. The
  corresponding typed events are `task.dead_lettered` and
  `task.requeued_from_dlq`.
