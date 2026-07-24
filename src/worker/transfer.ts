// coyote/worker — zero-copy transfer marking.
//
// `postMessage(msg, transferables)` needs the list of `Transferable` objects as
// a *second* argument, but a caller only ever hands us plain values. `transfer`
// lets a caller tag a specific value with the transferables it carries; the
// poster (spawn/pool/defineWorker) reads that tag back out of a side-channel
// right before it posts, then clears it.
//
// The side-channel is a `WeakSet`-keyed map from the tagged value → its
// transferables. A WeakMap keeps this from leaking: once the caller drops the
// value the entry disappears on its own. Marking is transient — the poster
// consumes (reads + deletes) each mark so a value can be re-marked on a later
// call without carrying a stale transfer list.

const marks = new WeakMap<object, Transferable[]>()

/**
 * Mark `value` as carrying `transferables` for zero-copy transfer on the next
 * post. Returns `value` unchanged so it can be used inline as a method arg or
 * generator yield:
 *
 * ```ts
 * remote.process(transfer(buffer, [buffer]))
 * ```
 *
 * Only object values can be marked (a WeakMap key must be an object); marking a
 * primitive is a no-op — auto-detection of top-level ArrayBuffers still applies.
 */
export function transfer<T>(value: T, transferables: Transferable[]): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    marks.set(value as object, transferables)
  }
  return value
}

/**
 * Consume the transfer mark for `value`, if any: returns the recorded
 * transferables and deletes the mark so it is not reused. Returns `undefined`
 * for unmarked or primitive values.
 */
export function consumeTransfer(value: unknown): Transferable[] | undefined {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined
  }
  const key = value as object
  const list = marks.get(key)
  if (list !== undefined) marks.delete(key)
  return list
}

// A structured-clone-transferable ArrayBuffer view we auto-detect at the top
// level of an args/return list without an explicit `transfer()` mark.
function isArrayBufferView(v: unknown): v is ArrayBufferView {
  return ArrayBuffer.isView(v)
}

/**
 * Collect the transferables for a list of top-level values (method args, or a
 * single-element `[return]`), combining:
 *  - explicit `transfer()` marks (consumed here), and
 *  - auto-detected top-level `ArrayBuffer` / typed-array `.buffer`s.
 *
 * Only the *top level* is scanned — nested buffers must be marked explicitly.
 * The result is de-duplicated (posting the same Transferable twice throws).
 */
export function collectTransferables(values: readonly unknown[]): Transferable[] {
  const out: Transferable[] = []
  const seen = new Set<Transferable>()
  const add = (t: Transferable) => {
    if (!seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }

  for (const value of values) {
    const marked = consumeTransfer(value)
    if (marked) {
      for (const t of marked) add(t)
    }
    if (value instanceof ArrayBuffer) {
      add(value)
    } else if (isArrayBufferView(value)) {
      // Transfer the backing buffer of a typed array / DataView.
      const buf = value.buffer
      if (buf instanceof ArrayBuffer) add(buf)
    }
  }

  return out
}
