<div align="center">

# coyote-js

**A from-scratch, TypeScript-native, fine-grained reactive UI framework.**

Signals · a no-VDOM JSX renderer · a client router · a typed worker-RPC pool · a fine-grained store

[![npm](https://img.shields.io/npm/v/@sinistermage/coyote-js.svg)](https://www.npmjs.com/package/@sinistermage/coyote-js)
[![license](https://img.shields.io/npm/l/@sinistermage/coyote-js.svg)](./LICENSE)
[![types](https://img.shields.io/badge/types-included-blue.svg)](https://www.typescriptlang.org/)
[![dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](./package.json)

[Getting started](./docs/getting-started.md) · [Concepts](./docs/concepts.md) · [API reference](./docs/README.md)

</div>

---

```tsx
import { signal } from '@sinistermage/coyote-js/reactivity'
import { render } from '@sinistermage/coyote-js/dom'

function Counter() {
  const [count, setCount] = signal(0)

  return (
    <button onClick={() => setCount(n => n + 1)}>
      clicked {count} times
    </button>
  )
}

render(() => <Counter />, document.getElementById('app')!)
```

`Counter` runs **once**. Clicking the button updates exactly one text node — no
re-render, no virtual DOM, no diff.

---

## Why coyote-js

**No virtual DOM.** `<div>` evaluates to a real `HTMLDivElement`. Dynamic positions
become live slots — two comment anchors and an effect — so an update writes to the
one text node or attribute that changed, not a reconciled tree.

**Components run once.** There is no re-render, so there are no dependency arrays,
no `memo`, no `useCallback`, and no stale-closure bugs. Dependencies are captured
by *reading* a signal.

**Batteries included, none required.** Routing, state, async data, workers, HTTP,
and a WASM loader ship in the box as separate entry points. `sideEffects: false`
plus per-module subpaths means you only bundle what you import.

**Workers are first-class.** Export an object from a worker file, call its methods
from the main thread with full type inference — including async generators that
stream. No `postMessage` switch statements.

**Zero runtime dependencies.** Every line — the reactive graph, the renderer, the
router, the store, the RPC protocol — is written from scratch in this repo.

**No compiler.** The only build step is standard automatic JSX, which every
bundler already supports. No custom transform, no macro, no framework plugin.
Prefer hyperscript? `h` is right there.

---

## Install

```bash
npm install @sinistermage/coyote-js
```

Point the automatic JSX runtime at coyote in `tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@sinistermage/coyote-js"
  }
}
```

…and in your bundler:

```ts
// vite.config.ts
export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: '@sinistermage/coyote-js' },
  worker: { format: 'es' },   // only if you use the worker module
})
```

That's the whole setup. → [Full walkthrough](./docs/getting-started.md)

---

## The one rule

> **A function value is a live binding. Anything else is written once.**

```tsx
<span>{count}</span>              {/* ✓ live — the accessor is the binding */}
<span>{() => count() * 2}</span>  {/* ✓ live — an expression in a thunk    */}
<span>{count()}</span>            {/* ✗ static — a number was passed       */}
```

If something isn't updating, it's almost always this.

---

## A tour

### Reactivity

```ts
import { signal, computed, effect, batch } from '@sinistermage/coyote-js/reactivity'

const [first, setFirst] = signal('Ada')
const [last,  setLast]  = signal('Lovelace')

const full = computed(() => `${first()} ${last()}`)   // lazy + memoized

effect(() => { document.title = full() })             // runs now, and on change

batch(() => {                                          // one re-run, not two
  setFirst('Grace')
  setLast('Hopper')
})
```

A two-tier `STALE`/`CHECK` marking scheme makes diamond dependencies recompute
downstream nodes exactly once — never twice, never with a mix of old and new
inputs. → [Reactivity docs](./docs/reactivity.md)

### Control flow

```tsx
import { For, Show, Switch, Match } from '@sinistermage/coyote-js/dom'

<Show when={() => todos().length > 0} fallback={<p>Nothing to do.</p>}>
  <For each={todos}>
    {todo => <li classList={{ done: () => todo.done }}>{todo.text}</li>}
  </For>
</Show>
```

`<For>` keys rows by object identity: a surviving row keeps its DOM node **and**
its reactive scope. Adding one item mounts one `<li>`. → [DOM docs](./docs/dom.md)

### Routing

```tsx
import { Router, Link, useParams } from '@sinistermage/coyote-js/router'

const routes = [
  { path: '/',          component: Home },
  { path: '/posts/:id', component: () => import('./Post') },  // lazy + Suspense
  { path: '/*',         component: NotFound },
]

<Router routes={routes} guards={[requireAuth]} root={Layout} />
```

Ranked matching (static beats dynamic), sync-unless-async guards with redirect
support, and lazy routes that import exactly once. → [Router docs](./docs/router.md)

### Async data

```tsx
import { createResource } from '@sinistermage/coyote-js/router'

const post = createResource(
  () => params().id,                 // reactive source — a change refetches
  id => api<Post>(`/posts/${id}`),
)

<Suspense fallback={<Spinner />}>
  <Show when={post}>{p => <article>{p.title}</article>}</Show>
</Suspense>
```

Stale responses are dropped, and `<Suspense>` keeps pending children mounted
off-document so a resource that settles mid-suspend still renders.
→ [Resources](./docs/router.md#createresource)

### Fine-grained state

```ts
import { createStore, produce, defineStore } from '@sinistermage/coyote-js/store'

const [state, set] = createStore({ user: { name: 'Ada', age: 36 } })

effect(() => console.log(state.user.name))
set('user', 'age', 37)     // ← this effect does NOT run
set('user', 'name', 'G')   // ← this one does
```

Every property gets its own signal, created lazily on first read. On a 500-row
table that's the difference between one text node updating and every reader waking
up. `defineStore` adds a Pinia-shaped app-wide singleton on top.
→ [Store docs](./docs/store.md)

### Typed workers

```ts
// heavy.worker.ts
const api = {
  crunch: (d: Float64Array) => expensive(d),
  async *progress(n: number) { for (let i = 0; i < n; i++) yield i / n },
}
export type Api = typeof api
defineWorker(api)
```

```ts
// main thread
const workers = pool<Api>(
  () => new Worker(new URL('./heavy.worker.ts', import.meta.url), { type: 'module' }),
  { size: navigator.hardwareConcurrency },
)

const result = await workers.crunch(data)              // fully typed
for await (const p of workers.progress(100)) setPct(p) // generators stream
```

Backpressure-aware routing sends each call to the least-busy worker, and
`transfer()` gives you zero-copy buffers. → [Worker docs](./docs/worker.md)

### HTTP + WASM

```ts
const api = createHttp({ baseURL: '/api', getToken })
const me  = await api<User>('/me')          // bearer injected, JSON parsed

const { handle, done } = loadWasm({ wasmUrl: '/engine.wasm', dataUrl: '/assets.bin' })
effect(() => setProgress(handle.progress.percent()))    // reactive loading screen
const { module, data } = await done
```

→ [HTTP docs](./docs/http.md) · [Loader docs](./docs/loader.md)

---

## Modules

Import from the subpath you need — unused modules never reach your bundle.

| Module | Import | What it gives you |
| --- | --- | --- |
| [Reactivity](./docs/reactivity.md) | `@sinistermage/coyote-js/reactivity` | `signal` `computed` `effect` `batch` `untrack` `flushSync` `createRoot` `onCleanup` |
| [DOM](./docs/dom.md) | `@sinistermage/coyote-js/dom` | `render` `h` `For` `Index` `Show` `Switch` `Portal` `Dynamic` `ErrorBoundary` `Suspense` `createContext` |
| [Router](./docs/router.md) | `@sinistermage/coyote-js/router` | `Router` `Link` `navigate` `useRoute` `useParams` `useSearchParams` `createResource` |
| [Store](./docs/store.md) | `@sinistermage/coyote-js/store` | `createStore` `produce` `reconcile` `defineStore` `useStore` |
| [Worker](./docs/worker.md) | `@sinistermage/coyote-js/worker` | `defineWorker` `spawn` `pool` `transfer` |
| [HTTP](./docs/http.md) | `@sinistermage/coyote-js/http` | `createHttp` `isSignedOutError` |
| [Loader](./docs/loader.md) | `@sinistermage/coyote-js/loader` | `loadWasm` `loadGame` |

The package root re-exports everything, if you'd rather not think about it:

```ts
import { signal, render, Router } from '@sinistermage/coyote-js'
```

---

## Requirements

- **Node 18+** to build; the runtime targets ES2022 browsers.
- **ESM only.** There is no CommonJS build.
- Workers require an ES-module-worker build setting (`worker: { format: 'es' }` in
  Vite) and the `new URL(..., import.meta.url)` factory form.

---

## Development

```bash
npm install
npm test          # vitest, jsdom — 235 tests
npm run typecheck # tsc --noEmit
npm run build     # vite library build + .d.ts emit into dist/
```

The build emits one file per public subpath with `preserveModules`, so
`dist/reactivity/index.js` and friends map 1:1 to the `exports` map. Types are
emitted separately by `tsc`.

---

## FAQ

**How is this different from SolidJS?**
The reactive primitives are deliberately familiar — if you know Solid, you know
this. What's different is scope: coyote-js ships typed worker RPC with streaming
generators, a Pinia-shaped store layer, an HTTP client, and a WASM loader as part
of the framework, all written from scratch with zero dependencies.

**Is it production-ready?**
It's `0.1.0`. The core is covered by 235 tests across reactivity, DOM, control
flow, SVG, router, resources, store, and worker RPC — but the API may still move
before 1.0. Pin your version.

**Do I have to use JSX?**
No. `h(tag, props, ...children)` is the same function the JSX runtime calls.

**Can I use it with React/Vue components?**
No. coyote-js renders directly to the DOM with its own scheduler; there is no
interop layer.

---

## Contributing

Issues and pull requests are welcome at
[github.com/sinisterMage/CoyoteJS](https://github.com/sinisterMage/CoyoteJS).
Please run `npm test` and `npm run typecheck` before opening a PR.

> **Note on git history:** coyote-js was developed in a separate repository before
> being published, so the commit history here starts at the public release.

---

## License

MIT © 2026 sinisterMage — see [LICENSE](./LICENSE).
