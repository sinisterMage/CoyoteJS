import { describe, expect, it } from 'vitest'
// Router matcher internals from the local module.
import {
  compileRoute,
  compileRoutes,
  flattenRoutes,
  matchRoutes,
  normalizePath,
  parseQuery,
  stringifyQuery,
} from './match'
import type { RouteDef } from './types'

const noop = () => null

describe('normalizePath', () => {
  it('converts [id] file tokens to :id params', () => {
    expect(normalizePath('/builder/[id]')).toBe('/builder/:id')
    expect(normalizePath('/[org]/[repo]')).toBe('/:org/:repo')
  })
  it('ensures a leading slash and strips a trailing one', () => {
    expect(normalizePath('about')).toBe('/about')
    expect(normalizePath('/about/')).toBe('/about')
  })
  it('collapses duplicate slashes and keeps the root', () => {
    expect(normalizePath('//a//b')).toBe('/a/b')
    expect(normalizePath('/')).toBe('/')
  })
})

describe('flattenRoutes', () => {
  it('flattens a glob record of { default: RouteModule }', () => {
    const glob: Record<string, { default: RouteDef | RouteDef[] }> = {
      '/src/routes/home.route.ts': { default: { path: '/', component: noop } },
      '/src/routes/pair.route.ts': {
        default: [
          { path: '/a', component: noop },
          { path: '/b', component: noop },
        ],
      },
    }
    const defs = flattenRoutes(glob)
    expect(defs.map((d) => d.path).sort()).toEqual(['/', '/a', '/b'])
  })
  it('passes through a RouteDef[]', () => {
    const defs = flattenRoutes([
      { path: '/x', component: noop },
      { path: '/y', component: noop },
    ])
    expect(defs.map((d) => d.path)).toEqual(['/x', '/y'])
  })
  it('skips non-conforming entries', () => {
    const glob = {
      '/bad': { default: { nope: true } as unknown as RouteDef },
      '/good': { default: { path: '/ok', component: noop } },
    }
    expect(flattenRoutes(glob).map((d) => d.path)).toEqual(['/ok'])
  })
})

describe('compileRoute + matchRoutes', () => {
  it('matches a static path', () => {
    const compiled = [compileRoute({ path: '/about', component: noop })]
    expect(matchRoutes(compiled, '/about')).toBeTruthy()
    expect(matchRoutes(compiled, '/other')).toBeNull()
  })

  it('matches a :param and populates params', () => {
    const compiled = [compileRoute({ path: '/builder/[id]', component: noop })]
    const m = matchRoutes(compiled, '/builder/42')
    expect(m).toBeTruthy()
    expect(m!.params).toEqual({ id: '42' })
  })

  it('matches multiple params', () => {
    const compiled = [compileRoute({ path: '/:org/:repo', component: noop })]
    const m = matchRoutes(compiled, '/acme/widgets')
    expect(m!.params).toEqual({ org: 'acme', repo: 'widgets' })
  })

  it('decodes percent-encoded params', () => {
    const compiled = [compileRoute({ path: '/u/:name', component: noop })]
    const m = matchRoutes(compiled, '/u/a%20b')
    expect(m!.params).toEqual({ name: 'a b' })
  })

  it('prefers the more specific static route over a param route', () => {
    const compiled = compileRoutes([
      { path: '/builder/:id', component: noop },
      { path: '/builder/new', component: noop },
    ])
    const m = matchRoutes(compiled, '/builder/new')
    expect(m!.route.path).toBe('/builder/new')
  })

  it('exposes route meta on the match', () => {
    const compiled = [compileRoute({ path: '/admin', component: noop, meta: { requiresAuth: true } })]
    const m = matchRoutes(compiled, '/admin')
    expect(m!.meta).toEqual({ requiresAuth: true })
  })

  it('matches the root path', () => {
    const compiled = [compileRoute({ path: '/', component: noop })]
    expect(matchRoutes(compiled, '/')).toBeTruthy()
    expect(matchRoutes(compiled, '/x')).toBeNull()
  })
})

describe('query parse/stringify', () => {
  it('parses a search string into a record', () => {
    expect(parseQuery('?a=1&b=two')).toEqual({ a: '1', b: 'two' })
    expect(parseQuery('')).toEqual({})
  })
  it('round-trips a query record', () => {
    expect(stringifyQuery({ a: '1', b: 'two' })).toBe('?a=1&b=two')
    expect(stringifyQuery({})).toBe('')
  })
})
