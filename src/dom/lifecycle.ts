// Component lifecycle. `onMount(fn)` runs `fn` once after the current render's
// nodes have been attached — we approximate "after attach" by deferring to a
// microtask (render() flushes synchronously, then the microtask runs with the
// tree already in the document). `onCleanup` is re-exported from the reactivity
// core (registers on the current owner scope).

export { onCleanup } from '../reactivity'

export function onMount(fn: () => void): void {
  queueMicrotask(() => fn())
}
