# Failure-mode matrix

This is the cheat sheet we want every adapter author to read once. It maps the
things that actually go wrong in a durable worker to how the core behaves, what
errors you should expect, and how to respond.

## Typed errors

All errors thrown by `ParallelMcpOrchestrator` / `SqliteParallelMcpStore` extend
`ParallelMcpError`:

| Error                      | When it is thrown                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `RecordNotFoundError`      | Looked-up run / task / attempt / lease / snapshot id does not exist                 |
| `InvalidTransitionError`   | Caller tried to drive a task through an illegal state transition                    |
| `LeaseConflictError`       | `leaseId` / `workerId` does not match the current lease on the task                 |
| `LeaseExpiredError`        | Lease has already expired at the current timestamp                                  |
| `RunTerminalError`         | Mutating write against a run in a terminal state                                    |
| `DuplicateTaskKeyError`    | `enqueueTask` with a `key` already used inside the same run                         |
| `MaxAttemptsExceededError` | `failTask` / retry path detected the task has exhausted `maxAttempts`               |
| `DependencyCycleError`     | `enqueueTask` dependency graph would introduce a cycle                              |

Everything else (bad input types, JSON parse errors, SQLite driver errors) is
propagated as plain `Error`.

## Failure-mode matrix

| Failure                                           | Core behavior                                                                                                              | What the worker should do                                                                        |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Worker crashes mid-task                           | Lease eventually expires; `expireLeases` requeues (respecting `maxAttempts`, `not_before`)                                  | Run `expireLeases` on a timer (e.g. every few seconds) from *some* process                       |
| Worker's network blips, heartbeat late            | `heartbeatLease` extends `lease_expires_at`                                                                                | Heartbeat at 1/3 of `leaseMs`; treat `LeaseExpiredError` as "another worker owns it now"         |
| Two workers claim at the same instant             | `claimNextTask` uses `BEGIN IMMEDIATE` + conditional `UPDATE`; only one worker wins                                         | Loser gets `null` (or a different task); no special handling                                     |
| Duplicate `completeTask` / `failTask` retry       | Without `clientToken`: second call raises `LeaseConflictError` (lease is gone). With `clientToken`: returns the same result | Always pass a stable `clientToken` when the caller might retry across process restarts           |
| Duplicate `claimNextTask` retry                   | With `clientToken`: returns the same claim. Without: a second active lease is impossible, so you'll just get a new task     | Generate `clientToken` per claim attempt, keep it until the task is terminal                     |
| Task keeps failing                                | After `attemptCount >= maxAttempts`, the task is force-marked `failed` with `error = 'max_attempts_exceeded'` **and moved to the dead-letter queue** (`dead = true`). `claimNextTask` will never return it again | Poll `listDeadTasks({ runId?, kinds?, limit? })` (or subscribe to `task.dead_lettered` events) and decide per task whether to drop, alert, or `requeueDeadTask({ taskId, resetAttempts? })` — which emits `task.requeued_from_dlq` |
| Attempt exceeds its wall-clock budget             | `enqueueTask({ timeoutMs })` arms a per-attempt timeout. `runWorker` aborts the handler's `AbortSignal` after `timeoutMs` and reports a timeout-fail. Retries respect `maxAttempts` / `retry` normally        | Always honour `signal` inside handlers (propagate to `fetch`, Playwright, subprocesses). `timeoutMs` is independent of `leaseMs`, which is purely a crash-detection signal |
| Dependency not ready                              | `claimNextTask` silently skips tasks whose `dependsOnTaskIds` have not all completed                                        | Don't poll individual tasks — just keep calling `claimNextTask`                                  |
| Task needs human input                            | Use `pauseTask({ status: 'waiting_input' })` — the task leaves the queue                                                    | Call `resumeTask` once input is ready; the task returns to `queued`                              |
| Run is cancelled                                  | `cancelRun` transitions all non-terminal tasks to `cancelled`, marks all active leases/attempts cancelled                   | Workers holding a lease on a cancelled task will get `InvalidTransitionError` on their next write — treat as "abandon this task" |
| Database is locked by another writer              | `better-sqlite3` retries up to `busy_timeout` (default 5s). After that, the driver throws `SQLITE_BUSY`                     | Tune `busyTimeoutMs` on `SqliteParallelMcpStore` if you expect heavy multi-writer contention      |

## Observability

Register `onEvent` at the orchestrator boundary to see every durable event in
order. Listeners are synchronous and their exceptions are swallowed, so it is
safe to ship them off to logs/metrics/traces without risking core correctness:

```ts
const orchestrator = new ParallelMcpOrchestrator(store, {
  onEvent: event => logger.info({ event }, 'parallel-mcp event'),
})
```

For reliable fan-out to durable subscribers (cross-process), poll
`listEventsSince({ afterId: cursor, limit })` and persist `nextCursor` after
each batch.

Relevant event types for the failure-mode matrix above:

- `task.failed` — final failure after the worker wrote `failTask` or after lease-expiry retries were exhausted. When `runWorker` aborts a handler because `timeoutMs` elapsed, it writes `failTask` with `error = "task_timeout_exceeded:<ms>ms"`, which surfaces through this same event.
- `task.dead_lettered` — emitted once when the task is moved to the dead-letter queue
- `task.requeued_from_dlq` — emitted when `requeueDeadTask` revives a dead task (includes the reason)

These event types are stable; adapter authors should emit them verbatim so triage tooling stays portable.
