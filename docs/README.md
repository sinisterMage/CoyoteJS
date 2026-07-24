# coyote-js documentation

A from-scratch, TypeScript-native, fine-grained reactive UI framework.

## Start here

| | |
| --- | --- |
| **[Getting started](./getting-started.md)** | Install, configure, and build your first app — components, lists, routing, data, workers. |
| **[Concepts](./concepts.md)** | How it works: components that run once, the reactive graph, ownership, live slots, and why the API is shaped this way. |

## API reference

| Module | Import | Contents |
| --- | --- | --- |
| **[Reactivity](./reactivity.md)** | `@sinistermage/coyote-js/reactivity` | `signal` · `computed` · `effect` · `batch` · `untrack` · `flushSync` · `createRoot` · `getOwner` · `runWithOwner` · `onCleanup` |
| **[DOM & JSX](./dom.md)** | `@sinistermage/coyote-js/dom` | `render` · `h` · `Fragment` · `For` · `Index` · `Show` · `Switch` · `Match` · `Portal` · `Dynamic` · `ErrorBoundary` · `Suspense` · `createContext` · `useContext` · `onMount` |
| **[Router](./router.md)** | `@sinistermage/coyote-js/router` | `Router` · `Link` · `navigate` · `useRoute` · `useParams` · `useSearchParams` · `createResource` |
| **[Store](./store.md)** | `@sinistermage/coyote-js/store` | `createStore` · `produce` · `reconcile` · `defineStore` · `useStore` |
| **[Workers](./worker.md)** | `@sinistermage/coyote-js/worker` | `defineWorker` · `spawn` · `pool` · `transfer` |
| **[HTTP](./http.md)** | `@sinistermage/coyote-js/http` | `createHttp` · `isSignedOutError` |
| **[WASM loader](./loader.md)** | `@sinistermage/coyote-js/loader` | `loadWasm` · `loadGame` |

## Quick answers

- **Why isn't my UI updating?** You called the accessor: `{count()}` is a
  snapshot, `{count}` is a live binding. See [the one rule](./concepts.md#the-one-rule).
- **`For` or `Index`?** Objects → `For`, primitives → `Index`.
  [Why](./concepts.md#for-vs-index).
- **Signal or store?** One value → signal; a nested tree you want tracked
  per-property → store. [Comparison](./store.md#choosing-between-signal-and-store).
- **How do I clean something up?** [`onCleanup`](./reactivity.md#oncleanup) — it
  runs before each re-run and on disposal.
- **Something else broke.** [Troubleshooting](./getting-started.md#troubleshooting).
