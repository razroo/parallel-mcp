import {
  AsyncParallelMcpOrchestrator,
  SqliteParallelMcpStore,
  toAsyncStore,
} from '@razroo/parallel-mcp'
import { runAsyncConformanceSuite } from '../src/index.js'

runAsyncConformanceSuite({
  label: 'sqlite-via-toAsyncStore (reference async adapter)',
  // A sync store wrapped by `toAsyncStore` cannot hold a commit across
  // awaits — the cross-await transaction test is skipped here. Native
  // async stores (e.g. Postgres) leave this flag at its default true.
  supportsAwaitedTransactions: false,
  createOrchestrator: () => ({
    orchestrator: new AsyncParallelMcpOrchestrator(
      toAsyncStore(new SqliteParallelMcpStore({ filename: ':memory:' })),
      { defaultLeaseMs: 500 },
    ),
  }),
})
