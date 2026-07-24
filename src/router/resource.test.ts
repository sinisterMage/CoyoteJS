import { describe, expect, it } from 'vitest'
import { createRoot, flushSync, signal } from '../reactivity'
import { createResource } from './resource'

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('createResource', () => {
  it('resolves and transitions loading true → false', async () => {
    let dispose!: () => void
    const res = createRoot((d) => {
      dispose = d
      return createResource(
        () => true,
        async () => {
          await Promise.resolve()
          return 42
        },
      )
    })

    // Loading starts immediately (fetch kicked off in the tracking effect).
    flushSync()
    expect(res.loading()).toBe(true)
    expect(res()).toBeUndefined()

    await tick()
    flushSync()
    expect(res.loading()).toBe(false)
    expect(res()).toBe(42)
    expect(res.latest()).toBe(42)
    expect(res.error()).toBeUndefined()
    dispose()
  })

  it('captures a rejection in error() and clears loading', async () => {
    let dispose!: () => void
    const boom = new Error('nope')
    const res = createRoot((d) => {
      dispose = d
      return createResource(
        () => true,
        async () => {
          throw boom
        },
      )
    })
    await tick()
    flushSync()
    expect(res.loading()).toBe(false)
    expect(res.error()).toBe(boom)
    expect(res()).toBeUndefined()
    dispose()
  })

  it('re-fetches when the source accessor changes', async () => {
    let dispose!: () => void
    const [id, setId] = signal(1)
    const seen: number[] = []
    const res = createRoot((d) => {
      dispose = d
      return createResource(
        () => id(),
        async (n) => {
          seen.push(n)
          return n * 10
        },
      )
    })
    await tick()
    flushSync()
    expect(res()).toBe(10)

    setId(2)
    flushSync()
    await tick()
    flushSync()
    expect(res()).toBe(20)
    expect(seen).toEqual([1, 2])
    dispose()
  })

  it('skips fetching while the source is false/null', async () => {
    let dispose!: () => void
    const [ready, setReady] = signal<boolean>(false)
    let calls = 0
    const res = createRoot((d) => {
      dispose = d
      return createResource(
        () => (ready() ? 'go' : false),
        async (s) => {
          calls++
          return s.toUpperCase()
        },
      )
    })
    await tick()
    flushSync()
    expect(calls).toBe(0)
    expect(res()).toBeUndefined()
    expect(res.loading()).toBe(false)

    setReady(true)
    flushSync()
    await tick()
    flushSync()
    expect(calls).toBe(1)
    expect(res()).toBe('GO')
    dispose()
  })

  it('mutate() sets the value immediately and cancels an in-flight fetch', async () => {
    let dispose!: () => void
    let resolveFetch!: (v: string) => void
    const res = createRoot((d) => {
      dispose = d
      return createResource(
        () => true,
        () => new Promise<string>((r) => (resolveFetch = r)),
      )
    })
    flushSync()
    expect(res.loading()).toBe(true)

    res.mutate('local')
    flushSync()
    expect(res()).toBe('local')
    expect(res.loading()).toBe(false)

    // A late resolution of the superseded fetch must NOT overwrite the mutation.
    resolveFetch('stale')
    await tick()
    flushSync()
    expect(res()).toBe('local')
    dispose()
  })

  it('refetch() re-runs the fetcher and returns the new value', async () => {
    let dispose!: () => void
    let n = 0
    const res = createRoot((d) => {
      dispose = d
      return createResource(
        () => true,
        async () => ++n,
      )
    })
    await tick()
    flushSync()
    expect(res()).toBe(1)

    const p = res.refetch()
    flushSync()
    await tick()
    flushSync()
    await expect(p).resolves.toBe(2)
    expect(res()).toBe(2)
    dispose()
  })
})
