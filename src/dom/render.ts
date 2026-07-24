// `render(code, root)`: establish a disposal root, run `code()` under it, insert
// the produced nodes into `root`, and return a disposer that disposes the root
// (running all cleanups) and removes the inserted nodes. Initial paint is
// synchronous (flushSync), so the DOM is fully materialized before render()
// returns.

import { createRoot, flushSync } from '../reactivity'
import type { CoyoteNode } from './types'
import { insert } from './nodes'

export function render(code: () => CoyoteNode, root: Element): () => void {
  let disposeRoot!: () => void
  // Bracket our insertion with markers so the disposer removes exactly what we
  // inserted and never touches pre-existing children of `root`.
  const startMarker = document.createComment('')
  const endMarker = document.createComment('')
  root.appendChild(startMarker)
  root.appendChild(endMarker)

  createRoot((dispose) => {
    disposeRoot = dispose
    // Insert reactively before the trailing marker so live slots have a stable
    // anchor and initial content lands in document order.
    insert(root, code, endMarker)
  })

  // Flush any effects created during the initial render synchronously so the
  // first paint is complete before we return.
  flushSync()

  return () => {
    disposeRoot()
    flushSync()
    // Remove every node strictly between our two markers, then the markers.
    let node = endMarker.previousSibling
    while (node && node !== startMarker) {
      const prev = node.previousSibling
      root.removeChild(node)
      node = prev
    }
    if (startMarker.parentNode === root) root.removeChild(startMarker)
    if (endMarker.parentNode === root) root.removeChild(endMarker)
  }
}
