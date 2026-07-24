# `@sinistermage/coyote-js/reactivity`

The reactive core. Everything else in coyote-js is built on these eight functions.

```ts
import {
  signal, computed, effect,
  batch, untrack, flushSync,
  createRoot, getOwner, runWithOwner, onCleanup,
} from '@sinistermage/coyote-js/reactivity'
```

Zero dependencies, no compiler magic, no VDOM. A signal is a value plus a
subscriber list; a computed is a memoized derivation; an effect is a side effect
that re-runs when what it read changes.

---

## `signal`

```ts
function signal<T>(value: T, opts?: SignalOptions<T>): Signal<T>
function signal<T>(): Signal<T | undefined>

type Signal<T> = [get: Accessor<T>, set: Setter<T>]
type Accessor<T> = () => T
type Setter<T> = (v: T | ((prev: T) => T)) => T
```

Creates a reactive source as a `[get, set]` tuple.

```ts
const [count, setCount] = signal(0)

count()          // 0 — reading inside an effect/computed subscribes the reader
setCount(1)      // 1 — returns the stored value
setCount(n => n + 1)   // 2 — updater form receives the previous value
```

### Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `equals` | `false \| ((a, b) => boolean)` | `Object.is` | Change test. `false` means *never equal* — every write notifies. |
| `name` | `string` | — | Debug label. |

Writes are **equality-gated**: a write whose value is `equals` to the current one
neither stores nor notifies.

```ts
// Mutating the same array in place: opt out of equality so writes always notify.
const [items, setItems] = signal<string[]>([], { equals: false })

// Custom comparison — notify only when the id actually changes.
const [user, setUser] = signal(u, { equals: (a, b) => a.id === b.id })
```

---

## `computed`

```ts
function computed<T>(
  fn: (prev: T | undefined) => T,
  seed?: T,
  opts?: SignalOptions<T>,
): Accessor<T>
```

A memoized derived value. It is **lazy**: `fn` does not run until the accessor is
first read, then re-runs only when read *after* one of its tracked sources
changed.

```ts
const [first, setFirst] = signal('Ada')
const [last,  setLast]  = signal('Lovelace')

const full = computed(() => `${first()} ${last()}`)

full()   // 'Ada Lovelace'  — computes now
full()   // 'Ada Lovelace'  — cached, fn does not re-run
```

`fn` receives the previous value, which makes accumulators easy:

```ts
const highWater = computed<number>(prev => Math.max(prev ?? 0, level()), 0)
```

A computed only propagates to *its* observers when its value actually changes
(equality-gated, same options as `signal`). That is what makes diamond graphs
recompute downstream nodes exactly once:

```
      [a]
     /   \
  [b]     [c]        d re-runs ONCE per change to a, not twice.
     \   /
      [d]
```

---

## `effect`

```ts
function effect<T>(
  fn: (prev: T | undefined) => T,
  seed?: T,
  opts?: EffectOptions,
): void
```

A side effect that re-runs when a tracked source changes.

```ts
const [count, setCount] = signal(0)

effect(() => {
  console.log('count is', count())
})
// logs "count is 0" immediately

setCount(1)
// logs "count is 1" on the next microtask
```

### Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `defer` | `boolean` | `false` | Skip the immediate first run; subscribe and react only from the next flush onward. |
| `name` | `string` | — | Debug label. |

### Timing

- The **initial run is synchronous** (unless `defer: true`, or you are inside a
  `batch`, in which case it runs when the batch closes).
- **Change-driven re-runs are microtask-batched.** Several writes in the same tick
  re-run each dependent effect once. Call `flushSync()` to force the queue now.

```ts
setCount(1)
setCount(2)
setCount(3)
// effect has not re-run yet
flushSync()
// logs "count is 3" — once
```

### Disposal

`effect` returns `void` — it has no disposer of its own. Its lifetime is its
**owner's** lifetime:

