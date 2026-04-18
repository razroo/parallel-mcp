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
