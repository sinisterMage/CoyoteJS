# `@sinistermage/coyote-js/router`

A client-side history router — route matching, guards, lazy routes, and
`createResource` for reactive async data.

```ts
import {
  Router, Link, navigate,
  useRoute, useParams, useSearchParams,
  createResource,
} from '@sinistermage/coyote-js/router'
```

---

## `Router`

```tsx
<Router
  routes={routes}
  guards={[requireAuth]}
  fallback={NotFound}
  root={Layout}
/>
```

| Prop | Type | Meaning |
| --- | --- | --- |
| `routes` | `RouteDef[]` \| glob record | The route table. See below. |
| `guards` | `RouteGuard[]` | Run in order before every navigation. |
| `fallback` | `Component` | Rendered when nothing matches (your 404). |
| `scrollRestoration` | `boolean` | Default `true`. `false` disables scroll-on-navigate entirely. |
| `root` | `Component<{ children }>` | A persistent layout wrapped around the outlet. |

### Route definitions

```ts
interface RouteDef {
  path: string
  component: Component | (() => Promise<{ default: Component }>)
  meta?: RouteMeta
}
```

```ts
const routes: RouteDef[] = [
  { path: '/',            component: Home },
  { path: '/posts/:id',   component: Post },
  { path: '/admin',       component: () => import('./Admin'), meta: { requiresAuth: true } },
  { path: '/*',           component: NotFound },
]
```

Or hand it a Vite glob and let each route file declare itself:

```ts
// src/routes/post.route.ts
export default { path: '/posts/:id', component: () => import('../pages/Post') }
```

```tsx
<Router routes={import.meta.glob('/src/routes/*.route.ts', { eager: true })} />
```

A glob module may default-export a single `RouteDef` or an array of them.

### Path syntax

| Pattern | Matches | Params |
| --- | --- | --- |
| `/posts` | exactly `/posts` | — |
| `/posts/:id` | `/posts/42` | `{ id: '42' }` |
| `/posts/[id]` | same — file-style tokens are normalized to `:id` | `{ id: '42' }` |
| `/files/*` | `/files/a/b/c` | `{ wildcard: 'a/b/c' }` |

Paths are normalized (leading slash added, duplicate slashes collapsed, trailing
slash stripped) and ranked by **specificity**: more static segments win, so
`/posts/new` beats `/posts/:id` regardless of declaration order. Params are
URI-decoded.

### Re-mount semantics

The matched component re-mounts only when the **matched route** changes. Navigating
`/posts/1` → `/posts/2` keeps the same component instance alive; it re-reads
`useParams()` reactively. That is usually what you want — but it means a
param-only navigation will not re-run `onMount`. Drive param-dependent work from a
resource or an effect instead:

```tsx
function Post() {
  const params = useParams<{ id: string }>()
  const post = createResource(() => params().id, id => api(`/posts/${id}`))
  return <Show when={post}>{p => <article>{p.title}</article></Show>
}
```

Route components are called with **no props** — read params and query through the
hooks.

### Lazy routes

```ts
{ path: '/admin', component: () => import('./Admin') }
```

The router calls the function once and inspects the result: a thenable means it
was a lazy loader (and that very promise is reused — never a double import).
Pending imports show the nearest `<Suspense>` fallback.

```tsx
<Suspense fallback={<Spinner />}>
  <Router routes={routes} />
</Suspense>
```

---

## Navigation

### `Link`

```tsx
<Link href="/posts/42" class="nav-item" activeClass="is-active">
  Post 42
</Link>
```

Renders a real `<a href>` — right-clickable, middle-clickable, crawlable — and
intercepts only a **plain left click** on a **same-origin** target. Modified
clicks (⌘/Ctrl/Shift/Alt), non-primary buttons, cross-origin hrefs, and
already-`preventDefault`ed events fall through to the browser.

| Prop | Type | Meaning |
| --- | --- | --- |
| `href` | `string` | Target. Relative hrefs resolve against the current origin. |
| `replace` | `boolean` | Replace the history entry instead of pushing. |
| `class` | `string` | Base class. |
| `activeClass` | `string` | Appended while the current route matches this href. |

### `navigate`

```ts
function navigate(to: string, opts?: {
  replace?: boolean
  state?: unknown
  scroll?: boolean
}): void
```

```ts
navigate('/dashboard')
navigate('/login', { replace: true })
navigate('/checkout', { state: { from: 'cart' } })
navigate('/list#row-9')          // scrolls to #row-9 if it exists
navigate('/silent', { scroll: false })
```

`navigate` runs guards, then commits. It is **synchronous** when every guard is
synchronous — the commit happens before the next statement. If any guard returns a
promise, the commit happens once the chain settles.

Scroll behavior after a commit: scroll to the hash target if there is one,
otherwise to the top. Disable per-call with `scroll: false` or globally with
`scrollRestoration={false}`.

---

## Guards

```ts
interface RouteGuard {
  (to: ResolvedRoute, from: ResolvedRoute | null):
    void | string | Promise<void | string>
}
```

