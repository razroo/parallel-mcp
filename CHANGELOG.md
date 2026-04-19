# Changelog

All notable changes to `@razroo/parallel-mcp`, `@razroo/parallel-mcp-server`, and
`@razroo/parallel-mcp-testkit` are documented in this file.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html). All three
workspace packages share a single version line: a release tagged `vX.Y.Z`
publishes all three at the same version.

## Adapter patch releases — 2026-04-18

### `@razroo/parallel-mcp-memory@0.1.1` + `@razroo/parallel-mcp-postgres@0.1.0-beta.1`

- **Fix**: `npm install @razroo/parallel-mcp-postgres@0.1.0-beta.0` could hang
  in npm's dependency resolver because the registry metadata document for that
  release still listed `"@razroo/parallel-mcp": "file:../.."` as a runtime
  dependency. The published tarball already contained the correct rewritten
  `"^0.4.0"` range, but npm resolves from the registry document first when it
  has to reconcile other deps (e.g. `pg`), and the workspace-path entry sent
  it into an infinite `placeDep` loop. Root cause: the adapter publish
  lifecycle ran `postpack` between `pack` and the metadata upload, restoring
  the original workspace-path dependency on disk before npm read it for the
  registry document. Both adapters now run the restore script from
  `postpublish` instead, so the rewritten `package.json` stays in place
  through the registry upload. The same fix is mirrored in
  `@razroo/parallel-mcp-server` and `@razroo/parallel-mcp-testkit`, which
  were unaffected in practice (their consumers fall through to the tarball)
  but were carrying the same stale workspace-path in their registry
  documents.
- No behavior or API changes inside the adapter code. Republishing under new
  patch/beta numbers because npm does not allow re-publishing over an
  existing version, even to fix a broken registry document.

## [0.4.0] - 2026-04-18

### Added
- **Core**: `AsyncParallelMcpStore` interface — the async counterpart to
  `ParallelMcpStore`. Every method returns `Promise<T>`, so adapters that
  speak to truly asynchronous backends (Postgres, a remote service, a
  queue) don't have to fake a synchronous surface. `ParallelMcpStore`
  (sync) remains the primary interface for in-process SQLite.
- **Core**: `AsyncParallelMcpOrchestrator` — full parity with
  `ParallelMcpOrchestrator` but async-first. Constructed with any
  `AsyncParallelMcpStore` implementation.
- **Core**: `toAsyncStore(sync)` adapter that lifts a synchronous
  `ParallelMcpStore` into an `AsyncParallelMcpStore`. Useful for sharing
  one SQLite store between sync and async consumers and for running the
  async conformance suite against the reference sync implementation.
  `transaction(fn)` is deliberately strict: it rejects `async` callbacks
  and rejects callbacks that return a still-pending Promise, because a
  sync store can't isolate writes across `await` boundaries. Use a
  native `AsyncParallelMcpStore` when you need that.
- **Core**: dead-letter queue. Tasks whose `maxAttempts` budget is
  exhausted via lease expiry are now marked `dead: true` and moved out
  of the claim path instead of silently losing the attempt. New
  orchestrator methods: `listDeadTasks({ runId?, kinds?, limit?, offset? })`,
  `requeueDeadTask({ taskId, resetAttempts?, notBefore?, reason? })`.
  New typed events: `task.dead_lettered`, `task.requeued_from_dlq`.
- **Core**: per-attempt `timeoutMs` on `enqueueTask`. When set,
  `runWorker` aborts the handler's `AbortSignal` after `timeoutMs`
  elapses and records a `task_timeout_exceeded:<ms>ms` failure
  (respecting `maxAttempts` + retry backoff). Independent of `leaseMs`,
  which governs crash-detection only. Surfaced on
  `onHandlerEnd({ outcome: { status: 'task_timeout', timeoutMs } })`.
- **Testkit**: `runAsyncConformanceSuite` — async counterpart of
  `runConformanceSuite`. Drives an `AsyncParallelMcpOrchestrator` through
  the full lifecycle, DLQ, idempotency, and cancellation suites. Ships
  alongside the existing sync `runConformanceSuite`. New
  `supportsAwaitedTransactions` option lets sync-backed async stores
  (`toAsyncStore`-wrapped) opt out of the await-spanning transaction
  test.
- **Adapters**: `@razroo/parallel-mcp-postgres` promoted from alpha stub
  to **beta** (`0.1.0-beta.0`). `PostgresParallelMcpStore` is now a
  complete `AsyncParallelMcpStore` built on `pg`, using
  `SELECT ... FOR UPDATE SKIP LOCKED` for atomic task claims and
  explicit `BEGIN/COMMIT` blocks for multi-write atomicity. Schema
  covers `timeout_ms`, `dead`, and `task_completions`. Live conformance
  suite runs against a real Postgres when `DATABASE_URL` is set.
