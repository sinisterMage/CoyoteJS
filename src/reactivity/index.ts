// coyote/reactivity — fine-grained reactive core (SolidJS family, hand-rolled,
// zero deps). This barrel re-exports the ENTIRE public surface of the module.
//
// Algorithm: push-based dependency tracking + pull-on-read (updateIfNecessary in
// dependency order) + two-tier STALE/CHECK marking + microtask-batched effect
// flush. See ./core.ts for the shared node graph and the propagation rules.

// Public value exports.
export { signal } from './signal'
export { computed } from './computed'
export { effect } from './effect'
export { batch, untrack, flushSync } from './scheduler'
export { getOwner, createRoot, runWithOwner, onCleanup } from './owner'

// Public type exports.
export type {
  Accessor,
  Setter,
  Signal,
  SignalOptions,
  EffectOptions,
  Owner,
} from './types'