Return a **path string** to redirect, or nothing to allow. Guards run in array
order; the first redirect wins.

```ts
const requireAuth: RouteGuard = (to) => {
  if (to.meta.requiresAuth && !auth.state.user) {
    return `/login?next=${encodeURIComponent(to.fullPath)}`
  }
}

const checkPlan: RouteGuard = async (to) => {
  if (to.path.startsWith('/pro')) {
    const plan = await loadPlan()
    if (plan !== 'pro') return '/upgrade'
  }
}

<Router routes={routes} guards={[requireAuth, checkPlan]} />
```

A redirect always **replaces** the history entry, so the blocked URL does not
linger in the back stack. Chained redirects are capped at 20 — a cycle logs an
error and commits the last target rather than hanging the app.

---

## Hooks

### `useRoute`

```ts
function useRoute(): Accessor<ResolvedRoute>

interface ResolvedRoute {
  path: string        // the matched PATTERN, e.g. '/posts/:id'
  fullPath: string    // the actual URL path + search + hash
  params: Record<string, string>
  query: Record<string, string>
  meta: RouteMeta
  hash: string        // includes the leading '#', or ''
}
```

```tsx
const route = useRoute()
<title>{() => route().meta.title ?? 'App'}</title>
```

### `useParams`

```ts
function useParams<T extends Record<string, string>>(): Accessor<T>
```

```tsx
const params = useParams<{ id: string }>()
<h1>Post {() => params().id}</h1>
```

### `useSearchParams`

```ts
function useSearchParams(): [
  Accessor<Record<string, string>>,
  (next: Record<string, string | null>) => void,
]
```

```tsx
const [query, setQuery] = useSearchParams()

<input value={() => query().q ?? ''} onInput={e => setQuery({ q: e.currentTarget.value })} />
<button onClick={() => setQuery({ q: null })}>Clear</button>   {/* null deletes the key */}
```

Updates **merge** into the existing query and **replace** the history entry.

All three hooks (and `<Link>`) throw a clear error if used outside a `<Router>`.

---

## `createResource`

```ts
function createResource<T, S = true>(
  source: Accessor<S | false | null> | S,
  fetcher: (source: S, info: { value: T | undefined; refetching: boolean }) => Promise<T>,
): Resource<T>

interface Resource<T> extends Accessor<T | undefined> {
  loading: Accessor<boolean>
  error: Accessor<unknown>
  latest: Accessor<T | undefined>
  mutate: (v: T) => void
  refetch: () => Promise<T | undefined>
}
```

Reactive async data. It re-fetches whenever `source` changes, ignores stale
in-flight responses (last write wins), and drives the nearest `<Suspense>`
boundary.

```tsx
function UserCard() {
  const params = useParams<{ id: string }>()
  const user = createResource(
    () => params().id,
    id => api<User>(`/users/${id}`),
  )

  return (
    <Switch fallback={<Spinner />}>
      <Match when={user.error}>{e => <p>Failed: {String(e)}</p>}</Match>
      <Match when={user}>{u => <h1>{u.name}</h1>}</Match>
    </Switch>
  )
}
```

### The "not ready" source

A source that yields `false`, `null`, or `undefined` **skips the fetch** and leaves
the current value in place. This is how you express a dependency:

```ts
// Don't fetch orders until we know who the user is.
const orders = createResource(
  () => auth.state.user?.id ?? false,
  id => api(`/users/${id}/orders`),
)
```

### Methods

| Member | Behavior |
| --- | --- |
| `resource()` | The latest value, or `undefined`. Reading it subscribes. |
| `loading()` | `true` while a fetch is outstanding. |
| `error()` | The rejection value from the most recent fetch, else `undefined`. Errors are exposed here, never re-thrown from the accessor. |
| `latest()` | The last successful value — same signal as the accessor, named for parity. |
| `mutate(v)` | Write the value locally and invalidate any in-flight fetch. Use for optimistic updates. |
| `refetch()` | Re-run the fetcher with the current source. Returns the new value. |

```ts
// Optimistic update with rollback
const prev = todos()
todos.mutate([...prev!, draft])
try { await api('/todos', { method: 'POST', body: draft }) }
catch { todos.mutate(prev!) }
```

### Suspense integration

Each in-flight fetch holds exactly one pending unit on the nearest boundary,
released on success, error, or supersession — and any remaining units are released
if the resource is disposed mid-flight. Without an enclosing `<Suspense>`, the
resource still works; the accounting is simply a no-op.

---

## Types

```ts
interface RouteMeta {
  requiresAuth?: boolean
  layout?: string | false
  title?: string
  [k: string]: unknown
}

interface RouteDef {
  path: string
  component: Component | (() => Promise<{ default: Component }>)
  meta?: RouteMeta
}

type RouteModule = RouteDef | RouteDef[]

interface RouterProps {
  routes: Record<string, { default: RouteModule }> | RouteDef[]
  guards?: RouteGuard[]
  fallback?: Component
  scrollRestoration?: boolean
  root?: Component<{ children: any }>
}
```

---

**Next:** [Store →](./store.md) · [Workers →](./worker.md)
