// coyote/worker — main-thread `spawn`: one Worker → a fully-typed proxy.
//
// MANDATORY bundler idiom for `factory` — emit ES module workers (e.g. Vite
// `worker: { format: 'es' }`) so the worker module can use normal ESM imports:
//
//   const remote = spawn<MyApi>(
//     () => new Worker(new URL('./my.worker.ts', import.meta.url), { type: 'module' }),
//   )
//   const result = await remote.compute(2, 3)          // normal method
//   for await (const c of remote.progress()) { … }      // async-generator method
//   remote.terminate()
//
// The `URL(..., import.meta.url)` form is what lets Vite discover, bundle, and
// fingerprint the worker entry — a bare string path will NOT be transformed.

import { WorkerClient, type WorkerLike } from './client'
import type { Remote, SpawnOptions } from './types'

// A method name we should never proxy as an RPC call. `terminate` is the
// control method; the rest are Promise/thenable/inspection hooks that some
// runtimes probe on unknown objects.
const RESERVED = new Set<PropertyKey>([
  'terminate',
  'then', // never make the proxy itself thenable
  'catch',
  'finally',
  Symbol.asyncIterator,
  Symbol.iterator,
  Symbol.toPrimitive,
  Symbol.toStringTag,
  // Common structured-clone / inspection probes.
  'toJSON',
])

// Build the typed Proxy around a WorkerClient. Shared by spawn (one client) and
// pool (a client chosen per-call by the router).
export function makeRemoteProxy<T>(
  pickClient: () => WorkerClient,
  extra: Record<PropertyKey, unknown>,
): Remote<T> & typeof extra {
  // Cache one bound method function per name so repeated `remote.foo` reads
  // return a stable reference (matches how a real object behaves).
  const methodCache = new Map<string, (...args: unknown[]) => unknown>()

  const target = extra as Record<PropertyKey, unknown>

  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      if (prop in t || RESERVED.has(prop)) {
        return Reflect.get(t, prop, receiver)
      }
      if (typeof prop !== 'string') return undefined

      let fn = methodCache.get(prop)
      if (!fn) {
        fn = (...args: unknown[]) => pickClient().invoke(prop, args)
        methodCache.set(prop, fn)
      }
      return fn
    },
    // Keep the proxy honest: only the real control props are "own"/enumerable.
    has(t, prop) {
      return prop in t
    },
  })

  return proxy as Remote<T> & typeof extra
}

/**
 * Spawn one worker and return a fully-typed `Remote<T>` proxy plus `terminate()`.
 * Every access `remote.method` returns a function that posts an RPC request and
 * returns the awaitable/iterable handle described in ./client.
 */
export function spawn<T>(
  factory: () => Worker,
  opts?: SpawnOptions,
): Remote<T> & { terminate(): void } {
  void opts // name/type/credentials are honored by the caller's `factory`; kept for API symmetry.
  const client = new WorkerClient(factory() as unknown as WorkerLike)
  return makeRemoteProxy<T>(
    () => client,
    { terminate: () => client.terminate() },
  ) as Remote<T> & { terminate(): void }
}
