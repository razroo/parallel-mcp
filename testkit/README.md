# @razroo/parallel-mcp-testkit

Conformance test suite for alternative [@razroo/parallel-mcp][core] orchestrator
and store implementations. If you are shipping a non-default adapter (Postgres,
MySQL, Redis-backed, cloud SQLite, etc.), run this suite from your own Vitest
test file to prove your adapter matches the contract the core exposes.

The reference SQLite adapter already passes the suite — a `smoke.test.ts`
inside this workspace runs it against the default store.

## Install

```bash
npm install --save-dev @razroo/parallel-mcp-testkit vitest
```

Vitest is a peer dependency; you bring your own version (works with `^1`,
`^2`, `^3`, and `^4`).

## Usage

```ts
// tests/my-adapter.conformance.test.ts
import { runConformanceSuite } from '@razroo/parallel-mcp-testkit'
import { createMyOrchestrator, dropMyAdapterSchema } from '../src/index.js'

runConformanceSuite({
  label: 'postgres adapter',
  createOrchestrator: async () => {
    const orchestrator = await createMyOrchestrator()
    return {
      orchestrator,
      cleanup: () => dropMyAdapterSchema(),
    }
  },
})
```

Then run it with `vitest run`.

## What the suite covers

- Run lifecycle: creation, terminal rejection, duplicate keys, cycle detection.
- Task lifecycle: claim / heartbeat / complete, pause / resume, release,
  illegal-transition rejection, and ownership checks (`LeaseConflictError`).
- Dependencies: a dependent task is not claimable until prerequisites
  complete.
- Idempotency: retried `completeTask` with the same `clientToken` is a no-op.
- Context snapshots: initial context and per-task advancement.
- Lease expiry and requeue (opt-out via `supportsLeaseExpiry: false`).
- Cancellation.
- Admin / introspection: `listRuns`, `listPendingTasks`, paginated
  `listEventsSince`.
- Retention: `pruneRuns` cascade.
- Transactions: atomic `transaction()` commit + rollback.

## Options

```ts
interface ConformanceSuiteOptions {
  label: string
  createOrchestrator: () =>
    | { orchestrator: ParallelMcpOrchestrator; cleanup?: () => Promise<void> | void }
    | Promise<{ orchestrator: ParallelMcpOrchestrator; cleanup?: () => Promise<void> | void }>
  timeScale?: number // default 1; multiply for slow/remote adapters
  supportsLeaseExpiry?: boolean // default true
}
```

`createOrchestrator` is called once per test, so your adapter must produce a
fresh, isolated orchestrator each time (e.g. new schema / DB / filename). The
testkit calls `orchestrator.close()` after each test and runs any `cleanup`
you return.

[core]: https://github.com/razroo/parallel-mcp
