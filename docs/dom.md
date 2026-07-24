# `@sinistermage/coyote-js/dom`

The renderer: JSX compiled straight to real DOM nodes, with reactive slots wired
in place. **There is no virtual DOM.** `<div>` *is* an `HTMLDivElement` the moment
it is evaluated, and an update writes to exactly the text node or attribute that
changed.

```ts
import {
  render, h, Fragment,
  For, Index, Show, Switch, Match, Portal, Dynamic,
  ErrorBoundary, Suspense,
  createContext, useContext,
  onMount, onCleanup,
} from '@sinistermage/coyote-js/dom'
```

---

## `render`

```ts
function render(code: () => CoyoteNode, root: Element): () => void
```

Establishes a disposal root, runs `code()` under it, and inserts the result into
`root`. Returns a disposer that runs every cleanup and removes exactly the nodes
it inserted — pre-existing children of `root` are never touched.

```ts
const dispose = render(() => <App />, document.getElementById('app')!)

// later
dispose()
```

The initial paint is **synchronous**: the DOM is fully materialized before
`render` returns.

---

## Components

A component is a plain function from props to a node. It runs **once**. There is
no re-render — reactivity lives in the bindings, not in the component.

```tsx
function Greeting(props: { name: string }) {
  console.log('runs exactly once')
  return <h1>Hello, {props.name}</h1>
}
```

```ts
type Component<P = {}> = (props: P) => CoyoteNode

type CoyoteNode =
  | Node | string | number | boolean | null | undefined
  | CoyoteNodeArray        // CoyoteNode[]
  | CoyoteNodeFn           // () => CoyoteNode  — a live reactive slot
```

Because a component body runs once, **destructuring props freezes them**:

```tsx
function Bad({ name }: { name: string }) { return <h1>{name}</h1> }   // ✗ never updates
function Good(props: { name: string })   { return <h1>{props.name}</h1> }  // ✓
```

---

## Reactivity in JSX

The rule is one line long:

> **A function value is a live binding. Anything else is written once.**

```tsx
const [count, setCount] = signal(0)

<span>{count}</span>              {/* ✓ live — the accessor itself is passed */}
<span>{() => count() * 2}</span>  {/* ✓ live — an expression, wrapped in a thunk */}
<span>{count()}</span>            {/* ✗ static — evaluated once at build time */}
```

The same rule governs attributes:

```tsx
<div class={() => active() ? 'on' : 'off'} />   {/* ✓ live */}
<div class={activeClass} />                      {/* ✓ live if activeClass is an accessor */}
<div class={active() ? 'on' : 'off'} />          {/* ✗ static */}
```

Each live slot gets its **own** effect. A change to `count` rewrites that one text
node; it does not re-run the component, re-evaluate siblings, or diff a tree.

### Props reference

| Prop | Behavior |
| --- | --- |
| `on*` (`onClick`, `onInput`, …) | Event handler via `addEventListener`. The name after `on` is lowercased (`onClick` → `click`). **Never** called reactively — the function is the handler. |
| `class` / `className` | String, or an accessor for a live class string. |
| `classList` | Object of `{ 'class-name': boolean }`. Each value may be an accessor; the whole object may be one. Space-separated keys are split. |
| `style` | A CSS string, or an object. Values may be accessors; keys may be `camelCase`, `kebab-case`, or `--custom-props`. A reactive object clears keys that disappear between runs. |
| `ref` | Called with the element as soon as it is created. |
| `innerHTML` | Set as-is (reactive when a function). You are responsible for sanitizing. |
| `value`, `checked`, `selected`, `disabled`, `multiple`, `muted`, `readOnly`, `indeterminate` | Set as DOM **properties**, not attributes. |
| anything else | Set as an attribute. `null`/`undefined`/`false` remove it; `true` sets it to `""`. |

```tsx
<input
  ref={el => inputEl = el}
  value={text}
  onInput={e => setText(e.currentTarget.value)}
  classList={{ invalid: () => text().length === 0 }}
  style={{ color: () => valid() ? 'green' : 'crimson', '--gap': '4px' }}
  disabled={busy}
/>
```

### SVG

SVG elements are namespaced automatically from the tag name — `<svg>`, `<path>`,
`<circle>`, `<g>`, filters, gradients and the rest all get
`createElementNS`. A `<foreignObject>`'s HTML children self-namespace back to
XHTML. No configuration, no `xmlns` prop.

```tsx
<svg viewBox="0 0 24 24"><path d={() => shape()} fill="currentColor" /></svg>
```

---

## Control flow

Conditionals and loops are components, not syntax. Each returns a reactive
accessor; the enclosing slot swaps its nodes in place. Every row/branch runs under
its **own** child scope, so its cleanups fire exactly when *it* is removed.

### `Show`

```tsx
<Show when={() => user() != null} fallback={<Spinner />}>
  <Dashboard />
</Show>
```

| Prop | Type | Meaning |
| --- | --- | --- |
| `when` | `Accessor<T \| null \| undefined \| false> \| T` | The condition. |
| `fallback` | `CoyoteNode` | Rendered while falsy. Optional. |
| `keyed` | `boolean` | Re-mount whenever the truthy **value** changes, not just its truthiness. |
| `children` | `CoyoteNode \| ((item: T) => CoyoteNode)` | A function child receives the truthy value. |

```tsx
{/* keyed: a different user remounts the subtree with a non-null `u` */}
<Show when={user} keyed>
  {u => <Profile user={u} />}
</Show>
```

### `For` — keyed by identity

```tsx
<For each={todos} fallback={<p>Nothing to do.</p>}>
  {(todo, i) => <li>{() => i() + 1}. {todo.title}</li>}
</For>
```

