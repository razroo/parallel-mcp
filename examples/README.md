# Examples

Runnable end-to-end demos for `@razroo/parallel-mcp`. Each script runs straight from source with `tsx`.

## fan-out

Creates a single run, enqueues a batch of `fetch` tasks with retry policy, spins up three concurrent `runWorker` loops against an in-memory SQLite store, and prints the `onEvent` observability stream as tasks flow through the orchestrator to a terminal run state.

```bash
npm run example:fan-out
```

Expected output is a stream of `task.enqueued` / `task.claimed` / `task.running` / `task.completed` events from multiple workers, followed by a final run-status transition and a per-task summary. About 20% of tasks will deliberately fail on the first attempt to exercise the retry + `not_before` paths.
