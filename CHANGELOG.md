# Changelog

All notable changes to `@razroo/parallel-mcp`, `@razroo/parallel-mcp-server`, and
`@razroo/parallel-mcp-testkit` are documented in this file.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html). All three
workspace packages share a single version line: a release tagged `vX.Y.Z`
publishes all three at the same version.

## [Unreleased]

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

[Unreleased]: https://github.com/razroo/parallel-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/razroo/parallel-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/razroo/parallel-mcp/releases/tag/v0.1.0
