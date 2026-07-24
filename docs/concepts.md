# Concepts

How coyote-js actually works, and why it's shaped this way. Read this once and the
API stops needing memorization.

---

## Components run once

In a VDOM framework, a state change re-runs your component function, produces a
new tree, diffs it against the old one, and patches the difference. The component
body is the unit of update.

In coyote-js, the component body is **setup code**. It runs a single time, builds
real DOM nodes, and wires reactive bindings into the specific positions that can
change. After that it never runs again.

```tsx
function Counter() {
  console.log('once')                    // ← logs one time, ever
  const [n, setN] = signal(0)
  return <button onClick={() => setN(n() + 1)}>{n}</button>
}
```

Clicking the button writes to one text node. Nothing is diffed, no tree is walked,
no component is re-invoked.

This has consequences worth stating plainly:

- **No dependency arrays.** Dependencies are captured by *reading* a signal inside
  a tracking scope. There is nothing to declare and nothing to get wrong.
- **No memoization API.** There is no `memo`, no `useCallback`. A component that
  runs once cannot waste work re-running.
- **No stale-closure class of bug.** A closure over `n` in an event handler reads
  `n()` when it fires, not a value captured at render time.
- **But: props are not values.** Destructuring `props` freezes them. Local
  variables computed in the body are computed once. Anything that must change has
  to be a function.

That last point is the whole trade. You give up "just write JavaScript, it
re-runs" in exchange for never re-running.

---

## The one rule

> **A function value is a live binding. Anything else is written once.**

This holds everywhere the renderer looks at a value:

```tsx
<span>{count}</span>                     // live: the accessor IS the binding
<span>{() => count() * 2}</span>         // live: an expression in a thunk
<span>{count()}</span>                   // static: a number was passed

<div class={() => on() ? 'a' : 'b'} />   // live
<div class="a" />                        // static

<For each={items}>…</For>                // live: `items` is an accessor
<Show when={() => n() > 3}>…</Show>      // live
```

The single exception is `on*` props: an event handler is used as-is and is never
called reactively. `onClick={fn}` registers `fn`; it does not evaluate it.

---

## The reactive graph

Three node kinds, one graph:

