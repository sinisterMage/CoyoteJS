// coyote/worker — `pool`: N identical workers behind one typed proxy.
//
//   const p = pool<MyApi>(
//     () => new Worker(new URL('./my.worker.ts', import.meta.url), { type: 'module' }),
//     { size: navigator.hardwareConcurrency },
//   )
//   await p.compute(...)   // dispatched to the least-busy worker
//   p.busy                 // number of workers currently mid-call
//   p.terminate()          // tears every worker down
//
// Routing is round-robin but *backpressure-aware*: each call goes to the worker
// with the fewest in-flight invocations (ties broken by a rotating cursor), so a
// slow call never starves the others. Same `factory`/Vite idiom as `spawn`.

import { WorkerClient, type WorkerLike } from './client'
import { makeRemoteProxy } from './spawn'
import type { PoolOptions, Remote } from './types'

const DEFAULT_SIZE = 4

/**
 * Create a pool of `size` identical workers and return a typed `Remote<T>` proxy
 * with `terminate()` and a live `busy` count. `size` defaults to 4 and is
 * clamped to at least 1.
 */
export function pool<T>(
  factory: () => Worker,
  opts?: PoolOptions,
): Remote<T> & { terminate(): void; readonly busy: number } {
  const size = Math.max(1, Math.floor(opts?.size ?? DEFAULT_SIZE))

  const clients: WorkerClient[] = []
  for (let i = 0; i < size; i++) {
    clients.push(new WorkerClient(factory() as unknown as WorkerLike))
  }

  // Rotating cursor so equal-load workers are still spread round-robin.
  let cursor = 0
  const pickClient = (): WorkerClient => {
    let best = clients[cursor % size]
    let bestLoad = best.inflight
    for (let step = 1; step < size; step++) {
      const c = clients[(cursor + step) % size]
      if (c.inflight < bestLoad) {
        best = c
        bestLoad = c.inflight
      }
    }
    cursor = (cursor + 1) % size
    return best
  }

  const extra = {
    terminate: () => {
      for (const c of clients) c.terminate()
    },
    // `busy` = workers with at least one in-flight invocation.
    get busy() {
      let n = 0
      for (const c of clients) if (c.inflight > 0) n++
      return n
    },
  }

  return makeRemoteProxy<T>(pickClient, extra) as Remote<T> & {
    terminate(): void
    readonly busy: number
  }
}
