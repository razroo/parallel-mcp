/**
 * retry-and-resume — exercises the retry policy and the pause / resume path.
 *
 * Scenario:
 *   1. Enqueue a `deploy` task that depends on a `build` task.
 *   2. The build task hits a transient error twice and *releases* itself back
 *      to the queue. Lease expiry / the release path re-queues it without
 *      consuming a retry attempt.
 *   3. On the third attempt, the build succeeds.
 *   4. The deploy task first *pauses* itself with `waiting_input` (simulating
 *      a "need human approval" gate), then the driver script resumes it.
 *   5. Deploy completes. We print the full event log so you can see each
 *      state transition end to end.
 *
 * Note: `failTask` is terminal — it marks the task `failed` and does not
 * re-queue. If you want automatic retries, either release the task
 * (`{ status: 'released' }`) or let the lease expire and let
 * `expireLeases()` re-queue it (subject to `maxAttempts`).
 */

import {
  ParallelMcpOrchestrator,
  SqliteParallelMcpStore,
  runWorker,
  type EventRecord,
  type WorkerHandleResult,
} from '../src/index.js'

const store = new SqliteParallelMcpStore({ filename: ':memory:' })
const orchestrator = new ParallelMcpOrchestrator(store, {
  defaultLeaseMs: 2_000,
  onEvent: (event: EventRecord) => {
    const short = event.eventType.padEnd(22)
    const taskId = event.taskId ? event.taskId.slice(0, 8) : '-       '
    console.log(`[event] ${short} task=${taskId}`)
  },
})

const run = orchestrator.createRun({ namespace: 'examples.retry-and-resume' })

const build = orchestrator.enqueueTask({
  runId: run.id,
  kind: 'build',
  key: 'build',
  maxAttempts: 5,
  retry: { delayMs: 100, backoff: 'exponential', maxDelayMs: 1_000 },
  input: { commit: 'abcdef0' },
})

const deploy = orchestrator.enqueueTask({
  runId: run.id,
  kind: 'deploy',
  key: 'deploy',
  maxAttempts: 2,
  dependsOnTaskIds: [build.id],
  input: { environment: 'staging' },
})

let buildAttempts = 0
let deployApproved = false

const worker = runWorker({
  orchestrator,
  workerId: 'worker-main',
  pollIntervalMs: 10,
  idleBackoffMs: 20,
  idleMaxBackoffMs: 100,
  drainTimeoutMs: 250,
  handler: async ({ task }): Promise<WorkerHandleResult> => {
    if (task.kind === 'build') {
      buildAttempts += 1
      if (buildAttempts < 3) {
        return {
          status: 'released',
          reason: `transient build failure (attempt ${buildAttempts})`,
        }
      }
      return {
        status: 'completed',
        output: { artifactUrl: 's3://builds/abcdef0.tar.gz' },
      }
    }

    if (task.kind === 'deploy') {
      if (!deployApproved) {
        return {
          status: 'paused',
          pauseAs: 'waiting_input',
          reason: 'awaiting human approval',
        }
      }
      return {
        status: 'completed',
        output: { deployedAt: new Date().toISOString() },
      }
    }

    return { status: 'failed', error: `unknown kind: ${task.kind}` }
  },
  onError: (error, task) => {
    console.error(`[worker] error on task=${task?.id.slice(0, 8) ?? '-'}:`, error)
  },
})

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('waitFor timeout')
}

await waitFor(() => {
  const t = orchestrator.getTask(deploy.id)
  return t?.status === 'waiting_input'
})

console.log('\n[driver] deploy is waiting for approval — simulating human approval...\n')

await new Promise(resolve => setTimeout(resolve, 200))

deployApproved = true
orchestrator.resumeTask({ taskId: deploy.id })

await waitFor(() => {
  const final = orchestrator.getRun(run.id)
  return !!final && ['completed', 'failed', 'cancelled'].includes(final.status)
})

worker.stop()
await worker.stopped

const finalRun = orchestrator.getRun(run.id)
const tasks = orchestrator.listRunTasks(run.id)

console.log('\n== Final state ==')
console.log(`run status:     ${finalRun?.status}`)
console.log(`build attempts: ${buildAttempts}`)
for (const task of tasks) {
  console.log(`  ${task.kind.padEnd(8)} status=${task.status} attempts=${task.attemptCount}`)
}

orchestrator.close()