Rows are keyed by **referential identity** of the item. An unchanged item keeps
its DOM node *and* its reactive scope across updates; new items mount, removed
items dispose, and a reorder re-emits the existing nodes in the new order. The
index is an `Accessor<number>` because a row can move.

Use `For` for lists of objects — the normal case.

### `Index` — keyed by position

```tsx
<Index each={scores}>
  {(score, i) => <li>#{i}: {score}</li>}
</Index>
```

Rows are keyed by **position**. The item is an `Accessor<T>`, so when the value at
a position changes the row is reused and its accessor updates; rows are created and
destroyed only as the list **length** changes. The index is a plain number.

Use `Index` for lists of primitives, or when position — not identity — is what the
row represents.

### `Switch` / `Match`

```tsx
<Switch fallback={<NotFound />}>
  <Match when={() => state() === 'loading'}><Spinner /></Match>
  <Match when={() => state() === 'error'}><Error /></Match>
  <Match when={result}>{r => <Result data={r} />}</Match>
</Switch>
```

Renders the first `Match` whose `when` is truthy, else `fallback`. Like `Show`, a
function child receives the truthy value.

### `Dynamic`

```tsx
<Dynamic component={() => heading()} class="title">{text}</Dynamic>
<Dynamic component={widgetFor(kind())} {...widgetProps} />
```

Renders a tag string or a `Component` chosen at runtime; the remaining props are
forwarded.

### `Portal`

```tsx
<Portal mount={document.getElementById('modals')!}>
  <Modal onClose={close} />
</Portal>
```

Renders children into `mount` (default `document.body`), detached from the
component's position in the tree, and removes them on unmount.

---

## Boundaries

### `ErrorBoundary`

```tsx
<ErrorBoundary fallback={(err, reset) => (
  <div class="error">
    <p>{String(err)}</p>
    <button onClick={reset}>Try again</button>
  </div>
)}>
  <RiskyThing />
</ErrorBoundary>
```

Catches **synchronous** throws from its subtree — during render and during the
initial run of effects created inside it. `reset` re-attempts the children.

It does not catch errors from a rejected promise inside an event handler or a
settled async continuation; surface those through `createResource`'s `error()` or
your own state.

### `Suspense`

```tsx
<Suspense fallback={<Spinner />}>
  <ProfileThatReadsAResource />
</Suspense>
```

Shows `fallback` while any [`createResource`](./router.md#createresource) inside is
pending. Resources register with the nearest boundary automatically.

While pending, the children are **kept mounted** in an off-document holder rather
than being torn down. That means a resource that settles mid-suspend still renders
into a live parent, and lazy routes resolve correctly. No wrapper element is
introduced, so structural CSS (`> *`, `:nth-child`) is unaffected.

```ts
// For integrating your own async primitive with a boundary:
function useSuspense(): SuspenseContextValue | null

interface SuspenseContextValue {
  increment: () => void     // a pending read starts
  decrement: () => void     // it settles
  count: Accessor<number>
}
```

---

## Context

```ts
function createContext<T>(defaultValue: T): Context<T>
function useContext<T>(ctx: Context<T>): T
```

```tsx
const ThemeContext = createContext<'light' | 'dark'>('light')

function App() {
  return (
    <ThemeContext.Provider value="dark">
      <Toolbar />
    </ThemeContext.Provider>
  )
}

function Toolbar() {
  const theme = useContext(ThemeContext)   // 'dark'
  return <div class={theme}>…</div>
}
```

Values are keyed by **owner scope** in a `WeakMap`, and `useContext` walks the
owner parent chain to the nearest provider. That chain is maintained through
effects, control-flow rows, and boundaries — so a consumer nested arbitrarily deep
still finds its provider, and nothing leaks between sibling scopes.

To make the *value* reactive, provide a signal or store rather than a bare value:

```tsx
const [theme, setTheme] = signal('dark')
<ThemeContext.Provider value={{ theme, setTheme }}> … </ThemeContext.Provider>
```

---

## Lifecycle

```ts
function onMount(fn: () => void): void      // once, after the nodes are attached
function onCleanup(fn: () => void): void    // on unmount (re-exported from reactivity)
```

```tsx
function Chart(props: { data: number[] }) {
  let canvas!: HTMLCanvasElement

  onMount(() => {
    const chart = draw(canvas, props.data)
    onCleanup(() => chart.destroy())
  })

  return <canvas ref={el => canvas = el as HTMLCanvasElement} />
}
```

`onMount` defers to a microtask — `render` paints synchronously, so by the time it
runs the tree is in the document and measurable.

---

## Hyperscript

JSX is optional. `h` is the same function the JSX runtime calls:

```ts
import { h, Fragment } from '@sinistermage/coyote-js/dom'

h('button', { onClick: inc }, 'count: ', count)
h(Fragment, null, h('h1', null, 'Title'), h('p', null, body))
```

`h(tag, props, ...children)` — a string tag builds a real element, a function tag
is called with `{ ...props, children }`.

---

## Types

```ts
type CoyoteNode = Node | string | number | boolean | null | undefined
                | CoyoteNodeArray | CoyoteNodeFn
interface CoyoteNodeArray extends Array<CoyoteNode> {}
interface CoyoteNodeFn { (): CoyoteNode }

type Component<P = {}> = (props: P) => CoyoteNode

interface Context<T> {
  id: symbol
  defaultValue: T
  Provider: Component<{ value: T; children: CoyoteNode }>
}
```

---

**Next:** [Router →](./router.md) · [Store →](./store.md)
