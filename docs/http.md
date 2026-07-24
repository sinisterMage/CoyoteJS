# `@sinistermage/coyote-js/http`

A small, dependency-free JSON client over `fetch`. Roughly the `ofetch`/`$fetch`
surface, with no app, config, or auth coupling — you supply the base URL and an
optional token getter.

```ts
import { createHttp, isSignedOutError } from '@sinistermage/coyote-js/http'
```

---

## `createHttp`

```ts
function createHttp(opts?: CreateHttpOptions): HttpClient

interface CreateHttpOptions {
  baseURL?: string
  getToken?: () => Promise<string | null>
}

interface HttpClient {
  <T>(path: string, opts?: HttpRequestOptions): Promise<T>
}
```

The client is **callable** — there are no `.get()`/`.post()` methods.

```ts
const api = createHttp({
  baseURL: '/api',
  getToken: async () => auth.state.token,
})

const me   = await api<User>('/me')
const list = await api<Post[]>('/posts', { query: { page: 2, tag: ['a', 'b'] } })
const made = await api<Post>('/posts', { method: 'POST', body: { title: 'Hi' } })
await api('/posts/9', { method: 'DELETE' })
```

Per request the client:

- prefixes `baseURL` (an absolute URL with a scheme ignores it),
- serializes `query` onto the URL,
- JSON-encodes a plain object/array `body` and sets `Content-Type`,
- injects `Authorization: Bearer <token>` when `getToken()` returns one,
- parses the response body, and
- throws an `HttpError` on any non-2xx status.

---

## Request options

```ts
interface HttpRequestOptions extends Omit<RequestInit, 'body'> {
  baseURL?: string
  query?: Record<string, any>
  body?: any
  responseType?: 'json' | 'text' | 'blob' | 'arrayBuffer'
}
```

Everything else from `RequestInit` — `method`, `headers`, `signal`, `credentials`,
`mode`, `cache` — passes straight through.

### `query`

```ts
api('/search', { query: { q: 'reactive', tags: ['ui', 'js'], page: null } })
// → /api/search?q=reactive&tags=ui&tags=js
```

Arrays repeat the key. `null` and `undefined` values are dropped. Everything else
is stringified.

### `body`

Plain objects and arrays are JSON-encoded, with `Content-Type: application/json`
set unless you set it yourself.

Anything the platform can already send is passed through untouched with **no**
forced header — `string`, `FormData`, `Blob`, `URLSearchParams`, `ArrayBuffer`,
typed arrays, and `ReadableStream`. You keep control of the content type:

```ts
const form = new FormData()
form.set('file', file)
await api('/upload', { method: 'POST', body: form })   // browser sets the boundary
```

### `responseType`

| Value | Result |
| --- | --- |
| unset / `'json'` | JSON-parsed; falls back to raw text if the body isn't JSON; `undefined` for an empty body. |
| `'text'` | The raw string, no parsing. |
| `'blob'` | A `Blob`. |
| `'arrayBuffer'` | An `ArrayBuffer`. |

JSON parsing is **opportunistic**, not gated on `Content-Type` — plenty of
backends send JSON error bodies without the header, and the text fallback makes a
wrong guess harmless.

### Auth

`getToken` is awaited on every request. Returning `null` sends no header — that is
a normal signed-out request, not an error:

```ts
const api = createHttp({
  baseURL: '/api',
  getToken: async () => (await session.get())?.accessToken ?? null,
})
```

---

## Errors

Any non-2xx response throws an `HttpError` — a real `Error` carrying the status
and the parsed body:

```ts
interface HttpError extends Error {
  statusCode?: number
  response?: { status?: number }   // older ofetch shape, populated too
  data?: any                       // the parsed error body
}
```

```ts
try {
  await api('/posts', { method: 'POST', body: draft })
} catch (err) {
  const e = err as HttpError
  if (e.statusCode === 422) showValidation(e.data.errors)
  else throw err
}
```

The error body is auto-parsed even for `blob`/`arrayBuffer` requests, whose error
responses are still text — so `data` stays useful.

### `isSignedOutError`

```ts
function isSignedOutError(e: unknown): boolean
```

`true` for a 401 or 403. Those mean "not signed in / not authorized" as far as the
backend is concerned — an expected state, not a failure. A **missing** status means
no response reached you at all (a transport error), which *is* a real error, and
returns `false`.

```ts
const me = createResource(true, async () => {
  try {
    return await api<User>('/me')
  } catch (err) {
    if (isSignedOutError(err)) return null   // signed out — a valid state
    throw err                                 // network/server failure — surface it
  }
})
```

---

## With `createResource`

The client composes directly with the router's resource primitive:

```tsx
const api = createHttp({ baseURL: '/api' })

function Post() {
  const params = useParams<{ id: string }>()
  const post = createResource(
    () => params().id,
    id => api<Post>(`/posts/${id}`),
  )

  return (
    <Switch fallback={<Spinner />}>
      <Match when={post.error}>{e => <Error err={e} onRetry={post.refetch} />}</Match>
      <Match when={post}>{p => <article>{p.body}</article></Match>
    </Switch>
  )
}
```

### Cancellation

Pass an `AbortSignal` through and tie it to the owner scope:

```ts
const posts = createResource(() => page(), async (p) => {
  const ac = new AbortController()
  onCleanup(() => ac.abort())
  return api<Post[]>('/posts', { query: { page: p }, signal: ac.signal })
})
```

`createResource` already ignores superseded responses, so aborting is about saving
bandwidth rather than about correctness.

---

**Next:** [WASM loader →](./loader.md) · [Reactivity →](./reactivity.md)