- Inside a component, the renderer's scope disposes it on unmount.
- At the top level, wrap it in [`createRoot`](#createroot) and call `dispose()`.
- Register teardown with [`onCleanup`](#oncleanup) — it runs before each re-run
  *and* on disposal.

```ts
effect(() => {
  const id = setInterval(tick, 1000)
  onCleanup(() => clearInterval(id))
})
```

---

## `batch`

```ts
function batch<T>(fn: () => T): T
```

Coalesce writes: effects do not flush until the outermost batch closes, so
multiple sets trigger each dependent effect **at most once**.

```ts
batch(() => {
  setFirst('Grace')
  setLast('Hopper')
})   // dependents re-run once, not twice
```

Reads inside a batch still pull **fresh** values — batching defers the effect
flush, never correctness:

```ts
batch(() => {
  setCount(5)
  count()        // 5, not the old value
  full()         // recomputed from the new inputs
})
```

## `untrack`

```ts
function untrack<T>(fn: () => T): T
```

Read without subscribing. Use it when an effect needs a value but should not
re-run when that value changes.

```ts
effect(() => {
  // re-runs when `query` changes, but NOT when `page` changes
  search(query(), untrack(page))
})
```

## `flushSync`

```ts
function flushSync(): void
```

Run the pending effect queue right now instead of on the next microtask. Mainly
for tests and for code that must observe the DOM immediately after a write.

```ts
setCount(1)
flushSync()
expect(el.textContent).toBe('1')
```

---

## Ownership and cleanup

Every reaction runs under an **owner** — a disposal scope. Disposing an owner runs
its cleanups and disposes everything created under it, recursively.

### `createRoot`

```ts
function createRoot<T>(fn: (dispose: () => void) => T): T
```

Creates a **detached** root scope that lives until you dispose it. This is how you
own reactive work outside a component tree.

```ts
const stop = createRoot(dispose => {
  effect(() => console.log(count()))
  return dispose
})

stop()   // tears down the effect and every cleanup registered under it
```

### `onCleanup`

```ts
function onCleanup(fn: () => void): void
```

Registers a teardown on the current owner scope. Cleanups run **LIFO**, both when
the owning reaction re-executes and when its owner is disposed. Calling it with no
owner in scope is a no-op.

```ts
effect(() => {
  const ws = new WebSocket(url())
  onCleanup(() => ws.close())   // runs before the next re-run and on dispose
})
```

### `getOwner` / `runWithOwner`

```ts
function getOwner(): Owner | null
function runWithOwner<T>(owner: Owner | null, fn: () => T): T
```

An `await` loses the current owner. Capture it before, re-enter it after, and
reactions created in the continuation attach to the right scope:

```ts
const owner = getOwner()

const data = await fetchThing()

runWithOwner(owner, () => {
  effect(() => render(data))   // owned correctly, disposes on unmount
})
```

`runWithOwner` suppresses tracking (no current observer), so reads inside `fn`
do not subscribe anything.

---

## How propagation works

Understanding this is optional, but it explains the guarantees above.

1. **Push marking.** A write marks direct observers `STALE` and everything
   transitively downstream `CHECK`, then schedules a microtask flush.
2. **Pull on read.** Reading a node runs `updateIfNecessary`, which walks its
   sources in dependency order. A `CHECK` node recomputes only if one of its
   sources actually produced a new value.
3. **Equality gate.** A computed whose recomputation yields an `equals` value stops
   propagating there — downstream nodes stay clean.
4. **Batched flush.** Queued effects run once per microtask (or on `flushSync`).

The two-tier `STALE`/`CHECK` marking is what gives you glitch-free diamonds: a
node is never observed with a mix of old and new inputs, and never recomputes
twice for one logical change.

---

## Types

```ts
type Accessor<T> = () => T
type Setter<T>   = (v: T | ((prev: T) => T)) => T
type Signal<T>   = [get: Accessor<T>, set: Setter<T>]

interface SignalOptions<T> {
  equals?: false | ((a: T, b: T) => boolean)
  name?: string
}

interface EffectOptions {
  name?: string
  defer?: boolean
}

interface Owner { readonly __coyote: 'owner' }   // opaque
```

---

## Gotchas

**Call your accessors.** `count` is the getter; `count()` is the value. Passing
`count` around keeps it reactive; calling it captures a snapshot.

```ts
effect(() => console.log(count))     // ✗ logs the function, subscribes to nothing
effect(() => console.log(count()))   // ✓
```

**Destructuring props loses reactivity.** `const { value } = props` reads once.
Keep the access lazy: `props.value`, or pass an accessor.

**Writing inside an effect can loop.** If an effect writes a signal it also reads,
it will re-trigger itself. Wrap the read in `untrack` when it is meant to be an
input, not a dependency.

---

**Next:** [DOM & JSX →](./dom.md) · [Concepts →](./concepts.md)
