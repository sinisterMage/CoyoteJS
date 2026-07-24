# `@sinistermage/coyote-js/worker`

Typed worker RPC. Export an object from a worker file, call its methods from the
main thread as if they were local — with full type inference, streaming via async
generators, and zero-copy transfers.

```ts
import { defineWorker, spawn, pool, transfer } from '@sinistermage/coyote-js/worker'
```

No `postMessage` switch statements, no message-type enums, no manual correlation
ids.

---

## Bundler setup (required)

Workers must be emitted as **ES modules** so the worker entry can use normal
imports:

```ts
// vite.config.ts
export default defineConfig({
  worker: { format: 'es' },
})
```

And every worker factory must use the `new URL(..., import.meta.url)` form. This
is what lets the bundler discover, bundle, and fingerprint the worker module — a
bare string path is **not** transformed and will 404 in production:

```ts
() => new Worker(new URL('./my.worker.ts', import.meta.url), { type: 'module' })
```

---

## The worker side: `defineWorker`

```ts
function defineWorker<T extends Record<string, Function>>(api: T, scope?: WorkerScope): void
```

Call it as the only top-level statement of a `*.worker.ts` file. It installs one
`onmessage` handler that routes each request to the matching method.

```ts
// src/workers/image.worker.ts
import { defineWorker } from '@sinistermage/coyote-js/worker'

const api = {
  resize(bytes: ArrayBuffer, width: number): ArrayBuffer {
    return doResize(bytes, width)
  },

  async classify(bytes: ArrayBuffer): Promise<string[]> {
    const model = await loadModel()
    return model.predict(bytes)
  },

  async *process(files: ArrayBuffer[]): AsyncGenerator<Progress, Summary> {
    for (let i = 0; i < files.length; i++) {
      yield { done: i + 1, total: files.length }
    }
    return { processed: files.length }
  },
}

export type ImageApi = typeof api
defineWorker(api)
```

Export the API **type** so the main thread can use it. The type crosses the
boundary; the implementation never does.

Errors thrown or rejected inside a method are serialized (`name`, `message`,
`stack`) and re-thrown as a real `Error` on the main thread, with the stack intact.

---

## The main side: `spawn`

```ts
function spawn<T>(factory: () => Worker, opts?: SpawnOptions): Remote<T> & { terminate(): void }
```

One worker, one typed proxy.

```ts
import { spawn } from '@sinistermage/coyote-js/worker'
import type { ImageApi } from './workers/image.worker'

const images = spawn<ImageApi>(
  () => new Worker(new URL('./workers/image.worker.ts', import.meta.url), { type: 'module' }),
)

const resized = await images.resize(bytes, 800)
const tags    = await images.classify(bytes)

images.terminate()
```

`Remote<T>` maps the API type mechanically:

```ts
type Remote<T> = {
  [K in keyof T]:
    T[K] extends (...a: infer A) => AsyncGenerator<infer Y, infer R, any>
      ? (...a: A) => AsyncIterable<Y> & Promise<R>      // stream + return value
    : T[K] extends (...a: infer A) => infer R
      ? (...a: A) => Promise<Awaited<R>>                // everything else
    : never
}
```

Every method becomes async. Argument and return types are preserved exactly, so a
typo or a wrong argument type is a **compile error**, not a runtime silence.

---

## Streaming with async generators

An async-generator method returns a handle that is **both** a promise and an
async-iterable. Iterate it for the yields, await it for the return value:

```ts
// stream the yields
for await (const progress of images.process(files)) {
  setProgress(progress.done / progress.total)
}

// or await the final return value
const summary = await images.process(files)
```

A throw mid-stream rejects the promise face and throws from the active iterator.
Breaking out of the loop early stops delivery.

The main thread never has to know which shape a method has — the handle adapts to
whichever frames come back.

---

## `pool`

```ts
function pool<T>(factory: () => Worker, opts?: PoolOptions):
  Remote<T> & { terminate(): void; readonly busy: number }
```

N identical workers behind one proxy. Same call syntax, work spread across cores.

```ts
const workers = pool<ImageApi>(
  () => new Worker(new URL('./workers/image.worker.ts', import.meta.url), { type: 'module' }),
  { size: navigator.hardwareConcurrency ?? 4 },
)

// dispatched to the least-busy worker
const results = await Promise.all(files.map(f => workers.resize(f, 800)))

workers.busy        // how many workers currently have work in flight
workers.terminate() // tears every worker down
```

Routing is round-robin but **backpressure-aware**: each call goes to the worker
with the fewest in-flight invocations, with a rotating cursor breaking ties. One
slow call never starves the rest.

`size` defaults to `4` and is clamped to at least `1`.

### Options

```ts
interface SpawnOptions {
  name?: string
  type?: 'module'
  credentials?: RequestCredentials
}
interface PoolOptions extends SpawnOptions {
  size?: number
}
```

`name`/`type`/`credentials` are honored by your own `factory` — they exist on the
options object for API symmetry.

---

## `transfer`

```ts
function transfer<T>(value: T, transferables: Transferable[]): T
```

Move a buffer instead of copying it. Returns the value unchanged, so it drops
straight into a call:

```ts
await workers.resize(transfer(bytes, [bytes]), 800)
```

**Top-level `ArrayBuffer`s and typed arrays are auto-detected** — you only need
`transfer` for buffers nested inside another object:

```ts
await workers.render(transfer({ pixels, meta }, [pixels.buffer]))
```

The transferred buffer is **detached** in the sending context: after the call,
`bytes.byteLength === 0` on your side. That is the point — it's a move, not a copy
— but it means you cannot reuse the buffer afterward.

Marks are consumed on post, so the same value can be re-marked for a later call
without carrying a stale transfer list.

---

## Lifecycle

```ts
function useImageWorker() {
  const worker = spawn<ImageApi>(
    () => new Worker(new URL('./image.worker.ts', import.meta.url), { type: 'module' }),
  )
  onCleanup(() => worker.terminate())
  return worker
}
```

`terminate()` fails every in-flight invocation with
`Error: coyote/worker: client terminated`, and any call made after termination
rejects immediately.

Calls dispatch **eagerly** — invoking a remote method posts the request and counts
toward pool load whether or not you await the handle. Replies buffer until
consumed.

---

## Wire protocol

For debugging, or if you want to talk to a coyote worker from something else:

| Direction | Frame |
| --- | --- |
| → worker | `{ id, method, args }` |
| ← normal return | `{ id, ok: true, result }` |
| ← error | `{ id, ok: false, error }` or `{ id, error }` mid-stream |
| ← generator yield | `{ id, chunk }` |
| ← generator done | `{ id, done: true, result }` |

Unknown frame shapes are ignored, so the protocol can be extended without
breaking existing clients.

---

## Types

```ts
type StreamYield<T> = AsyncIterable<T>

interface WorkerScope {
  onmessage: ((this: unknown, ev: MessageEvent) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}
```

`defineWorker`'s second parameter defaults to the worker global (`self`); tests
can inject a `MessagePort`-backed shim to exercise dispatch without a real Worker.

---

**Next:** [HTTP →](./http.md) · [WASM loader →](./loader.md)
