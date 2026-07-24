import { afterEach, describe, expect, it, vi } from 'vitest'
// Store primitives from the local module.
import {
  createStore,
  defineStore,
  produce,
  reconcile,
  useStore,
  __resetStoresForTests,
} from './store'
// Reactivity from the sibling reactivity module.
import { effect, flushSync } from '../reactivity'

afterEach(() => {
  __resetStoresForTests()
})

describe('createStore — reads & writes', () => {
  it('exposes the initial state through the proxy', () => {
    const [state] = createStore({ count: 0, nested: { label: 'hi' } })
    expect(state.count).toBe(0)
    expect(state.nested.label).toBe('hi')
  })

  it('set(key, value) updates a leaf', () => {
    const [state, set] = createStore({ count: 0 })
    set('count', 5)
    expect(state.count).toBe(5)
  })

  it('set(key, updaterFn) applies a functional update', () => {
    const [state, set] = createStore({ count: 10 })
    set('count', (c: number) => c + 3)
    expect(state.count).toBe(13)
  })

  it('set(path..., value) updates a nested leaf', () => {
    const [state, set] = createStore({ a: { b: { c: 1 } } })
    set('a', 'b', 'c', 42)
    expect(state.a.b.c).toBe(42)
  })

  it('set(partial) merges an object into the root', () => {
    const [state, set] = createStore({ a: 1, b: 2, c: 3 })
    set({ a: 10, c: 30 })
    expect(state.a).toBe(10)
    expect(state.b).toBe(2)
    expect(state.c).toBe(30)
  })

  it('returns a stable proxy for a nested object across reads', () => {
    const [state] = createStore({ nested: { x: 1 } })
    expect(state.nested).toBe(state.nested)
  })

  it('rewraps a nested object when its identity is replaced', () => {
    const [state, set] = createStore<{ nested: { x: number } }>({ nested: { x: 1 } })
    const before = state.nested
    set('nested', { x: 2 })
    expect(state.nested).not.toBe(before)
    expect(state.nested.x).toBe(2)
  })

  it('is read-only through property assignment', () => {
    const [state] = createStore<{ count: number }>({ count: 0 })
    expect(() => {
      ;(state as { count: number }).count = 9
    }).toThrow(/read-only/)
  })
})

