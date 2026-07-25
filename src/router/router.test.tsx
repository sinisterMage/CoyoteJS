import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync } from '../reactivity'
import { render, Suspense } from '../dom'
import type { Component } from '../dom'
import { Router, navigate, useParams, useRoute, useSearchParams } from './router'
import { createResource } from './resource'
import { Link } from './link'
import type { RouteDef, RouteGuard } from './types'

// --- harness ---------------------------------------------------------------

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

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

beforeEach(() => {
  // Reset to a known location before each test.
  window.history.replaceState(null, '', '/')
})
afterEach(() => {
  for (const d of disposers.splice(0)) d()
  window.history.replaceState(null, '', '/')
})

// --- fixtures --------------------------------------------------------------

const Home: Component = () => <div id="home">home</div>
const About: Component = () => <div id="about">about</div>

const BuilderView: Component = () => {
  const params = useParams<{ id: string }>()
  return <div id="builder">builder:{() => params().id}</div>
}

const routes: RouteDef[] = [
  { path: '/', component: Home },
  { path: '/about', component: About },
  { path: '/builder/[id]', component: BuilderView, meta: { title: 'Builder' } },
]

// --- tests -----------------------------------------------------------------

describe('Router matching + navigation', () => {
  it('renders the component matching the initial location', () => {
    window.history.replaceState(null, '', '/about')
    const root = mount(() => Router({ routes }))
    expect(root.querySelector('#about')).toBeTruthy()
    expect(root.querySelector('#home')).toBeFalsy()
  })

  it('navigate() swaps the rendered route and updates useRoute', () => {
    let seen = ''
    const Probe: Component = () => {
      const route = useRoute()
      return <span id="probe">{() => ((seen = route().path), route().path)}</span>
    }
    const root = mount(() =>
      Router({ routes: [{ path: '/', component: Probe }, { path: '/about', component: About }] }),
    )
    expect(root.querySelector('#probe')?.textContent).toBe('/')

    navigate('/about')
    flushSync()
    expect(root.querySelector('#about')).toBeTruthy()
    expect(window.location.pathname).toBe('/about')
  })

  it('extracts and exposes :params reactively', () => {
    window.history.replaceState(null, '', '/builder/7')
    const root = mount(() => Router({ routes }))
    expect(root.querySelector('#builder')?.textContent).toBe('builder:7')

    navigate('/builder/99')
    flushSync()
    // Same route, param change — component stays, param text updates.
    expect(root.querySelector('#builder')?.textContent).toBe('builder:99')
  })

  it('renders the fallback for an unmatched path', () => {
    const NotFound: Component = () => <div id="nf">404</div>
    window.history.replaceState(null, '', '/nowhere')
    const root = mount(() => Router({ routes, fallback: NotFound }))
    expect(root.querySelector('#nf')?.textContent).toBe('404')
  })

  it('wraps the matched route in a root shell when provided', () => {
    const Shell: Component<{ children: any }> = (props) => (
      <div id="shell">shell:{props.children as any}</div>
    )
    const root = mount(() => Router({ routes, root: Shell }))
    expect(root.querySelector('#shell')).toBeTruthy()
    expect(root.querySelector('#shell #home')).toBeTruthy()
  })

  it('renders the root shell inside the router context (<Link> + hooks work)', () => {
    // A persistent shell's whole job is app-level chrome — a nav with
    // active-link styling, a consent banner. That needs the router context, so
    // the shell must render INSIDE the provider, not above it.
    const Shell: Component<{ children: any }> = (props) => (
      <div id="shell">
        <Link href="/about" activeClass="on">
          about
        </Link>
        <span id="at">{() => useRoute()().path}</span>
        {props.children as any}
      </div>
    )
    const root = mount(() => Router({ routes, root: Shell }))
    expect(root.querySelector('#at')?.textContent).toBe('/')
    expect(root.querySelector('#shell a')?.getAttribute('href')).toBe('/about')

    // The shell persists across navigation and its Link picks up activeClass.
    navigate('/about')
    flushSync()
    expect(root.querySelector('#shell #about')).toBeTruthy()
    expect(root.querySelector('#at')?.textContent).toBe('/about')
    expect(root.querySelector('#shell a')?.getAttribute('class')).toContain('on')
  })

  it('responds to popstate (back/forward)', () => {
    const root = mount(() => Router({ routes }))
    navigate('/about')
    flushSync()
    expect(root.querySelector('#about')).toBeTruthy()

    // jsdom has no real session history (history.back() is a no-op that never
    // fires popstate), so simulate the browser's back navigation: restore the URL
    // and dispatch the popstate event our router listens for.
    window.history.replaceState(null, '', '/')
    window.dispatchEvent(new window.PopStateEvent('popstate', { state: null }))
    flushSync()
    expect(window.location.pathname).toBe('/')
    expect(root.querySelector('#home')).toBeTruthy()
  })
})

