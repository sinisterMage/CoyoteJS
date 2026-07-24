# `@sinistermage/coyote-js/store`

Deep, fine-grained reactive state. A store is a proxy over a plain object where
**each property gets its own signal, created lazily on first read**. An effect that
reads `state.user.name` re-runs when the name changes — and not when a sibling
field does.

```ts
import {
  createStore, produce, reconcile,
  defineStore, useStore,
} from '@sinistermage/coyote-js/store'
```

---

## `createStore`

```ts
function createStore<T extends object>(init: T): [get: Store<T>, set: SetStoreFunction<T>]
```

```ts
const [state, setState] = createStore({
  user: { name: 'Ada', age: 36 },
  todos: [{ id: 1, text: 'ship it', done: false }],
})

effect(() => console.log(state.user.name))   // re-runs only on `user.name`
setState('user', 'age', 37)                  // ← does not wake the effect above
setState('user', 'name', 'Grace')            // ← does
```

### Reads

Reading a property subscribes the current observer to that property's signal.
Nested plain objects and arrays are wrapped transparently and memoized by identity
— `state.user` returns the same proxy every time.

Class instances (`Date`, `Map`, `Set`, DOM nodes, …) are **leaf values**: they are
stored as-is and replaced wholesale, never tracked field-by-field.

`Object.keys`, spreads, and iteration subscribe to a per-object *enumeration*
signal, so a structural add or delete re-runs them. Array `.length` is reactive
too.

### Writes

The proxy is **read-only through property access** — `state.x = 1` throws with a
message pointing you at the setter. Every write goes through the returned setter,
which is path-based:

```ts
setState('count', 5)                         // set a leaf
setState('user', 'name', 'Grace')            // nested set
setState('user', 'age', n => n + 1)          // functional update
setState({ count: 5, ready: true })          // merge a partial at the root
setState(s => ({ count: s.count + 1 }))      // functional partial merge
setState('todos', 0, 'done', true)           // arrays index by number
```

All writes are **batched**: a multi-key update re-runs each dependent effect at
most once. Setting a value to `undefined` deletes the key.

---

## `produce`

```ts
function produce<T>(mutator: (draft: T) => void): (state: T) => T
```

Write imperatively; coyote figures out what changed. Pass the result to the setter.

```ts
setState(produce(s => {
  s.count++
  s.user.name = 'Grace'
}))

setState('todos', produce(list => {
  list.push({ id: 2, text: 'write docs', done: false })
  list[0].done = true
}))
```

The mutator runs untracked against a mutable draft, and the touched **top-level
keys of the target** are diffed back into per-property notifications. Array length
shifts from `push`/`pop`/`splice` are detected and notified.

Reach for `produce` when a change is naturally expressed as a mutation — appending
to a list, toggling a flag deep in a tree, sorting in place.

---

## `reconcile`

```ts
function reconcile<T>(next: T, options?: { key?: string }): (state: T) => T
```

Merge a fresh snapshot (typically from the server) into existing state **without
throwing away referential identity**. Only the leaves that actually changed
notify, so unaffected rows keep their DOM and their scopes.

```ts
const fresh = await api<Todo[]>('/todos')
setState('todos', reconcile(fresh))          // matches array elements by `id`
setState('todos', reconcile(fresh, { key: 'uuid' }))
```

Without `reconcile`, assigning a new array replaces every element — and a `<For>`
over it tears down and rebuilds every row. With it, a 200-item list where one title
changed updates exactly one text node.

Objects are diffed recursively; array elements are matched by `options.key`
(default `'id'`) so reorders and insertions preserve identity.

---

## `defineStore`

```ts
function defineStore<S extends object, A extends Record<string, Function>>(
  id: string,
  setup: () => { state: S; actions: A },
): () => StoreApi<S, A>

interface StoreApi<S, A> { state: S; actions: A }
```

An app-wide singleton — the Pinia-shaped layer on top of `createStore`. `setup`
runs **at most once**, the first time the accessor is called; every later call
returns the same instance.

```ts
// stores/todos.ts
export const useTodos = defineStore('todos', () => {
  const [state, set] = createStore({
    items: [] as Todo[],
    filter: 'all' as 'all' | 'open' | 'done',
  })

  return {
    state,
    actions: {
      add(text: string) {
        set('items', produce(l => { l.push({ id: nextId(), text, done: false }) }))
      },
      toggle(id: number) {
        const i = state.items.findIndex(t => t.id === id)
        if (i >= 0) set('items', i, 'done', d => !d)
      },
      async load() {
        set('items', reconcile(await api<Todo[]>('/todos')))
      },
      setFilter(f: 'all' | 'open' | 'done') { set('filter', f) },
    },
  }
})
```

```tsx
function TodoList() {
  const { state, actions } = useTodos()

  const visible = computed(() =>
    state.filter === 'all' ? state.items
      : state.items.filter(t => t.done === (state.filter === 'done')))

  onMount(() => { void actions.load() })

  return (
    <ul>
      <For each={visible}>
        {todo => (
          <li classList={{ done: () => todo.done }} onClick={() => actions.toggle(todo.id)}>
            {() => todo.text}
          </li>
        )}
      </For>
    </ul>
  )
}
```

Because the singleton lives at module scope, it survives route changes and is
shared by every component that calls `useTodos()`.

Derived state is just a `computed` — there is no separate "getters" concept.

## `useStore`

```ts
function useStore<T>(factory: () => T): T
```

The same memoization keyed by the **factory function's identity** instead of a
string id. Useful for a singleton you don't want to name:

```ts
const useAuth = () => useStore(() => {
  const [state, set] = createStore({ user: null as User | null })
  return { state, signIn: async (c: Creds) => set('user', await api('/login', { body: c })) }
})
```

---

## Choosing between signal and store

| | `signal` | `createStore` |
| --- | --- | --- |
| Shape | One value | A nested object tree |
| Granularity | Whole value | Per property, at any depth |
| Update | `set(v)` / `set(fn)` | Path setter, `produce`, `reconcile` |
| Best for | Counters, flags, form fields, a single fetched object | Lists, entity maps, deeply nested app state |

A signal holding an array notifies **every** reader when you replace it. A store
holding that array notifies only the readers of the elements that changed. For a
long list rendered with `<For>`, that difference is the whole point.

---

## Types

```ts
type Store<T extends object> = T          // a deep reactive proxy over T
type SetStoreFunction<T> = (...path: any[]) => void
interface StoreApi<S extends object, A> { state: S; actions: A }
```

---

## Gotchas

**Direct assignment throws.** `state.x = 1` and `delete state.x` both raise —
by design, so every mutation is observable. Use the setter, `produce`, or
`reconcile`.

**Don't destructure state.** `const { name } = state.user` reads once and detaches
from the store. Keep the access in place: `state.user.name`, or wrap it —
`() => state.user.name`.

**`defineStore` ids are global.** Two `defineStore('todos', …)` calls in different
modules resolve to the same singleton. Namespace ids in a large app.

---

**Next:** [Workers →](./worker.md) · [HTTP →](./http.md)