describe('createStore — fine-grained reactivity', () => {
  it('re-runs an effect that reads a path when that path changes', () => {
    const [state, set] = createStore({ a: { b: 1 } })
    const spy = vi.fn(() => state.a.b)
    effect(spy)
    flushSync()
    expect(spy).toHaveBeenCalledTimes(1)

    set('a', 'b', 2)
    flushSync()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('does NOT re-run an effect reading a sibling path', () => {
    const [state, set] = createStore({ a: 1, b: 2 })
    const aSpy = vi.fn(() => state.a)
    const bSpy = vi.fn(() => state.b)
    effect(aSpy)
    effect(bSpy)
    flushSync()
    expect(aSpy).toHaveBeenCalledTimes(1)
    expect(bSpy).toHaveBeenCalledTimes(1)

    set('a', 100) // touch only `a`
    flushSync()
    expect(aSpy).toHaveBeenCalledTimes(2)
    expect(bSpy).toHaveBeenCalledTimes(1) // sibling untouched
  })

  it('does NOT re-run an effect reading a sibling NESTED path', () => {
    const [state, set] = createStore({ user: { name: 'x', age: 1 } })
    const nameSpy = vi.fn(() => state.user.name)
    const ageSpy = vi.fn(() => state.user.age)
    effect(nameSpy)
    effect(ageSpy)
    flushSync()

    set('user', 'age', 2)
    flushSync()
    expect(ageSpy).toHaveBeenCalledTimes(2)
    expect(nameSpy).toHaveBeenCalledTimes(1) // name unaffected
  })

  it('an equal (Object.is) write is a no-op — no re-run', () => {
    const [state, set] = createStore({ count: 5 })
    const spy = vi.fn(() => state.count)
    effect(spy)
    flushSync()
    expect(spy).toHaveBeenCalledTimes(1)

    set('count', 5) // same value
    flushSync()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('batches a multi-key merge into one re-run per dependent', () => {
    const [state, set] = createStore({ a: 1, b: 2 })
    const spy = vi.fn(() => `${state.a}-${state.b}`)
    effect(spy)
    flushSync()
    expect(spy).toHaveBeenCalledTimes(1)

    set({ a: 10, b: 20 }) // two keys, one batch
    flushSync()
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy).toHaveLastReturnedWith('10-20')
  })

  it('tracks a subtree so a deep replace re-runs a subtree reader', () => {
    const [state, set] = createStore<{ list: { id: number }[] }>({ list: [{ id: 1 }] })
    const spy = vi.fn(() => state.list.length)
    effect(spy)
    flushSync()
    expect(spy).toHaveBeenCalledTimes(1)

    set('list', [{ id: 1 }, { id: 2 }])
    flushSync()
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy).toHaveLastReturnedWith(2)
  })

  it('set(list, index, value) is fine-grained per array element', () => {
    // Regression: the setter carries a numeric index while the get-trap sees the
    // string form — both must resolve to the same signal, or writes silently
    // miss readers.
    const [state, set] = createStore<{ list: number[] }>({ list: [1, 2, 3] })
    const s0 = vi.fn(() => state.list[0])
    const s1 = vi.fn(() => state.list[1])
    effect(s0)
    effect(s1)
    flushSync()

    set('list', 1, 99)
    flushSync()
    expect(state.list[1]).toBe(99)
    expect(s1).toHaveBeenCalledTimes(2)
    expect(s0).toHaveBeenCalledTimes(1) // sibling index untouched
  })

  it('set(list, index, key, value) updates a nested field inside an array item', () => {
    const [state, set] = createStore<{ list: { name: string }[] }>({
      list: [{ name: 'a' }],
    })
    const spy = vi.fn(() => state.list[0].name)
    effect(spy)
    flushSync()

    set('list', 0, 'name', 'z')
    flushSync()
    expect(state.list[0].name).toBe('z')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('adding a new key re-runs a key-enumeration reader', () => {
    const [state, set] = createStore<Record<string, number>>({ a: 1 })
    const spy = vi.fn(() => Object.keys(state).join(','))
    effect(spy)
    flushSync()
    expect(spy).toHaveLastReturnedWith('a')

    set('b', 2)
    flushSync()
    expect(spy).toHaveLastReturnedWith('a,b')
  })
})

describe('produce', () => {
  it('applies an in-place mutation via the setter', () => {
    const [state, set] = createStore({ count: 0, items: [1, 2] })
    set(produce((s: { count: number; items: number[] }) => {
      s.count += 5
      s.items.push(3)
    }))
    expect(state.count).toBe(5)
    expect(state.items).toEqual([1, 2, 3])
  })

  it('fires index and length readers after an in-place array push', () => {
    const [state, set] = createStore<{ list: number[] }>({ list: [1] })
    const lenSpy = vi.fn(() => state.list.length)
    effect(lenSpy)
    flushSync()

    set('list', produce((l: number[]) => {
      l.push(2)
    }))
    flushSync()
    expect(state.list).toEqual([1, 2])
    expect(lenSpy).toHaveLastReturnedWith(2)
  })

  it('notifies readers of the touched top-level keys', () => {
    const [state, set] = createStore({ count: 0, other: 'x' })
    const countSpy = vi.fn(() => state.count)
    const otherSpy = vi.fn(() => state.other)
    effect(countSpy)
    effect(otherSpy)
    flushSync()

    set(produce((s: { count: number }) => {
      s.count = 9
    }))
    flushSync()
    expect(countSpy).toHaveBeenCalledTimes(2)
    expect(otherSpy).toHaveBeenCalledTimes(1) // untouched key
  })
})

describe('reconcile', () => {
  it('merges next into current, replacing changed leaves', () => {
    const [state, set] = createStore<{ profile: { name: string; age: number } }>({
      profile: { name: 'A', age: 1 },
    })
    set('profile', reconcile({ name: 'A', age: 2 }))
    expect(state.profile.name).toBe('A')
    expect(state.profile.age).toBe(2)
  })

  it('only fires readers of the fields that actually changed', () => {
    const [state, set] = createStore<{ profile: { name: string; age: number } }>({
      profile: { name: 'A', age: 1 },
    })
    const nameSpy = vi.fn(() => state.profile.name)
    const ageSpy = vi.fn(() => state.profile.age)
    effect(nameSpy)
    effect(ageSpy)
    flushSync()

    set('profile', reconcile({ name: 'A', age: 2 }))
    flushSync()
    expect(ageSpy).toHaveBeenCalledTimes(2)
    expect(nameSpy).toHaveBeenCalledTimes(1) // name identical ⇒ no re-run
  })

  it('deletes a key absent from next and re-runs enumeration', () => {
    const [state, set] = createStore<{ o: Record<string, number> }>({
      o: { a: 1, b: 2 },
    })
    const spy = vi.fn(() => Object.keys(state.o).join(','))
    effect(spy)
    flushSync()
    expect(spy).toHaveLastReturnedWith('a,b')

    set('o', reconcile({ a: 1 }))
    flushSync()
    expect(state.o.b).toBeUndefined()
    expect(spy).toHaveLastReturnedWith('a')
  })

  it('keys arrays of objects to preserve identity on reorder', () => {
    const [state, set] = createStore<{ list: { id: number; v: number }[] }>({
      list: [
        { id: 1, v: 10 },
        { id: 2, v: 20 },
      ],
    })
    // Read a specific element's field.
    const spy = vi.fn(() => state.list[0].v)
    effect(spy)
    flushSync()

    // Reconcile with the same data but a fresh array/object — keyed by id, so
    // the unchanged element keeps its value and its reader does not re-run.
    set('list', reconcile([
      { id: 1, v: 10 },
      { id: 2, v: 20 },
    ]))
    flushSync()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('defineStore — memoized singleton', () => {
  it('returns the same instance across calls', () => {
    const useCounter = defineStore('counter', () => {
      const [state, set] = createStore({ count: 0 })
      return {
        state,
        actions: {
          inc: () => set('count', (c: number) => c + 1),
        },
      }
    })
    const a = useCounter()
    const b = useCounter()
    expect(a).toBe(b)
    expect(a.state).toBe(b.state)
    expect(a.actions).toBe(b.actions)
  })

  it('runs setup exactly once (lazily, on first call)', () => {
    const setup = vi.fn(() => ({ state: { n: 1 }, actions: {} }))
    const useThing = defineStore('thing', setup)
    expect(setup).not.toHaveBeenCalled() // lazy
    useThing()
    useThing()
    useThing()
    expect(setup).toHaveBeenCalledTimes(1)
  })

  it('shares reactive state across consumers', () => {
    const useCounter = defineStore('shared', () => {
      const [state, set] = createStore({ count: 0 })
      return { state, actions: { inc: () => set('count', (c: number) => c + 1) } }
    })
    const one = useCounter()
    const two = useCounter()
    const spy = vi.fn(() => two.state.count)
    effect(spy)
    flushSync()

    one.actions.inc()
    flushSync()
    expect(two.state.count).toBe(1)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('exposes exactly { state, actions }', () => {
    const useThing = defineStore('shape', () => ({
      state: { a: 1 },
      actions: { noop: () => {} },
    }))
    const api = useThing()
    expect(Object.keys(api).sort()).toEqual(['actions', 'state'])
  })
})

describe('useStore — factory memoization', () => {
  it('memoizes by factory identity', () => {
    const factory = () => ({ token: Math.random() })
    const a = useStore(factory)
    const b = useStore(factory)
    expect(a).toBe(b)
  })

  it('distinct factories produce distinct instances', () => {
    const a = useStore(() => ({ x: 1 }))
    const b = useStore(() => ({ x: 1 }))
    expect(a).not.toBe(b)
  })
})
