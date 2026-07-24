# Getting started

A complete setup, from an empty directory to a running app.

---

## Install

```bash
npm install @sinistermage/coyote-js
```

coyote-js has **zero runtime dependencies**. It ships ESM only and needs Node 18+
to build.

---

## Project setup

### 1. `tsconfig.json`

The two lines that matter are `jsx` and `jsxImportSource`:

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "isolatedModules": true,
    "noEmit": true,

    "jsx": "react-jsx",
    "jsxImportSource": "@sinistermage/coyote-js"
  },
  "include": ["src"]
}
```

`jsxImportSource` points the automatic JSX runtime at coyote's renderer, so
`<div>` compiles to a call into `@sinistermage/coyote-js/jsx-runtime`. There is no
`import { h }` boilerplate in your files, and no React import.

### 2. `vite.config.ts`

Tell esbuild the same thing, and enable ES-module workers:

```ts
import { defineConfig } from 'vite'

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: '@sinistermage/coyote-js',
  },
  // Only needed if you use @sinistermage/coyote-js/worker
  worker: { format: 'es' },
})
```

Using a different bundler? Set the equivalent automatic-JSX option — esbuild's
`jsxImportSource`, Babel's `@babel/plugin-transform-react-jsx` with
`{ runtime: 'automatic', importSource: '@sinistermage/coyote-js' }`, or SWC's
`jsc.transform.react.importSource`.

### 3. `index.html`

```html
<!doctype html>
<html>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

### 4. `src/main.tsx`

```tsx
import { render } from '@sinistermage/coyote-js/dom'
import { App } from './App'

render(() => <App />, document.getElementById('app')!)
```

That's the whole setup.

---

## Your first component

```tsx
// src/App.tsx
import { signal } from '@sinistermage/coyote-js/reactivity'

export function App() {
  const [count, setCount] = signal(0)

  return (
    <main>
      <h1>Count: {count}</h1>
      <button onClick={() => setCount(n => n + 1)}>+1</button>
    </main>
  )
}
```

Three things are happening that differ from React or Vue:

1. **`App` runs exactly once.** There is no re-render. Put a `console.log` in the
   body and click the button — it never fires again.
2. **`{count}` passes the accessor, not its value.** The renderer sees a function
   and turns that position into a live slot backed by its own effect.
3. **A click updates one text node.** No diff, no reconciliation, no component
   subtree walked.

### The one rule to internalize

> **A function is reactive. A value is a snapshot.**

```tsx
<h1>{count}</h1>              {/* ✓ live */}
<h1>{() => count() * 2}</h1>  {/* ✓ live */}
<h1>{count()}</h1>            {/* ✗ renders "0" forever */}
```

If something isn't updating, it's almost always this.

---

## Adding derived state and effects

```tsx
import { signal, computed, effect } from '@sinistermage/coyote-js/reactivity'

export function App() {
  const [first, setFirst] = signal('Ada')
  const [last,  setLast]  = signal('Lovelace')

  const full = computed(() => `${first()} ${last()}`)

  effect(() => { document.title = full() })

  return (
    <form>
      <input value={first} onInput={e => setFirst(e.currentTarget.value)} />
      <input value={last}  onInput={e => setLast(e.currentTarget.value)} />
      <p>Hello, {full}</p>
    </form>
  )
}
```

- `computed` is **lazy and memoized** — it recomputes only when read after a
  dependency changed.
- `effect` runs once immediately, then on every change. Its lifetime is the
  component's; it disposes on unmount.

---

## Lists and conditionals

Control flow is components, not `.map()` and `&&`:

```tsx
import { signal } from '@sinistermage/coyote-js/reactivity'
import { For, Show } from '@sinistermage/coyote-js/dom'

type Todo = { id: number; text: string; done: boolean }

export function Todos() {
  const [todos, setTodos] = signal<Todo[]>([])
  const [draft, setDraft] = signal('')

  const add = (e: Event) => {
    e.preventDefault()
    if (!draft().trim()) return
    setTodos(list => [...list, { id: Date.now(), text: draft(), done: false }])
    setDraft('')
  }

  return (
    <>
      <form onSubmit={add}>
        <input value={draft} onInput={e => setDraft(e.currentTarget.value)} />
        <button type="submit">Add</button>
      </form>

      <Show when={() => todos().length > 0} fallback={<p>Nothing to do.</p>}>
        <ul>
          <For each={todos}>
            {todo => <li classList={{ done: () => todo.done }}>{todo.text}</li>}
          </For>
        </ul>
      </Show>
    </>
  )
}
```

`<For>` keys rows by **object identity**: adding one item mounts one `<li>` and
leaves every existing row's DOM node untouched. Using `.map()` here would rebuild
the whole list on every change.