describe('guards', () => {
  it('redirects when a guard returns a path string', async () => {
    const guard: RouteGuard = (to) => (to.path === '/about' ? '/' : undefined)
    const root = mount(() => Router({ routes, guards: [guard] }))
    navigate('/about')
    await tick()
    flushSync()
    // Guard redirected /about → /, so home renders and the URL is /.
    expect(root.querySelector('#home')).toBeTruthy()
    expect(window.location.pathname).toBe('/')
  })

  it('supports an async guard that redirects', async () => {
    const guard: RouteGuard = async (to) => {
      await Promise.resolve()
      return to.path === '/about' ? '/' : undefined
    }
    const root = mount(() => Router({ routes, guards: [guard] }))
    navigate('/about')
    await tick()
    flushSync()
    expect(root.querySelector('#home')).toBeTruthy()
    expect(window.location.pathname).toBe('/')
  })

  it('breaks a cyclic redirect chain instead of hanging', () => {
    // /a → /b → /a → … would recurse forever without the redirect cap.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const guard: RouteGuard = (to) =>
      to.path === '/about' ? '/loop' : to.path === '/loop' ? '/about' : undefined
    const loopRoutes: RouteDef[] = [...routes, { path: '/loop', component: () => <div id="loop" /> }]
    mount(() => Router({ routes: loopRoutes, guards: [guard] }))
    navigate('/about')
    flushSync()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('allows navigation when guards return void', async () => {
    let ran = 0
    const guard: RouteGuard = () => {
      ran++
    }
    const root = mount(() => Router({ routes, guards: [guard] }))
    navigate('/about')
    await tick()
    flushSync()
    expect(ran).toBeGreaterThan(0)
    expect(root.querySelector('#about')).toBeTruthy()
  })

  // A guard that only covered in-app navigation would be worthless for auth: a
  // hard refresh, a bookmark or a shared link goes straight to the initial
  // location without ever calling navigate().
  it('runs guards for the INITIAL location, not just navigate()', () => {
    const seen: string[] = []
    const guard: RouteGuard = (to) => {
      seen.push(to.path)
      return to.path === '/about' ? '/' : undefined
    }
    window.history.replaceState(null, '', '/about')
    const root = mount(() => Router({ routes, guards: [guard] }))
    flushSync()

    expect(seen).toContain('/about')
    expect(root.querySelector('#about')).toBeFalsy()
    expect(root.querySelector('#home')).toBeTruthy()
    expect(window.location.pathname).toBe('/')
  })

  it('renders nothing (not the page, not the 404) while an async initial guard settles', async () => {
    const NotFound: Component = () => <div id="nf">404</div>
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const guard: RouteGuard = async (to) => {
      await gate
      return to.path === '/about' ? '/' : undefined
    }
    window.history.replaceState(null, '', '/about')
    const root = mount(() => Router({ routes, guards: [guard], fallback: NotFound }))
    flushSync()

    // Mid-flight: the guarded page must not paint, and "still deciding" must not
    // be mistaken for "no such route".
    expect(root.querySelector('#about')).toBeFalsy()
    expect(root.querySelector('#nf')).toBeFalsy()

    release()
    await tick()
    flushSync()
    expect(root.querySelector('#home')).toBeTruthy()
    expect(window.location.pathname).toBe('/')
  })

  it('renders the initial route once a guard that allows it settles', async () => {
    const guard: RouteGuard = async () => {
      await Promise.resolve()
      return undefined
    }
    window.history.replaceState(null, '', '/about')
    const root = mount(() => Router({ routes, guards: [guard] }))
    await tick()
    flushSync()
    expect(root.querySelector('#about')).toBeTruthy()
    expect(window.location.pathname).toBe('/about')
  })

  it('still shows the 404 fallback for an unmatched initial path with guards present', async () => {
    const NotFound: Component = () => <div id="nf">404</div>
    const guard: RouteGuard = () => undefined
    window.history.replaceState(null, '', '/nowhere')
    const root = mount(() => Router({ routes, guards: [guard], fallback: NotFound }))
    await tick()
    flushSync()
    expect(root.querySelector('#nf')).toBeTruthy()
  })
})

describe('useSearchParams', () => {
  it('reads and updates the query string', () => {
    window.history.replaceState(null, '', '/about?tab=code')
    let read: () => Record<string, string> = () => ({})
    let update: (n: Record<string, string | null>) => void = () => {}
    const Q: Component = () => {
      const [q, setQ] = useSearchParams()
      read = q
      update = setQ
      return <div id="q">{() => q().tab ?? ''}</div>
    }
    const root = mount(() => Router({ routes: [{ path: '/about', component: Q }] }))
    expect(read().tab).toBe('code')
    expect(root.querySelector('#q')?.textContent).toBe('code')

    update({ tab: 'preview', extra: '1' })
    flushSync()
    expect(read()).toEqual({ tab: 'preview', extra: '1' })
    expect(window.location.search).toBe('?tab=preview&extra=1')

    update({ extra: null })
    flushSync()
    expect(read()).toEqual({ tab: 'preview' })
  })
})

describe('lazy routes', () => {
  it('resolves a lazy component and renders it', async () => {
    const Lazy: Component = () => <div id="lazy">lazy</div>
    const lazyRoutes: RouteDef[] = [
      { path: '/', component: () => Promise.resolve({ default: Lazy }) },
    ]
    const root = mount(() => Router({ routes: lazyRoutes }))
    // Pending: nothing rendered yet.
    expect(root.querySelector('#lazy')).toBeFalsy()
    await tick()
    flushSync()
    // REGRESSION GUARD: the router wraps the outlet in <Suspense> and the lazy
    // import registers pending state on that boundary via createResource →
    // useSuspense. A broken Suspense↔createResource path (e.g. an unbalanced
    // pending counter, or Suspense detaching its children while pending) left the
    // boundary permanently pending / dropped the resolved content — the lazy
    // component then rendered nothing. Assert it actually mounts after resolve.
    expect(root.querySelector('#lazy')?.textContent).toBe('lazy')
  })

  it('shows a lazy route even after navigating to it (not just the initial one)', async () => {
    const Eager: Component = () => <div id="eager">eager</div>
    const Lazy: Component = () => <div id="lazy2">lazy2</div>
    const lazyRoutes: RouteDef[] = [
      { path: '/', component: Eager },
      { path: '/deferred', component: () => Promise.resolve({ default: Lazy }) },
    ]
    const root = mount(() => Router({ routes: lazyRoutes }))
    expect(root.querySelector('#eager')?.textContent).toBe('eager')

    navigate('/deferred')
    flushSync()
    await tick()
    flushSync()
    expect(root.querySelector('#lazy2')?.textContent).toBe('lazy2')
    expect(root.querySelector('#eager')).toBeFalsy()
  })
})

describe('Suspense + createResource', () => {
  // A real <Suspense fallback> around an async createResource: the fallback shows
  // while the fetch is outstanding, then the resolved content replaces it. This is
  // the user-facing capability the useSuspense wiring unlocks.
  it('shows the fallback while pending, then the resolved content', async () => {
    let resolveFetch!: (v: string) => void
    const AsyncView: Component = () => {
      const data = createResource(
        () => true,
        () => new Promise<string>((r) => (resolveFetch = r)),
      )
      return <div id="content">{() => (data() ? `got:${data()}` : null)}</div>
    }

    const root = mount(() =>
      Suspense({
        fallback: <div id="fallback">loading…</div>,
        children: (() => <AsyncView />) as any,
      }),
    )
    // Pending → fallback visible, the (still-empty) content hidden off-document.
    flushSync()
    expect(root.querySelector('#fallback')?.textContent).toBe('loading…')
    expect(root.querySelector('#content')).toBeFalsy()

    // Settle → fallback gone, resolved content shown.
    resolveFetch('data')
    await tick()
    flushSync()
    expect(root.querySelector('#fallback')).toBeFalsy()
    expect(root.querySelector('#content')?.textContent).toBe('got:data')
  })

  it('shows the fallback then content when the resource REJECTS (pending still settles)', async () => {
    let rejectFetch!: (e: unknown) => void
    const AsyncView: Component = () => {
      const data = createResource(
        () => true,
        () => new Promise<string>((_res, rej) => (rejectFetch = rej)),
      )
      return (
        <div id="content2">{() => (data.error() ? 'errored' : data() ? String(data()) : null)}</div>
      )
    }

    const root = mount(() =>
      Suspense({
        fallback: <div id="fallback2">loading…</div>,
        children: (() => <AsyncView />) as any,
      }),
    )
    flushSync()
    expect(root.querySelector('#fallback2')).toBeTruthy()

    // A rejection must also clear the pending count so the boundary un-suspends.
    rejectFetch(new Error('boom'))
    await tick()
    flushSync()
    expect(root.querySelector('#fallback2')).toBeFalsy()
    expect(root.querySelector('#content2')?.textContent).toBe('errored')
  })
})
