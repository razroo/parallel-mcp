import {
  ParallelMcpOrchestrator,
  SqliteParallelMcpStore,
} from '@razroo/parallel-mcp'
import { runConformanceSuite } from '../src/index.js'

runConformanceSuite({
  label: 'sqlite (reference adapter)',
  createOrchestrator: () => ({
    orchestrator: new ParallelMcpOrchestrator(
      new SqliteParallelMcpStore({ filename: ':memory:' }),
      { defaultLeaseMs: 500 },
    ),
  }),
})
