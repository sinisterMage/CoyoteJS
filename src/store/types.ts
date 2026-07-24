// Public type surface for coyote/store.

/** A deep reactive proxy over a plain object `T`. */
export type Store<T extends object> = T
/** Path-based setter returned alongside a store proxy. */
export type SetStoreFunction<T> = (...path: any[]) => void

/** The `{ state, actions }` shape a `defineStore` singleton exposes. */
export interface StoreApi<S extends object, A> {
  state: S
  actions: A
}
