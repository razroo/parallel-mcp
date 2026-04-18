import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ParallelMcpOrchestrator, SqliteParallelMcpStore } from '../src/index.js'

describe('claimNextTask concurrency', () => {
  const cleanup: Array<() => void> = []

  afterEach(() => {
    while (cleanup.length > 0) {
      cleanup.pop()?.()
    }
  })

  it('never hands the same task to two concurrent orchestrators over the same DB file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parallel-mcp-claim-'))
    const filename = join(dir, 'parallel-mcp.db')
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))

    const setup = new ParallelMcpOrchestrator(new SqliteParallelMcpStore({ filename }))
    cleanup.push(() => setup.close())

    const run = setup.createRun({ namespace: 'race' })
    const TASK_COUNT = 25
    for (let index = 0; index < TASK_COUNT; index += 1) {
      setup.enqueueTask({ runId: run.id, kind: 'work', key: `t${index}` })
    }

    const WORKERS = 4
    const orchestrators: ParallelMcpOrchestrator[] = []
    for (let index = 0; index < WORKERS; index += 1) {
      const o = new ParallelMcpOrchestrator(new SqliteParallelMcpStore({ filename }))
      orchestrators.push(o)
      cleanup.push(() => o.close())
    }

    const taskIds = new Set<string>()
    let collisions = 0

    let remaining = TASK_COUNT * 2
    while (remaining-- > 0) {
      let progress = false
      for (const orchestrator of orchestrators) {
        const claim = orchestrator.claimNextTask({ workerId: `worker-${orchestrators.indexOf(orchestrator)}` })
        if (!claim) continue
        progress = true
        if (taskIds.has(claim.task.id)) {
          collisions += 1
        } else {
          taskIds.add(claim.task.id)
        }
      }
      if (!progress) break
    }

    expect(collisions).toBe(0)
    expect(taskIds.size).toBe(TASK_COUNT)
  })
})
