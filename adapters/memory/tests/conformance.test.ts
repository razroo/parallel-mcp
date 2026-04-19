import { AsyncParallelMcpOrchestrator } from '@razroo/parallel-mcp'
import { runAsyncConformanceSuite } from '@razroo/parallel-mcp-testkit'
import { MemoryParallelMcpStore } from '../src/index.js'

runAsyncConformanceSuite({
  label: 'memory (reference async adapter)',
  createOrchestrator: () => ({
    orchestrator: new AsyncParallelMcpOrchestrator(new MemoryParallelMcpStore(), {
      defaultLeaseMs: 500,
    }),
  }),
})
