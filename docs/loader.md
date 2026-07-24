# `@sinistermage/coyote-js/loader`

A generic WASM loader with reactive progress. Fires the module and data requests
**at once**, compiles the WASM *while it streams*, and hands you one promise plus
signals you can bind straight into a loading screen.

```ts
import { loadWasm, loadGame } from '@sinistermage/coyote-js/loader'
```

No nested `.then` chains, no framework or format knowledge — its only dependency
is the reactivity core, for the progress signals.

---

## `loadWasm`

```ts
function loadWasm(opts: LoadWasmOptions): {
  handle: WasmHandle
  done: Promise<WasmHandle>
}

interface LoadWasmOptions {
  wasmUrl?: string      // the .wasm module to fetch + compile
  dataUrl?: string      // an optional companion blob, read into a Uint8Array
  signal?: AbortSignal  // aborts both in-flight requests
}

interface WasmHandle {
  module?: WebAssembly.Module
  data?: Uint8Array
  progress: LoadProgress
}

interface LoadProgress {
  phase: Accessor<LoadPhase>    // 'idle' | 'fetching' | 'compiling' | 'ready' | 'error'
  percent: Accessor<number>     // 0 → 5 → 50 → 100
  error: Accessor<unknown>
}
```

`handle.progress` is available **synchronously**, before anything has loaded — so
you can render a progress UI on the first frame. `done` resolves with the
populated handle, or rejects on any fetch/compile failure or abort.

```ts
const { handle, done } = loadWasm({
  wasmUrl: '/engine.wasm',
  dataUrl: '/assets.bin',
})

const { module, data } = await done
const instance = await WebAssembly.instantiate(module!, imports)
```

Both URLs are optional: pass just `wasmUrl` to compile a module, just `dataUrl` to
fetch a blob, or both to do them in parallel.

---

## Reactive loading screen

```tsx
function Loading() {
  const { handle, done } = loadWasm({ wasmUrl: '/engine.wasm', dataUrl: '/assets.bin' })
  const { phase, percent, error } = handle.progress

  onMount(() => { void done.then(start).catch(() => {}) })

  return (
    <Switch>
      <Match when={() => phase() === 'error'}>
        <p class="error">Failed to load: {() => String(error())}</p>
      </Match>
      <Match when={() => phase() !== 'ready'}>
        <div class="bar"><div class="fill" style={{ width: () => `${percent()}%` }} /></div>
        <p>{phase}</p>
      </Match>
    </Switch>
  )
}
```

### Phases

| Phase | `percent` | Meaning |
| --- | --- | --- |
| `idle` | 0 | Created, nothing started yet. |
| `fetching` | 5 | Both requests are in flight. |
| `compiling` | 50 | Responses arrived; compiling the module and reading the data bytes. |
| `ready` | 100 | `handle.module` / `handle.data` are populated. |
| `error` | — | `progress.error()` holds the failure. |

`percent` is a coarse phase indicator, not a byte counter — it marks progress
through the pipeline rather than tracking download bytes.

---

## Streaming compilation

When the server sends `Content-Type: application/wasm`, the module is compiled via
`WebAssembly.compileStreaming` — compilation overlaps the download instead of
waiting for it.

If the header is missing (some dev servers omit it, as do mocked fetches), the
loader buffers once and falls back to `WebAssembly.compile`. It works either way,
but **serve `.wasm` with the right content type** to get the streaming path.

---

## Cancellation

```ts
const ac = new AbortController()
const { handle, done } = loadWasm({ wasmUrl: '/engine.wasm', signal: ac.signal })

onCleanup(() => ac.abort())

done.catch(err => {
  if (err.name !== 'LoadAbortError') report(err)
})
```

Aborting rejects `done` and sets `phase` to `'error'`. If the signal carries an
`Error` reason, that reason is used; otherwise you get a `LoadAbortError`. The
signal is checked before starting and again after both requests settle.

---

## `loadGame`

```ts
export const loadGame = loadWasm
```

A straight alias, for callers who prefer that name. Same signature, same behavior.

---

## Notes

- **The module is compiled, not instantiated.** You get a `WebAssembly.Module` and
  call `WebAssembly.instantiate(module, imports)` yourself — the loader has no
  opinion about your import object.
- **Requests use `cache: 'no-cache'`**, so a revalidation always happens. Version
  your asset URLs (`/engine.abc123.wasm`) if you want long-lived caching.
- **`percent` is declared with `equals: false`**, so every phase transition
  notifies even if the number repeats.
- If one request fails first, the loser's later rejection is swallowed rather than
  surfacing as an unhandled promise rejection.

---

**Next:** [Reactivity →](./reactivity.md) · [Workers →](./worker.md)
