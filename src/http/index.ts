// @sinistermage/coyote-js/http — a small, dependency-free fetch-based JSON client.
//
//   const api = createHttp({ baseURL: '/api', getToken })
//   const me = await api<Me>('/me')                       // GET, bearer injected
//   const p  = await api<P>('/projects', { method: 'POST', body: { ... } })
//   if (isSignedOutError(err)) { /* not signed in — expected, not a failure */ }
//
// See ./client.ts (createHttp) and ./signed-out.ts. This module is generic: it
// has no app/config/auth coupling — the caller supplies `baseURL` and an
// optional `getToken`.

// Public value exports.
export { createHttp } from './client'
export type { CreateHttpOptions } from './client'
export { isSignedOutError } from './signed-out'

// Public type exports.
export type { HttpClient, HttpError, HttpRequestOptions } from './types'
