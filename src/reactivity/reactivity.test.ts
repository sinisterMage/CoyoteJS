import { describe, expect, it, vi } from 'vitest'
// Imported from the local barrel, which re-exports the full public surface.
import {
  batch,
  computed,
  createRoot,
  effect,
  flushSync,
  getOwner,
  onCleanup,
  runWithOwner,
  signal,
  untrack,
} from './index'

// A microtask tick, for asserting the default (non-flushSync) scheduling path.
const tick = () => Promise.resolve()

describe('signal', () => {
  it('reads and writes a value', () => {
    const [get, set] = signal(1)
    expect(get()).toBe(1)
    expect(set(2)).toBe(2)
    expect(get()).toBe(2)
  })

  it('supports an updater function on set', () => {
    const [get, set] = signal(10)
    set((prev) => prev + 5)
    expect(get()).toBe(15)
    set((prev) => prev * 2)
    expect(get()).toBe(30)
  })

  it('defaults to undefined with no initial value', () => {
    const [get, set] = signal<number>()
    expect(get()).toBeUndefined()
    set(3)
    expect(get()).toBe(3)
  })

  it('equals:false always notifies (even for an identical value)', () => {
    const [get, set] = signal(1, { equals: false })
    const spy = vi.fn(() => get())
    effect(spy)
    expect(spy).toHaveBeenCalledTimes(1)
    set(1) // same value, but equals:false ⇒ notify
    flushSync()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('a default (Object.is) equal write is a no-op — no notification', () => {
    const [get, set] = signal(1)
    const spy = vi.fn(() => get())
    effect(spy)
    expect(spy).toHaveBeenCalledTimes(1)
    set(1) // Object.is(1,1) ⇒ suppressed
    flushSync()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('a custom equals can suppress notification', () => {
    // Treat values within 0.5 as equal.
    const [get, set] = signal(0, { equals: (a, b) => Math.abs(a - b) < 0.5 })
    const spy = vi.fn(() => get())
    effect(spy)
    expect(spy).toHaveBeenCalledTimes(1)
    set(0.2) // within tolerance ⇒ suppressed
    flushSync()
    expect(spy).toHaveBeenCalledTimes(1)
    set(1) // outside tolerance ⇒ notify
    flushSync()
    expect(spy).toHaveBeenCalledTimes(2)
  })
})

describe('computed', () => {
  it('memoizes: fn runs once for N reads', () => {
    const [a] = signal(2)
    const fn = vi.fn(() => a() * 10)
    const c = computed(fn)
    expect(c()).toBe(20)
    expect(c()).toBe(20)
    expect(c()).toBe(20)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('is lazy: does not run until first read', () => {
    const [a] = signal(1)
    const fn = vi.fn(() => a() + 1)
    computed(fn)
    expect(fn).not.toHaveBeenCalled()
  })

  it('recomputes when a source changes (on next read)', () => {
    const [a, setA] = signal(1)
    const fn = vi.fn(() => a() * 2)
    const c = computed(fn)
    expect(c()).toBe(2)
    setA(5)
    expect(c()).toBe(10)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('receives its previous value via prev', () => {
    const [a, setA] = signal(1)
    const seen: (number | undefined)[] = []
    const c = computed<number>((prev) => {
      seen.push(prev)
      return a()
    }, undefined)
    c()
    setA(2)
    c()
    expect(seen).toEqual([undefined, 1])
  })

  it('custom equals gates downstream recompute', () => {
    const [a, setA] = signal(0)
    // Bucket into tens: 0..9 → 0, 10..19 → 1, ...
    const bucket = computed(() => Math.floor(a() / 10))
    const downstream = vi.fn(() => bucket())
    const d = computed(downstream)
    expect(d()).toBe(0)
    setA(5) // still bucket 0
    expect(d()).toBe(0)
    expect(downstream).toHaveBeenCalledTimes(1) // bucket unchanged ⇒ no rerun
    setA(15) // bucket 1
    expect(d()).toBe(1)
    expect(downstream).toHaveBeenCalledTimes(2)
  })
})

describe('effect', () => {
  it('runs immediately on creation, then re-runs on change', () => {
    const [a, setA] = signal(1)
    const spy = vi.fn(() => a())
    effect(spy)
    expect(spy).toHaveBeenCalledTimes(1) // immediate
    setA(2)
    flushSync()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('defer:true skips the immediate run', async () => {
    const [a, setA] = signal(0)
    const spy = vi.fn(() => a())
    effect(spy, undefined, { defer: true })
    expect(spy).toHaveBeenCalledTimes(0) // immediate run skipped
    flushSync() // deferred first run subscribes here
    expect(spy).toHaveBeenCalledTimes(1)
    setA(1)
    flushSync()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('flushes via the microtask queue without flushSync', async () => {
    const [a, setA] = signal(0)
    const spy = vi.fn(() => a())
    effect(spy)
    expect(spy).toHaveBeenCalledTimes(1)
    setA(1)
    expect(spy).toHaveBeenCalledTimes(1) // not yet — scheduled
    await tick()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('receives its previous return value', () => {
    const [a, setA] = signal(1)
    const seen: (number | undefined)[] = []
    effect<number>((prev) => {
      seen.push(prev)
      return a()
    })
    setA(2)
    flushSync()
    expect(seen).toEqual([undefined, 1])
  })
})

describe('batch', () => {
  it('coalesces multiple writes into a single effect run', () => {
    const [a, setA] = signal(0)
    const [b, setB] = signal(0)
    const spy = vi.fn(() => a() + b())
    effect(spy)
    expect(spy).toHaveBeenCalledTimes(1)
    batch(() => {
      setA(1)
      setB(2)
      setA(3)
    })
    expect(spy).toHaveBeenCalledTimes(2) // exactly once for the whole batch
    expect(a()).toBe(3)
    expect(b()).toBe(2)
  })

  it('reads inside a batch see current values (glitch-free)', () => {
    const [a, setA] = signal(1)
    const doubled = computed(() => a() * 2)
    let observed = -1
    batch(() => {
      setA(10)
      observed = doubled() // pull fresh mid-batch
    })
    expect(observed).toBe(20)
  })

  it('returns the callback result', () => {
    expect(batch(() => 42)).toBe(42)
  })
})

describe('untrack', () => {
  it('prevents subscription to reads inside it', () => {
    const [a, setA] = signal(0)
    const [b, setB] = signal(0)
    const spy = vi.fn(() => {
      a() // tracked
      untrack(() => b()) // NOT tracked
    })
    effect(spy)
    expect(spy).toHaveBeenCalledTimes(1)
    setB(1) // untracked ⇒ no rerun
    flushSync()
    expect(spy).toHaveBeenCalledTimes(1)
    setA(1) // tracked ⇒ rerun
    flushSync()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('returns the callback result', () => {
    const [a] = signal(7)
    expect(untrack(() => a())).toBe(7)
  })
})

describe('onCleanup', () => {
  it('runs LIFO before a re-run', () => {
    const [a, setA] = signal(0)
    const order: string[] = []
    effect(() => {
      a()
      onCleanup(() => order.push('first'))
      onCleanup(() => order.push('second'))
    })
    setA(1)
    flushSync()
    // Both cleanups from the first run fire (LIFO) before the second run.
    expect(order).toEqual(['second', 'first'])
  })

  it('runs on dispose', () => {
    const cleanup = vi.fn()
    const dispose = createRoot((d) => {
      effect(() => {
        onCleanup(cleanup)
      })
      return d
    })
    expect(cleanup).not.toHaveBeenCalled()
    dispose()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })
})

describe('createRoot', () => {
  it('returns the callback result', () => {
    const value = createRoot(() => 'hello')
    expect(value).toBe('hello')
  })

  it('dispose stops all reactions (spy count stays flat after a post-dispose write)', () => {
    const [a, setA] = signal(0)
    const spy = vi.fn(() => a())
    const dispose = createRoot((d) => {
      effect(spy)
      return d
    })
    expect(spy).toHaveBeenCalledTimes(1)
    setA(1)
    flushSync()
    expect(spy).toHaveBeenCalledTimes(2)
    dispose()
    setA(2)
    flushSync()
    expect(spy).toHaveBeenCalledTimes(2) // flat: no more reactions
  })

  it('disposes nested computeds too', () => {
    const [a, setA] = signal(1)
    const fn = vi.fn(() => a() * 2)
    let read!: () => number
    const dispose = createRoot((d) => {
      const c = computed(fn)
      read = c
      c() // realize it
      return d
    })
    expect(read()).toBe(2)
    dispose()
    setA(5)
    // After dispose the computed is torn down; it should not recompute.
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('reading a disposed computed is inert (no crash, no recompute)', () => {
    const [a, setA] = signal(2)
    const fn = vi.fn(() => a() * 10)
    let read!: () => number
    const dispose = createRoot((d) => {
      const c = computed(fn)
      read = c
      c()
      return d
    })
    expect(read()).toBe(20)
    dispose()
    setA(3) // would mark the dead node — must be a no-op, not a crash
    expect(() => read()).not.toThrow()
    expect(fn).toHaveBeenCalledTimes(1) // dead node never re-runs
  })
})

describe('ownership: getOwner / runWithOwner', () => {
  it('captures a scope and re-enters it for a deferred reaction', () => {
    const cleanup = vi.fn()
    let owner: ReturnType<typeof getOwner> = null
    const dispose = createRoot((d) => {
      owner = getOwner()
      return d
    })
    expect(owner).not.toBeNull()
    // Later (e.g. from an async callback) attach a cleanup to that scope.
    runWithOwner(owner, () => {
      onCleanup(cleanup)
    })
    expect(cleanup).not.toHaveBeenCalled()
    dispose()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('getOwner is null at the top level', () => {
    expect(getOwner()).toBeNull()
  })
})

describe('diamond', () => {
  it('recomputes the join node EXACTLY once per source change', () => {
    const [a, setA] = signal(1)
    const b = computed(() => a() + 1)
    const c = computed(() => a() + 2)
    const dFn = vi.fn(() => b() + c())
    const d = computed(dFn)

    expect(d()).toBe(1 + 1 + (1 + 2)) // 5
    expect(dFn).toHaveBeenCalledTimes(1)

    setA(10)
    expect(d()).toBe(10 + 1 + (10 + 2)) // 23
    expect(dFn).toHaveBeenCalledTimes(2) // exactly once more, not twice
  })

  it('drives a diamond through an effect exactly once per change', () => {
    const [a, setA] = signal(1)
    const b = computed(() => a() * 2)
    const c = computed(() => a() * 3)
    const spy = vi.fn(() => b() + c())
    effect(spy)
    expect(spy).toHaveBeenCalledTimes(1)
    setA(2)
    flushSync()
    expect(spy).toHaveBeenCalledTimes(2) // once, not twice
  })

  it('skips the join when the source change did not alter the branches', () => {
    const [a, setA] = signal(0)
    // Both branches bucket into the same equals-gated value.
    const b = computed(() => a() >= 0)
    const c = computed(() => a() >= 0)
    const dFn = vi.fn(() => `${b()}-${c()}`)
    const d = computed(dFn)
    expect(d()).toBe('true-true')
    expect(dFn).toHaveBeenCalledTimes(1)
    setA(5) // b/c both still true ⇒ d must not recompute
    expect(d()).toBe('true-true')
    expect(dFn).toHaveBeenCalledTimes(1)
  })
})

describe('dynamic dependencies', () => {
  it('conditional reads change which writes trigger a rerun', () => {
    const [cond, setCond] = signal(true)
    const [x, setX] = signal('x0')
    const [y, setY] = signal('y0')
    const seen: string[] = []
    effect(() => {
      seen.push(cond() ? x() : y())
    })
    expect(seen).toEqual(['x0'])

    // While cond is true, y is NOT a dependency.
    setY('y1')
    flushSync()
    expect(seen).toEqual(['x0']) // no rerun

    setX('x1')
    flushSync()
    expect(seen).toEqual(['x0', 'x1'])

    // Flip to the y branch.
    setCond(false)
    flushSync()
    expect(seen).toEqual(['x0', 'x1', 'y1'])

    // Now x is NOT a dependency; y is.
    setX('x2')
    flushSync()
    expect(seen).toEqual(['x0', 'x1', 'y1']) // no rerun
    setY('y2')
    flushSync()
    expect(seen).toEqual(['x0', 'x1', 'y1', 'y2'])
  })
})

describe('cycle detection', () => {
  it('throws (bounded) when two effects ping-pong writes forever', () => {
    // effect1 reads a, writes b; effect2 reads b, writes a. Each write dirties
    // the other, which re-runs and writes back — an unbounded cascade that
    // flushEffects must bound and report rather than hang.
    const [a, setA] = signal(0)
    const [b, setB] = signal(0)
    expect(() => {
      createRoot(() => {
        effect(() => {
          setB(a() + 1)
        })
        effect(() => {
          setA(b() + 1)
        })
      })
      flushSync()
    }).toThrow(/settle|cycl/i)
  })

  it('a self-writing effect settles (does not re-trigger within its own run)', () => {
    // Reading then writing the SAME signal inside one run does not re-enqueue
    // the effect (it is already dirty while executing), so this converges.
    const [a, setA] = signal(0)
    const spy = vi.fn(() => {
      setA(a() + 1)
    })
    expect(() => {
      effect(spy)
      flushSync()
    }).not.toThrow()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(a()).toBe(1)
  })
})

describe('nested reactions', () => {
  it('re-running an effect disposes reactions it created on the prior run', () => {
    const [outer, setOuter] = signal(0)
    const [inner, setInner] = signal(0)
    const innerSpy = vi.fn(() => inner())
    createRoot(() => {
      effect(() => {
        outer()
        // A nested effect is recreated every time the outer effect runs.
        effect(innerSpy)
      })
    })
    // One outer run ⇒ one nested effect ⇒ innerSpy ran once.
    expect(innerSpy).toHaveBeenCalledTimes(1)

    setInner(1)
    flushSync()
    expect(innerSpy).toHaveBeenCalledTimes(2) // the single live nested effect reran

    // Re-run the outer effect: the old nested effect is disposed and a fresh one
    // is created. Writing inner should still only trigger ONE nested effect.
    setOuter(1)
    flushSync()
    const afterOuter = innerSpy.mock.calls.length // fresh nested effect ran once

    setInner(2)
    flushSync()
    // Exactly one more call (the single current nested effect), proving the old
    // one was disposed and did not also fire.
    expect(innerSpy).toHaveBeenCalledTimes(afterOuter + 1)
  })
})