- **Adapters**: new `@razroo/parallel-mcp-memory` (`0.1.0`) — a tiny,
  dependency-free, non-durable reference `AsyncParallelMcpStore` for
  demos, tests, and adapter-author onboarding. Passes the full async
  conformance suite.
- **Server**: three new MCP tools — `enqueue_task` now accepts
  `timeoutMs`; `list_dead_tasks` and `requeue_dead_task` expose the DLQ
  to MCP clients. End-to-end round-trip tests included. (The server
  still drives the sync orchestrator; an async variant is planned.)
- **Examples**: new `examples/async-dlq-triage.ts` — end-to-end demo of
  `AsyncParallelMcpOrchestrator` + `MemoryParallelMcpStore` + a
  hand-rolled async worker loop + DLQ triage / replay.
- **Bench**: new `bench/claim-throughput-async.ts` + `npm run
  bench:claims:async`. Benches the async claim path against
  `MemoryParallelMcpStore` by default, `PostgresParallelMcpStore` when
  `--store=postgres` and `DATABASE_URL` are set.
- **CI**: live Postgres conformance job (spins up `postgres:16` as a
  service and runs the async conformance suite against it); memory
  adapter test + build job wired into the matrix and the
  `compat-sqlite` floor.
- **Release**: `release.yml` now packs, versions, and publishes
  `@razroo/parallel-mcp-postgres` and `@razroo/parallel-mcp-memory`
  alongside core/server/testkit, skipping re-publishes when the
  adapter's version is already on npm (adapters track independent
  pre-1.0 version lines).
- **Docs**: README, `docs/failure-modes.md`, and `docs/authoring-
  adapters.md` updated with async, DLQ, `timeoutMs`, and memory/
  postgres adapter coverage.

### Changed
- Core, server, and testkit bumped to `0.4.0`. Testkit
  `peerDependencies."@razroo/parallel-mcp"` stays at `>=0.3.0 <1.0.0`
  because no breaking changes shipped.

### Known limitations
- `runWorker` still drives only the sync `ParallelMcpOrchestrator`.
  Async callers drive `claimNextTask` / `markTaskRunning` /
  `completeTask` / `failTask` directly (see
  `examples/async-dlq-triage.ts`). A first-class `runAsyncWorker` is
  planned for a follow-up release.
- The MCP server adapter exposes only the sync orchestrator today.
  Pair it with `toAsyncStore` + a sync store when you need MCP-level
  access to an async-first deployment.

## [0.3.0] - 2026-04-19

### Added
- **Core**: `ParallelMcpStore` interface — the orchestrator's underlying
  contract is now explicit and re-exported as a stable type. Adapter
  authors should target this interface rather than the concrete
  `SqliteParallelMcpStore` class. The orchestrator now accepts any
  `ParallelMcpStore` implementation.
- **Core**: `ParallelMcpOrchestrator.addEventListener(listener)` is now a
  public method, not just a constructor hook. Returns a detach function.
  Useful for registering multiple observers after construction (one for
  logs, one for metrics, one for tests).
- **Core**: discriminated-union event types — `TypedEvent`,
  `EventType`, `EventPayloadByType`, `TypedEventOf<K>`, `asTypedEvent()`,
  and `isEventOfType()` let `listEventsSince` / `listRunEvents` / `onEvent`
  consumers do exhaustive pattern matching with strongly-typed payloads.
- **Core**: `runWorker` observer hooks — `onClaim`, `onHandlerStart`,
  `onHandlerEnd`, `onHeartbeat`, `onRunCancelled`. `onHandlerEnd`
  reports wall-clock `durationMs` plus an `outcome` discriminated union
  covering the normal result, thrown errors, and drain timeouts.
- **Core**: `runWorker({ propagateRunCancellation: true })` (default)
  chains a per-task `AbortController` into the handler's `signal`, and
  aborts it when the run containing the current task is cancelled via
  `orchestrator.cancelRun()`. Flip to `false` to keep legacy behavior.
- **Adapters**: new `adapters/postgres` workspace — `@razroo/parallel-mcp-postgres`
  (private, alpha). Ships the canonical Postgres schema as
  `POSTGRES_SCHEMA` plus a scaffolded `PostgresParallelMcpStore` class.
  Most operations currently throw `NotImplementedError` pending the
  `AsyncParallelMcpStore` follow-up — see the package README for status.
- **Examples**: `examples/retry-and-resume.ts` demonstrates transient
  failure → release → retry and a human-in-the-loop `waiting_input` →
  `resumeTask` round-trip.
- **Examples**: `examples/multi-worker.ts` shows a realistic multi-worker
  setup with kind-scoped claim, a dedicated `scheduleExpireLeases`
  sweeper, and one `AbortController` driving every shutdown path.
