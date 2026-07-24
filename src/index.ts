// coyote-js — the pure core: a from-scratch, TypeScript-native, fine-grained
// reactive UI framework. Signals, a no-VDOM JSX renderer, a client router, a
// typed worker-RPC pool, and a fine-grained store. Zero runtime dependencies.
//
// Prefer the subpath imports (`@sinistermage/coyote-js/reactivity`,
// `@sinistermage/coyote-js/dom`, …) in app code; this barrel re-exports
// everything for convenience.

export * from './reactivity'
export * from './dom'
export * from './router'
export * from './worker'
export * from './store'
export * from './http'
export * from './loader'

// The automatic JSX runtime (`jsxImportSource: '@sinistermage/coyote-js'`
// resolves `@sinistermage/coyote-js/jsx-runtime`).
export * from './dom/jsx-runtime'
