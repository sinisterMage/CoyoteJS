import { afterEach, describe, expect, it, vi } from 'vitest'
// dom code from the local modules; reactivity from the sibling reactivity module.
import { computed, flushSync, signal } from '../reactivity'
import { render } from './render'
import { onCleanup } from './lifecycle'
import { For, Index, Show, Switch, Match } from './control-flow'
import { h } from './h'

// Render into a detached container and always dispose after each test.
let disposers: Array<() => void> = []
function mount(code: () => any): HTMLElement {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const dispose = render(code, root)
  disposers.push(() => {
    dispose()
    root.remove()
  })
  return root
}
afterEach(() => {
  for (const d of disposers.splice(0)) d()
})

describe('control-flow re-entrancy (same accessor drives when + body)', () => {
  // The core bug: a falsy→truthy transition where the branch BODY reads the SAME
  // live-changing accessor that drives `when`. When that accessor is a shared memo
  // (the realistic case — a derived condition), the transition recomputes the memo
  // mid-mount; the memo's change re-enqueues the control-flow effect, and
  // materializing the body creates a nested reactive slot whose synchronous flush
  // re-enters the control-flow effect BEFORE `branch.nodes` is assigned — a null
  // deref at `branch!.nodes` (control-flow.ts:205). The direct-read variants are
  // regression guards for the same shape without the memo.

  // --- Show, driven by a shared memo (the confirmed crash) ---
  it('Show: memo drives when AND body — survives falsy→truthy without null deref', () => {
    const [n, setN] = signal(0)
    const gate = computed(() => n() >= 1)
    const root = mount(() =>
      Show({
        when: () => gate(),
        children: (() =>
          h('span', { id: 'lbl' }, () => (gate() ? `${n()}s` : ''))) as any,
      }),
    )
    expect(root.querySelector('#lbl')).toBeNull()

    setN(1) // falsy → truthy; body reads the same memo the when reads
    flushSync()

    const lbl = root.querySelector('#lbl')
    expect(lbl).toBeTruthy()
    expect(lbl?.textContent).toBe('1s')
  })

  it('Show: memo-driven body keeps updating on subsequent changes and tears down', () => {
    const [n, setN] = signal(0)
    const gate = computed(() => n() >= 1)
    const root = mount(() =>
      Show({
        when: () => gate(),
        children: (() =>
          h('span', { id: 'lbl' }, () => (gate() ? `${n()}s` : ''))) as any,
      }),
    )
    setN(1)
    flushSync()
    expect(root.querySelector('#lbl')?.textContent).toBe('1s')

    setN(2)
    flushSync()
    expect(root.querySelector('#lbl')?.textContent).toBe('2s')

    // truthy → falsy tears the branch down
    setN(0)
    flushSync()
    expect(root.querySelector('#lbl')).toBeNull()

    // and back again
    setN(3)
    flushSync()
    expect(root.querySelector('#lbl')?.textContent).toBe('3s')
  })

  it('Show: memo-driven body still runs cleanup exactly once on unmount', () => {
    const cleanup = vi.fn()
    const [n, setN] = signal(0)
    const gate = computed(() => n() >= 1)
    const root = mount(() =>
      Show({
        when: () => gate(),
        children: (() => {
          onCleanup(cleanup)
          return h('span', { id: 'lbl' }, () => (gate() ? `${n()}s` : ''))
        }) as any,
      }),
    )
    setN(1)
    flushSync()
    expect(root.querySelector('#lbl')?.textContent).toBe('1s')
    expect(cleanup).not.toHaveBeenCalled()

    setN(0)
    flushSync()
    expect(root.querySelector('#lbl')).toBeNull()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  // --- Show, keyed: memo drives when, keyed value changes trigger a re-mount ---
  it('Show keyed: memo-driven re-mount with body reading the driver', () => {
    const [n, setN] = signal(0)
    const gate = computed(() => (n() >= 1 ? n() : null))
    const root = mount(() =>
      Show({
        when: () => gate(),
        keyed: true,
        children: ((v: number) =>
          h('span', { id: 'lbl' }, () => `${v}:${n()}`)) as any,
      }),
    )
    setN(1)
    flushSync()
    expect(root.querySelector('#lbl')?.textContent).toBe('1:1')

    setN(2) // keyed value changes → re-mount; body reads the same memo
    flushSync()
    expect(root.querySelector('#lbl')?.textContent).toBe('2:2')
  })

  // --- Switch / Match ---
  it('Switch/Match: memo drives when AND body — survives the transition', () => {
    const [n, setN] = signal(0)
    const gate = computed(() => n() >= 1)
    const root = mount(() =>
      Switch({
        children: [
          Match({
            when: () => gate(),
            children: (() =>
              h('b', { id: 'lbl' }, () => (gate() ? `${n()}!` : ''))) as any,
          }),
        ],
      }),
    )
    expect(root.querySelector('#lbl')).toBeNull()

    setN(1)
    flushSync()
    expect(root.querySelector('#lbl')?.textContent).toBe('1!')

    setN(2)
    flushSync()
    expect(root.querySelector('#lbl')?.textContent).toBe('2!')
  })

  // --- For / Index (regression guards: these were already robust; the memo
  //     that gates the list length is the SAME one each row body reads) ---
  const rowTexts = (root: HTMLElement) =>
    [...root.querySelectorAll('.row')].map((e) => e.textContent)

  it('For: rows reading the length-gating memo survive grow/shrink/regrow', () => {
    const [n, setN] = signal(0)
    const gate = computed(() => n() >= 1)
    const items = computed<number[]>(() => (gate() ? [1, 2] : []))
    const root = mount(() =>
      For({
        each: items,
        children: ((it: number) =>
          h('span', { class: 'row' }, () => (gate() ? `${it}:${n()}` : 'x'))) as any,
      }),
    )
    expect(root.querySelectorAll('.row').length).toBe(0)

    setN(1)
    flushSync()
    expect(rowTexts(root)).toEqual(['1:1', '2:1'])

    setN(2)
    flushSync()
    expect(rowTexts(root)).toEqual(['1:2', '2:2'])

    setN(0)
    flushSync()
    expect(root.querySelectorAll('.row').length).toBe(0)

    setN(3)
    flushSync()
    expect(rowTexts(root)).toEqual(['1:3', '2:3'])
  })

  it('Index: rows reading the length-gating memo survive grow/shrink/regrow', () => {
    const [n, setN] = signal(0)
    const gate = computed(() => n() >= 1)
    const items = computed<number[]>(() => (gate() ? [10, 20] : []))
    const root = mount(() =>
      Index({
        each: items,
        children: ((it: () => number) =>
          h('span', { class: 'row' }, () => (gate() ? `${it()}:${n()}` : 'x'))) as any,
      }),
    )
    expect(root.querySelectorAll('.row').length).toBe(0)

    setN(1)
    flushSync()
    expect(rowTexts(root)).toEqual(['10:1', '20:1'])

    setN(2)
    flushSync()
    expect(rowTexts(root)).toEqual(['10:2', '20:2'])

    setN(0)
    flushSync()
    expect(root.querySelectorAll('.row').length).toBe(0)
  })

  // --- Direct-read regression guards (no memo, same shape) ---
  it('Show: direct same-accessor read survives falsy→truthy', () => {
    const [n, setN] = signal(0)
    const root = mount(() =>
      Show({
        when: () => n() >= 1,
        children: (() =>
          h('span', { id: 'lbl' }, () => (n() >= 1 ? `${n()}s` : ''))) as any,
      }),
    )
    setN(1)
    flushSync()
    expect(root.querySelector('#lbl')?.textContent).toBe('1s')
  })
})
