import { afterEach, describe, expect, it } from 'vitest'
// dom code from the local modules; reactivity from the sibling reactivity module.
import { flushSync, signal } from '../reactivity'
import { h, isSvgTag } from './h'
import { render } from './render'

const SVG_NS = 'http://www.w3.org/2000/svg'
const XHTML_NS = 'http://www.w3.org/1999/xhtml'

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

describe('SVG namespacing in h()', () => {
  it('creates <svg> in the SVG namespace', () => {
    const root = mount(() => h('svg', null))
    const svg = root.querySelector('svg')!
    expect(svg).toBeTruthy()
    expect(svg.namespaceURI).toBe(SVG_NS)
  })

  it('namespaces vector descendants (path/rect/circle/g) as SVG', () => {
    const root = mount(() =>
      h(
        'svg',
        { viewBox: '0 0 10 10' },
        h('g', null, h('path', { d: 'M0 0h1v1z' }), h('rect', { width: '2', height: '2' })),
        h('circle', { cx: '5', cy: '5', r: '3' }),
      ),
    )
    for (const tag of ['g', 'path', 'rect', 'circle']) {
      const el = root.querySelector(tag)!
      expect(el, `<${tag}> exists`).toBeTruthy()
      expect(el.namespaceURI, `<${tag}> namespace`).toBe(SVG_NS)
    }
    // And these are real SVG elements, not HTMLUnknownElement.
    expect(root.querySelector('path') instanceof SVGElement).toBe(true)
  })

  it('sets viewBox/d/fill/stroke as attributes on SVG elements', () => {
    const root = mount(() =>
      h(
        'svg',
        { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor' },
        h('path', { d: 'M4 4L20 20', stroke: '#f00' }),
      ),
    )
    const svg = root.querySelector('svg')!
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg.getAttribute('fill')).toBe('none')
    expect(svg.getAttribute('stroke')).toBe('currentColor')
    const path = root.querySelector('path')!
    expect(path.getAttribute('d')).toBe('M4 4L20 20')
    expect(path.getAttribute('stroke')).toBe('#f00')
  })

  it('applies `class` on an SVG element via setAttribute (not .className)', () => {
    // .className is read-only on SVGElement — a wrong binding would throw or no-op.
    const root = mount(() => h('svg', { class: 'icon big' }, h('path', { class: 'stroke' })))
    const svg = root.querySelector('svg')!
    expect(svg.getAttribute('class')).toBe('icon big')
    expect(root.querySelector('path')!.getAttribute('class')).toBe('stroke')
  })

  it('supports reactive class + attribute bindings on SVG', () => {
    const [cls, setCls] = signal('a')
    const [d, setD] = signal('M0 0')
    const root = mount(() => h('svg', null, h('path', { class: cls, d })))
    const path = root.querySelector('path')!
    expect(path.getAttribute('class')).toBe('a')
    expect(path.getAttribute('d')).toBe('M0 0')
    setCls('b')
    setD('M1 1')
    flushSync()
    expect(path.getAttribute('class')).toBe('b')
    expect(path.getAttribute('d')).toBe('M1 1')
  })

  it("keeps a foreignObject's HTML child in the XHTML namespace", () => {
    const root = mount(() =>
      h(
        'svg',
        null,
        h('foreignObject', { width: '100', height: '100' }, h('div', { class: 'label' }, 'hi')),
      ),
    )
    const fo = root.querySelector('foreignObject')!
    expect(fo.namespaceURI, 'foreignObject is SVG').toBe(SVG_NS)
    const div = root.querySelector('div.label')!
    expect(div.namespaceURI, 'foreignObject HTML child is XHTML').toBe(XHTML_NS)
    expect(div.textContent).toBe('hi')
    // The HTML child gets real HTMLElement behavior (className writable).
    expect(div instanceof HTMLElement).toBe(true)
  })

  it('leaves plain HTML elements in the HTML namespace', () => {
    const root = mount(() => h('div', null, h('span', null, 'x')))
    expect(root.querySelector('div')!.namespaceURI).toBe(XHTML_NS)
    expect(root.querySelector('span')!.namespaceURI).toBe(XHTML_NS)
  })

  it('exposes isSvgTag for the known-SVG-tag set', () => {
    for (const t of ['svg', 'path', 'rect', 'circle', 'g', 'defs', 'linearGradient', 'stop']) {
      expect(isSvgTag(t), `${t} is SVG`).toBe(true)
    }
    for (const t of ['div', 'span', 'button', 'input', 'p']) {
      expect(isSvgTag(t), `${t} is not SVG`).toBe(false)
    }
  })
})
