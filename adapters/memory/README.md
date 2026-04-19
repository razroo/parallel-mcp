# `@razroo/parallel-mcp-memory`

Minimal, dependency-free, in-memory reference adapter for
`@razroo/parallel-mcp`. The entire store lives in a single file and uses
nothing but `Map` and `Array`. It exists to:

- **Teach adapter authors** the shape of `AsyncParallelMcpStore` without
  any SQL noise. Read `src/store.ts` top-to-bottom and every method
  maps 1:1 onto the async contract.
- **Unblock lightweight tests and demos** that don't want to reach for a
  real database.
- **Prove the conformance suite runs** against the minimum viable
  implementation — this workspace runs `runAsyncConformanceSuite` from
  `@razroo/parallel-mcp-testkit` end-to-end.

It is **not durable**: everything disappears when the process exits. If
you want cheap persistence with the same interface, use
`SqliteParallelMcpStore` from the core package via `toAsyncStore`.

## Usage

```ts
import {
  AsyncParallelMcpOrchestrator,
  runWorker,
} from '@razroo/parallel-mcp'
import { MemoryParallelMcpStore } from '@razroo/parallel-mcp-memory'

const orchestrator = new AsyncParallelMcpOrchestrator(
  new MemoryParallelMcpStore(),
  { defaultLeaseMs: 30_000 },
)

const run = await orchestrator.createRun({ namespace: 'demo' })
await orchestrator.enqueueTask({ runId: run.id, kind: 'greet' })
```

## Contributing

This workspace is intentionally tiny and should stay that way — the
goal is readable reference code, not feature parity with production
adapters. If you find yourself adding SQL-ish layers here, that probably
belongs in its own adapter workspace instead.