| | Runs | Memoized | Purpose |
| --- | --- | --- | --- |
| **signal** | never (it's a source) | — | Holds a value |
| **computed** | lazily, on read after a source changed | yes | Derives a value |
| **effect** | eagerly, on flush after a source changed | no | Touches the outside world |

Reading a signal inside a computed or effect **subscribes** the reader. That's the
entire dependency mechanism — no declarations, no arrays.

### Propagation

When you write a signal:

1. **Push marking.** Direct observers are marked `STALE`; everything transitively
   downstream is marked `CHECK`. A microtask flush is scheduled.
2. **Pull on read.** Reading a node walks its sources in dependency order. A
   `CHECK` node recomputes only if one of its sources actually produced a new
   value.
3. **Equality gate.** A computed whose recomputation yields an equal value
   (`Object.is` by default) stops propagating right there.
4. **Flush.** Queued effects run once per microtask, or immediately on
   `flushSync()`.

The two-tier `STALE`/`CHECK` marking is what makes diamonds correct:

```
      [a]
     /   \
  [b]     [c]        `d` runs ONCE per change to `a` — never twice,
     \   /           and never with a mix of old and new inputs.
      [d]
```

A naive push-only system would run `d` twice (once per parent). A naive pull-only
system would need to re-derive the whole graph. The hybrid does neither.

### Sync writes, batched effects

Reads are always fresh; only *effects* are deferred.

```ts
setCount(5)
count()        // 5 — immediately
// the effect that logs count() has not run yet

flushSync()    // now it runs, once
```

Inside a `batch`, the same holds: reads pull current values, and the effect flush
waits for the outermost batch to close.

---

## Ownership

Every reaction runs under an **owner** — a disposal scope. Owners form a tree.
Disposing one runs its cleanups (LIFO) and disposes everything created under it,
recursively.

```
createRoot (from render())
 └─ component scope
     ├─ effect (a text slot)
     ├─ effect (an attribute binding)
     └─ For row scope
         ├─ effect
         └─ onCleanup
```

You rarely touch this directly. It's why:

- An `effect` created in a component disposes on unmount, with no bookkeeping.
- `onCleanup` knows what to attach to.
- Removing one `<For>` row runs *that row's* cleanups and nothing else.
- `useContext` can find a provider — it walks the same owner chain.

Two cases where it becomes visible:

**Reactive work outside a component tree** needs its own root:

```ts
const stop = createRoot(dispose => {
  effect(() => sync(state()))
  return dispose
})
stop()
```

**An `await` loses the owner.** Capture it first, re-enter it after:

```ts
const owner = getOwner()
const data = await load()
runWithOwner(owner, () => effect(() => draw(data)))
```

---

## Rendering: real nodes, live slots

`<div>` evaluates to an `HTMLDivElement`. There is no intermediate representation
to diff — the "diff" already happened at compile time, when the compiler decided
which positions are dynamic.

A dynamic position becomes a **slot**: two comment anchors and an effect. When the
effect re-runs, it clears the DOM between its anchors and inserts the new content.

```html
<p><!--#-->42<!--/#--> items</p>
```

Because each slot has its own effect, a change to one binding cannot re-run
another. Nesting composes: a slot whose result contains more functions gives each
of those its own child slot, so the parent only re-runs when its *own* reads
change.

### Control flow keeps scopes alive

`<For>`, `<Show>`, `<Switch>` and friends mount each row or branch under its own
child scope, parented at a stable owner captured when the component was first
invoked — not at whatever owner happens to be current during a re-run.

That is what makes this work:

- A `<For>` row that survives an update keeps its DOM node **and** its effects,
  signals, and cleanups.
- A removed row's cleanups fire exactly when it is removed — not when a sibling
  changes, not when the enclosing slot re-runs.
- A `<Show>` that flips back and forth mounts a genuinely fresh scope each time.

---

## `For` vs `Index`

Both render lists; they differ in what a "row" is identified by.

**`For` keys by object identity.** An item that is `===` to one from the previous
render reuses its row wholesale. New items mount, missing items dispose, reorders
re-emit existing nodes in the new order. The index is an `Accessor<number>`,
because a row can move.

**`Index` keys by position.** Row `i` always represents position `i`. When the
value at a position changes, the row is reused and its accessor updates — rows are
created and destroyed only as the list **length** changes. The item is an
`Accessor<T>`; the index is a plain number.

```
items: [A, B, C]  →  [C, A, B]

For:    3 rows reused, reordered.        0 rebuilds.
Index:  3 rows kept, each row's value accessor updated.  0 rebuilds, but
        row 0 now *is* C — anything keyed to "the row for A" moved.
```

Rule of thumb: **objects → `For`, primitives → `Index`.**

---

## Signals vs stores

A signal is one cell. Replacing its value notifies every reader.

A store is a proxy over an object tree where **each property has its own signal**,
created lazily on first read. Reading `state.user.name` subscribes to that leaf
alone.

```ts
const [s]  = createStore({ user: { name: 'Ada', age: 36 } })
effect(() => console.log(s.user.name))
set('user', 'age', 37)     // effect does NOT run
set('user', 'name', 'G')   // effect runs
```

For a 500-row table, that's the difference between "one cell changed, one text node
updated" and "the array reference changed, every reader woke up."

Stores are read-only through property access — every write goes through the
path-based setter, `produce`, or `reconcile`. That constraint is what guarantees
no mutation escapes observation.

---

## Async: resources and Suspense

`createResource(source, fetcher)` ties an async call to a reactive source. When
the source changes it refetches; stale responses are dropped by token comparison
(last write wins); the value, `loading`, and `error` are all signals.

A source that yields `false`/`null`/`undefined` means **not ready** — the fetch is
skipped. That's how you express "don't load orders until we know the user":

```ts
createResource(() => user()?.id ?? false, id => api(`/users/${id}/orders`))
```

`<Suspense>` is a counter on a context. Each in-flight resource holds one pending
unit; the boundary shows its fallback while the count is above zero.

The subtle part: while pending, the boundary **does not unmount its children**. It
parks them — anchors and all — in an off-document holder. A resource that settles
mid-suspend therefore still has a live parent to render into, and a lazy route
resolves correctly instead of vanishing. When the count hits zero the whole range
moves back into the live tree, fully built. No wrapper element is introduced, so
structural CSS is unaffected.

---

## Workers as a first-class layer

Most frameworks treat workers as an escape hatch you wire by hand. coyote-js
treats a worker as a **typed module you happen to call across a thread boundary**.

```ts
// worker
const api = { crunch: (d: Float64Array) => heavy(d) }
export type Api = typeof api
defineWorker(api)

// main
const w = spawn<Api>(() => new Worker(new URL('./w.ts', import.meta.url), { type: 'module' }))
await w.crunch(data)   // typed, checked at compile time
```

`Remote<T>` is a mapped type over your API: every method becomes a Promise, and an
async-generator method becomes something that is simultaneously awaitable and
async-iterable. The main thread never has to know which shape a method has — one
handle adapts to whichever frames come back for its request id.

`pool` puts N workers behind the same proxy with backpressure-aware routing: each
call goes to the worker with the fewest in-flight invocations, so one slow call
can't starve the rest.

---

## Design principles

**Fine-grained by default.** The framework should update the smallest thing that
changed. Everything else — no VDOM, per-property store signals, per-slot effects —
follows from that.

**No compiler requirement.** The only build step is standard automatic JSX, which
every bundler already supports. There is no custom transform, no macro, no
framework-specific plugin. You can write hyperscript and skip JSX entirely.

**Types as the contract.** `Remote<T>`, `Resource<T>`, `Store<T>`, `Accessor<T>` —
the type system carries the semantics. A worker call with a wrong argument is a
compile error.

**Explicit ownership.** Scopes are real objects with a real tree. Cleanup is
deterministic, and you can always answer "when does this get torn down?"

**Zero runtime dependencies.** Nothing to audit, nothing to break, nothing dragged
into your bundle that you didn't ask for.

---

## If you're coming from…

**SolidJS.** You already know this model — the primitives are deliberately
familiar. Differences: `signal` returns a tuple like Solid but is named `signal`,
not `createSignal`; `computed` is Solid's `createMemo`; `effect` is
`createEffect`. `createResource` takes `(source, fetcher)` and returns a callable
resource, same as Solid. The extras — typed worker RPC, the store's `defineStore`,
the WASM loader — have no Solid equivalent.

**React.** Signals replace `useState`, `computed` replaces `useMemo`, `effect`
replaces `useEffect` (with no dependency array). The mental shift is that
components don't re-render — see [Components run once](#components-run-once).
`onCleanup` is the return value of `useEffect`, but it works anywhere.

**Vue.** `signal()` is `ref()` with explicit call syntax instead of `.value`;
`computed` matches; `effect` is `watchEffect`. `createStore` is closest to
`reactive()`, and `defineStore` is deliberately Pinia-shaped.

---

**Next:** [Getting started →](./getting-started.md) · [API reference →](./reactivity.md)
