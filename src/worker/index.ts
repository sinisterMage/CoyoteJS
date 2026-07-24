// coyote/worker — typed worker-RPC + pool ("workers as default").
//
// This barrel re-exports the ENTIRE public surface of the module.
//
// Surface:
//   defineWorker(api)          worker-side: expose `api` over the RPC protocol.
//   spawn<T>(factory, opts?)   main-side: one Worker → typed Remote<T> proxy.
//   pool<T>(factory, opts?)    main-side: N Workers, load-balanced, + `busy`.
//   transfer(value, [xfer])    mark args/returns for zero-copy transfer.
//
// MANDATORY bundler idiom for every `factory` — emit ES module workers (e.g. Vite
// `worker: { format: 'es' }`) so the worker entry can use normal ESM imports:
//
//   () => new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })
//
// The `new URL(..., import.meta.url)` form is what lets Vite discover, bundle,
// and fingerprint the worker module — a bare string path is NOT transformed.

export { defineWorker } from './defineWorker'
export { spawn } from './spawn'
export { pool } from './pool'
export { transfer } from './transfer'

// Public type exports.
export type {
  Remote,
  StreamYield,
  SpawnOptions,
  PoolOptions,
} from './types'
