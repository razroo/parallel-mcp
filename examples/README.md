# Examples

Runnable end-to-end demos for `@razroo/parallel-mcp`. Each script runs
straight from source with `tsx`.

## fan-out

Creates a single run, enqueues a batch of `fetch` tasks with retry policy,
spins up three concurrent `runWorker` loops against an in-memory SQLite
store, and prints the `onEvent` observability stream as tasks flow through
the orchestrator to a terminal run state.

```bash
npm run example:fan-out
```

Expected output is a stream of `task.enqueued` / `task.claimed` /
`task.running` / `task.completed` events from multiple workers, followed by
a final run-status transition and a per-task summary. About 20% of tasks
will deliberately fail on the first attempt to exercise the retry +
`not_before` paths.

## retry-and-resume

Demonstrates the retry policy and the `pause` / `resume` path:

1. A `build` task that fails transiently twice (exponential backoff on
   `retry.delayMs`) before succeeding on the third attempt.
2. A `deploy` task that depends on `build`, which pauses itself in
   `waiting_input` until the driver script calls `resumeTask`.
3. Final event log shows every state transition end to end.

```bash
npm run example:retry-and-resume
```

Good starting point if you're wiring a human-in-the-loop step or any flow
that sits idle waiting for an external signal (approval, webhook, etc.).

## multi-worker

A realistic multi-worker setup in one process, showing the pattern you'd
use across **separate** processes as well:

- Shared SQLite file (durable, not `:memory:`) so every worker sees the
  same state.
- Eight workers: four restricted to `kinds: ['image']`, four that accept
  any kind.
- Dedicated `scheduleExpireLeases` sweeper so the workers can pass
  `expireLeasesOnPoll: false` and stay on the hot path.
- Single `AbortController` wired to `SIGINT` / `SIGTERM`, propagated to
  every worker and the sweeper for clean shutdown.

```bash
npm run example:multi-worker
```

Prints a per-worker completion tally at the end so you can see how work
distributes across workers. Across runs the numbers will vary — that's
the point.
