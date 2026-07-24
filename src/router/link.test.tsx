import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushSync } from '../reactivity'
import { render } from '../dom'
import type { Component } from '../dom'
import { Router } from './router'
import { Link } from './link'
import type { RouteDef } from './types'

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

beforeEach(() => window.history.replaceState(null, '', '/'))
afterEach(() => {
  for (const d of disposers.splice(0)) d()
  window.history.replaceState(null, '', '/')
})

const Home: Component = () => (
  <nav>
    <Link href="/about" class="nav-link" activeClass="is-active">
      About
    </Link>
    <Link href="/" class="nav-link" activeClass="is-active">
      Home
    </Link>
  </nav>
)
const About: Component = () => <div id="about">about</div>
const routes: RouteDef[] = [
  { path: '/', component: Home },
  { path: '/about', component: About },
]

/** Dispatch a plain left-click (button 0, no modifiers) that is cancelable. */
function leftClick(el: Element): MouseEvent {
  const e = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
  el.dispatchEvent(e)
  return e
}

describe('Link', () => {
  it('renders an anchor with the href and class', () => {
    const root = mount(() => Router({ routes }))
    const a = root.querySelector('a[href="/about"]') as HTMLAnchorElement
    expect(a).toBeTruthy()
    expect(a.getAttribute('class')).toContain('nav-link')
    expect(a.textContent?.trim()).toBe('About')
  })

  it('intercepts a plain left-click and navigates via the router', () => {
    const root = mount(() => Router({ routes }))
    const a = root.querySelector('a[href="/about"]') as HTMLAnchorElement
    const e = leftClick(a)
    flushSync()
    expect(e.defaultPrevented).toBe(true)
    expect(window.location.pathname).toBe('/about')
    expect(root.querySelector('#about')).toBeTruthy()
  })

  it('does NOT intercept a modified (cmd/ctrl) click', () => {
    const root = mount(() => Router({ routes }))
    const a = root.querySelector('a[href="/about"]') as HTMLAnchorElement
    const e = new window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      metaKey: true,
    })
    a.dispatchEvent(e)
    flushSync()
    expect(e.defaultPrevented).toBe(false)
    expect(window.location.pathname).toBe('/')
  })

  it('applies activeClass to the link matching the current route', () => {
    const root = mount(() => Router({ routes }))
    const homeLink = root.querySelector('a[href="/"]') as HTMLAnchorElement
    const aboutLink = root.querySelector('a[href="/about"]') as HTMLAnchorElement
    expect(homeLink.getAttribute('class')).toContain('is-active')
    expect(aboutLink.getAttribute('class')).not.toContain('is-active')
  })
})