- **Community**: `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`.
- **Automation**: `dependabot.yml` with weekly grouped PRs for each
  workspace + GitHub Actions.
- **Docs**: TypeDoc API reference generated from `src/index.ts`, auto-
  published to GitHub Pages by `.github/workflows/docs.yml` on every
  push to `main` that touches the core or the config.

### Changed
- All three published workspaces bumped to `0.3.0`.
- Testkit `peerDependencies."@razroo/parallel-mcp"` bumped to `>=0.3.0 <1.0.0`.
- CI now builds and tests the Postgres adapter in addition to core /
  server / testkit.

### Removed
- `.github/workflows/release-server.yml` — superseded by the unified
  multi-package `release.yml` (the old file would have double-published
  the server under a `server-v*` tag).

## [0.2.0] - 2026-04-19

### Added
- **Core**: `scheduleExpireLeases({ orchestrator, intervalMs, ... })` helper
  for running `orchestrator.expireLeases()` on a background timer, with
  `AbortSignal` + `SIGINT`/`SIGTERM` support and an `onTick` hook for metrics.
- **Core**: `runWorker({ installSignalHandlers: true })` opt-in flag that
  wires `SIGINT` / `SIGTERM` to call `stop()` once, for workers running in
  their own process. Listeners are detached automatically when the loop exits.
- **Core**: JSDoc across the full public API — `ParallelMcpOrchestrator`,
  `SqliteParallelMcpStore`, `runWorker`, every error class, every option /
  result type in `src/types.ts`.
- **Core**: `DependencyCycleError` is now thrown when a task declares itself
  as a dependency (previously a generic `Error`).
- **Core**: `InvalidTransitionError` is now thrown when `resumeTask` is called
  on a task that is not in `blocked` / `waiting_input` (previously a generic
  `Error`).
- **Testkit**: new `@razroo/parallel-mcp-testkit` workspace + published npm
  package. Exports `runConformanceSuite({ createOrchestrator, ... })` — a
  reusable Vitest suite alternative adapter authors can point at their
  implementation to verify contract compliance. Covers run / task lifecycle,
  dependencies, idempotency, context snapshots, lease expiry, cancellation,
  admin introspection, retention, and transactions.
- **CI/Release**: multi-package release workflow that validates the git tag
  matches every workspace version, builds / tests / packs all three packages,
  and publishes each to npm with `--provenance`. The GitHub release attaches
  all three tarballs.

### Changed
- `@razroo/parallel-mcp-server` version tracks core: `0.2.0`.
- CI matrix now also builds and tests the testkit workspace.

### Fixed
- Release workflow now builds core before typechecking server / testkit, so
  cross-workspace type imports resolve on a clean checkout.
- Release workflow captures only the tarball filename from `npm pack`
  (previously, `prepack` banners from the server / testkit workspaces could
  leak into `$GITHUB_OUTPUT`).

## [0.1.0] - 2026-04-18

### Added
- **Core**: initial durable orchestration layer for MCP-style workloads —
  `ParallelMcpOrchestrator`, `SqliteParallelMcpStore`, schema migrations,
  retry policy, typed domain errors.
- **Core**: multi-writer-safe `claimNextTask` path (lease is taken in the
  same transaction as the task update so two workers can't race past each
  other).
- **Core**: client-token idempotency on `claimNextTask`, `completeTask`, and
  `failTask`.
- **Core**: `runWorker` helper encapsulating claim → heartbeat → handler →
  outcome loop, with `drainTimeoutMs` for graceful shutdown.
- **Core**: `onEvent` observability hook on `ParallelMcpOrchestrator`,
  fed by every durable event.
- **Core**: admin / introspection helpers (`listRuns`, `listPendingTasks`,
  `listEventsSince` with event cursor, `pruneRuns`, `transaction`).
- **Server**: `@razroo/parallel-mcp-server` MCP stdio + Streamable HTTP
  transport with orchestration tools and admin tools, plus `clientToken`
  support.
- **Examples**: runnable `fan-out` demo against an in-memory store.
- **Docs**: `docs/lifecycle.md`, `docs/failure-modes.md`,
  `docs/authoring-adapters.md`.
- **Bench**: `bench/claim-throughput.ts` for single- and multi-worker
  contention measurements.
- **Compat**: CI matrix pinned to Node 20/22 and `better-sqlite3` floor
  (`11.10.0`).
- **CI/Release**: tag-driven `release.yml` that validates `vX.Y.Z` matches
  the package version before publishing to npm with provenance.

[Unreleased]: https://github.com/razroo/parallel-mcp/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/razroo/parallel-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/razroo/parallel-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/razroo/parallel-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/razroo/parallel-mcp/releases/tag/v0.1.0
