// coyote/store — signal-backed store primitive (createStore + defineStore), the
// Pinia replacement on top of coyote/reactivity.
//
// This barrel exports the real implementation and the module's public types.

// Public value exports (real implementation).
export { createStore, produce, reconcile, defineStore, useStore } from './store'

// Public type exports.
export type { Store, SetStoreFunction, StoreApi } from './types'
