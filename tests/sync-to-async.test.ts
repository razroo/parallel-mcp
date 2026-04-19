import { describe, expect, it, afterEach } from 'vitest'
import { SqliteParallelMcpStore, toAsyncStore } from '../src/index.js'
import type { AsyncParallelMcpStore } from '../src/index.js'

describe('toAsyncStore.transaction guardrails', () => {
  const stores: Array<{ close: () => void }> = []

  afterEach(() => {
    while (stores.length > 0) stores.pop()?.close()
  })

  function makeStore(): AsyncParallelMcpStore {
    const sync = new SqliteParallelMcpStore({ filename: ':memory:' })
    stores.push({ close: () => sync.close() })
    return toAsyncStore(sync)
  }

  it('accepts a synchronous body that returns a value', async () => {
    const store = makeStore()
    const run = await store.transaction(() => {
      const r = 'ok'
      return r as unknown as Promise<string>
    })
    expect(run).toBe('ok')
  })

  it('accepts a synchronous body that returns an already-resolved Promise', async () => {
    const store = makeStore()
    const out = await store.transaction(() => Promise.resolve(42))
    expect(out).toBe(42)
  })

  it('rejects a declared `async` callback with a clear message', async () => {
    const store = makeStore()
    await expect(
      store.transaction(async () => {
        await Promise.resolve()
        return 1
      }),
    ).rejects.toThrowError(/async callback/i)
  })

  it('rejects a callback that returns a pending Promise (escaped via microtask)', async () => {
    const store = makeStore()
    await expect(
      store.transaction(() =>
        new Promise<number>(resolve => {
          setTimeout(() => resolve(7), 10)
        }),
      ),
    ).rejects.toThrowError(/not settled|pending|transaction committed/i)
  })

  it('propagates synchronous errors from the callback', async () => {
    const store = makeStore()
    await expect(
      store.transaction(() => {
        throw new Error('boom')
      }),
    ).rejects.toThrowError(/boom/)
  })
})
