// isSignedOutError — port of stores/auth.ts `statusOf` + the 401/403 branch.
//
// The client throws an `HttpError` that carries the HTTP status as both
// `statusCode` and (older ofetch shape) `response.status`. A 401/403 means
// "not signed in / not authorized" as far as the backend is concerned — a
// normal signed-out state, NOT a genuine failure. A missing status means a
// transport-level error (no response reached us) which IS a real error.

/** The HTTP status carried by an error, checking both known shapes. */
function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: number; response?: { status?: number } } | null
  return e?.statusCode ?? e?.response?.status
}

/** True for a 401/403 — a signed-out state, NOT a real error. */
export function isSignedOutError(e: unknown): boolean {
  const status = statusOf(e)
  return status === 401 || status === 403
}