→ [Full control-flow reference](./dom.md#control-flow)

---

## Adding routing

```tsx
// src/App.tsx
import { Router, Link } from '@sinistermage/coyote-js/router'
import { Suspense } from '@sinistermage/coyote-js/dom'
import { Home } from './pages/Home'
import { NotFound } from './pages/NotFound'

const routes = [
  { path: '/',          component: Home },
  { path: '/posts/:id', component: () => import('./pages/Post') },   // lazy
  { path: '/*',         component: NotFound },
]

export function App() {
  return (
    <>
      <nav>
        <Link href="/" activeClass="active">Home</Link>
        <Link href="/posts/1" activeClass="active">First post</Link>
      </nav>
      <Suspense fallback={<p>Loading…</p>}>
        <Router routes={routes} fallback={NotFound} />
      </Suspense>
    </>
  )
}
```

```tsx
// src/pages/Post.tsx
import { useParams } from '@sinistermage/coyote-js/router'

export default function Post() {
  const params = useParams<{ id: string }>()
  return <h1>Post {() => params().id}</h1>
}
```

A lazy route is just `() => import('./Page')` — the pending import shows the
nearest `<Suspense>` fallback, and the module is imported exactly once.

→ [Full router reference](./router.md)

---

## Fetching data

```tsx
import { createHttp } from '@sinistermage/coyote-js/http'
import { createResource, useParams } from '@sinistermage/coyote-js/router'
import { Switch, Match } from '@sinistermage/coyote-js/dom'

const api = createHttp({ baseURL: '/api' })

export default function Post() {
  const params = useParams<{ id: string }>()

  const post = createResource(
    () => params().id,                    // reactive source — a change refetches
    id => api<Post>(`/posts/${id}`),      // fetcher
  )

  return (
    <Switch fallback={<Spinner />}>
      <Match when={post.error}>{e => <p>Failed: {String(e)}</p>}</Match>
      <Match when={post}>{p => <article><h1>{p.title}</h1>{p.body}</article></Match>
    </Switch>
  )
}
```

`createResource` refetches when the source changes, drops stale responses, and
registers with the nearest `<Suspense>` while pending.

→ [Resources](./router.md#createresource) · [HTTP client](./http.md)

---

## Shared state

For anything beyond one component, reach for a store:

```ts
// src/stores/todos.ts
import { createStore, produce, defineStore } from '@sinistermage/coyote-js/store'

export const useTodos = defineStore('todos', () => {
  const [state, set] = createStore({ items: [] as Todo[] })

  return {
    state,
    actions: {
      add: (text: string) =>
        set('items', produce(l => { l.push({ id: Date.now(), text, done: false }) })),
      toggle: (i: number) => set('items', i, 'done', d => !d),
    },
  }
})
```

```tsx
const { state, actions } = useTodos()
<For each={() => state.items}>{t => <li>{() => t.text}</li>}</For>
```

`defineStore` gives you an app-wide singleton. The store tracks **each property
separately**, so toggling one todo notifies only that row.

→ [Full store reference](./store.md)

---

## Moving work off the main thread

```ts
// src/workers/heavy.worker.ts
import { defineWorker } from '@sinistermage/coyote-js/worker'

const api = {
  crunch: (data: Float64Array) => expensive(data),
  async *progress(n: number) { for (let i = 0; i < n; i++) yield i / n },
}
export type HeavyApi = typeof api
defineWorker(api)
```

```ts
// anywhere on the main thread
import { pool } from '@sinistermage/coyote-js/worker'
import type { HeavyApi } from './workers/heavy.worker'

const workers = pool<HeavyApi>(
  () => new Worker(new URL('./workers/heavy.worker.ts', import.meta.url), { type: 'module' }),
  { size: navigator.hardwareConcurrency },
)

const result = await workers.crunch(data)           // fully typed
for await (const p of workers.progress(100)) setPct(p)
```

Remember `worker: { format: 'es' }` in your Vite config and the
`new URL(..., import.meta.url)` factory form.

→ [Full worker reference](./worker.md)

---

## Import map

Import from the subpath you need — the package is fully tree-shakeable
(`sideEffects: false`), so unused modules never reach your bundle.

```ts
import { signal, computed, effect }        from '@sinistermage/coyote-js/reactivity'
import { render, For, Show, Suspense }     from '@sinistermage/coyote-js/dom'
import { Router, Link, createResource }    from '@sinistermage/coyote-js/router'
import { createStore, defineStore }        from '@sinistermage/coyote-js/store'
import { spawn, pool, defineWorker }       from '@sinistermage/coyote-js/worker'
import { createHttp }                      from '@sinistermage/coyote-js/http'
import { loadWasm }                        from '@sinistermage/coyote-js/loader'
```

The package root re-exports everything, if you'd rather not think about it:

```ts
import { signal, render, Router } from '@sinistermage/coyote-js'
```

---

## Troubleshooting

**Nothing updates when I change a signal.**
You called the accessor too early. `{count()}` is a snapshot; `{count}` or
`{() => count() + 1}` is a live binding.

**A prop stopped being reactive.**
You destructured it. `function C({ x })` reads `x` once — components run once. Use
`props.x`.

**`Cannot find namespace 'JSX'` / JSX doesn't typecheck.**
`jsxImportSource` is missing or misspelled in `tsconfig.json`, or `jsx` isn't set
to `"react-jsx"`.

**JSX compiles but nothing renders.**
Your bundler's JSX setting doesn't match your tsconfig. Set `esbuild.jsxImportSource`
(or the Babel/SWC equivalent) to `@sinistermage/coyote-js` as well.

**The worker 404s in production but works in dev.**
The factory used a bare string path. It must be
`new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })` so the
bundler can find and fingerprint it.

**`coyote/store: a store is read-only through property access`.**
You wrote `state.x = 1`. Use the setter: `set('x', 1)`, or `set(produce(s => { s.x = 1 }))`.

**`coyote/router: hooks and <Link> must be used inside a <Router>`.**
The component calling `useRoute`/`useParams`/`useSearchParams` — or rendering a
`<Link>` — is mounted outside the `<Router>` subtree.

---

**Next:** [Concepts — how it works →](./concepts.md) · [API reference →](./reactivity.md)
