import {
  ParallelMcpOrchestrator,
  SqliteParallelMcpStore,
  runWorker,
  type EventRecord,
  type WorkerHandle,
} from '../src/index.js'

const store = new SqliteParallelMcpStore({ filename: ':memory:' })

const orchestrator = new ParallelMcpOrchestrator(store, {
  defaultLeaseMs: 2_000,
  onEvent: (event: EventRecord) => {
    if (event.eventType === 'run.status.changed') {
      const payload = event.payload as { from: string; to: string }
      console.log(`[event] run ${event.runId.slice(0, 8)} ${payload.from} → ${payload.to}`)
    } else if (event.eventType.startsWith('task.')) {
      console.log(`[event] ${event.eventType} task=${event.taskId?.slice(0, 8) ?? '-'}`)
    }
  },
})

const run = orchestrator.createRun({
  namespace: 'examples.fan-out',
  context: { project: 'demo' },
})

const URLS = [
  'https://example.com/a',
  'https://example.com/b',
  'https://example.com/c',
  'https://example.com/d',
  'https://example.com/e',
  'https://example.com/f',
]

for (const url of URLS) {
  orchestrator.enqueueTask({
    runId: run.id,
    kind: 'fetch',
    key: url,
    input: { url },
    maxAttempts: 3,
    retry: { delayMs: 50, backoff: 'exponential', maxDelayMs: 1_000 },
  })
}

console.log(`Enqueued ${URLS.length} tasks on run ${run.id}`)

const WORKER_COUNT = 3
const workers: WorkerHandle[] = []

for (let index = 0; index < WORKER_COUNT; index += 1) {
  const workerId = `worker-${index + 1}`
  workers.push(
    runWorker({
      orchestrator,
      workerId,
      kinds: ['fetch'],
      pollIntervalMs: 10,
      idleBackoffMs: 20,
      idleMaxBackoffMs: 200,
      drainTimeoutMs: 500,
      handler: async ({ task }) => {
        const input = task.input as { url: string } | null
        const latency = 20 + Math.floor(Math.random() * 80)
        await new Promise(resolve => setTimeout(resolve, latency))
        if (input && Math.random() < 0.2) {
          return { status: 'failed', error: `transient error fetching ${input.url}` }
        }
        return {
          status: 'completed',
          output: {
            url: input?.url ?? null,
            status: 200,
            latencyMs: latency,
            workerId,
          },
        }
      },
      onError: (error, task) => {
        console.error(`[${workerId}] handler error on task=${task?.id.slice(0, 8) ?? '-'}:`, error)
      },
    }),
  )
}

async function waitForTerminal(): Promise<void> {
  while (true) {
    const current = orchestrator.getRun(run.id)
    if (current && ['completed', 'failed', 'cancelled'].includes(current.status)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

await waitForTerminal()

for (const worker of workers) worker.stop()
await Promise.all(workers.map(worker => worker.stopped))

const final = orchestrator.getRun(run.id)
const tasks = orchestrator.listRunTasks(run.id)
const events = orchestrator.listRunEvents(run.id)

console.log('\n== Run summary ==')
console.log(`status:       ${final?.status}`)
console.log(`tasks total:  ${tasks.length}`)
console.log(`completed:    ${tasks.filter(task => task.status === 'completed').length}`)
console.log(`failed:       ${tasks.filter(task => task.status === 'failed').length}`)
console.log(`events total: ${events.length}`)

orchestrator.close()
