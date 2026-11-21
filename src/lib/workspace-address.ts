/**
 * A value a link brings to the workspace in its address — `?harness=` (an
 * "Open in Codeg" link, `lib/harness-link.ts`), `?srn=` (the end of a Codeg
 * Web sign-in, `lib/srn-account/web-result.ts`): read once and taken off the
 * address, and carried across the instance's login, whose redirect to
 * `/login` drops the query.
 */

/**
 * `search` without the parameter `name`, every other one left exactly as it
 * was written: removed pair by pair rather than re-serialized, which would
 * change how the rest are encoded.
 */
export function withoutQueryParam(search: string, name: string): string {
  const query = search.startsWith("?") ? search.slice(1) : search
  const kept = query
    .split("&")
    .filter((pair) => !new URLSearchParams(pair).has(name))
    .join("&")
  return kept === "" ? "" : `?${kept}`
}

/**
 * The parameter `name` of this page's address (its first value), taken off
 * the address so that nothing — a re-render, a remount, a reload, the back
 * button — can read it a second time; `null` when the address has none.
 * Whatever the value, the parameter goes: checking it is the caller's.
 *
 * The rest of the address, hash included, stays as it was. `replaceState` is
 * the way the Next.js router follows (`useSearchParams` sees the change), and
 * `null` its state as its own docs give it: the router keeps its own state in
 * there and puts it back itself.
 */
export function takeQueryParamFromAddress(name: string): string | null {
  if (typeof window === "undefined") return null
  const { pathname, search, hash } = window.location
  const params = new URLSearchParams(search)
  if (!params.has(name)) return null
  const value = params.get(name) ?? ""
  try {
    window.history.replaceState(
      null,
      "",
      `${pathname}${withoutQueryParam(search, name)}${hash}`
    )
  } catch {
    // A same-origin address does not fail here. If one ever did, the value is
    // still read now; only a later remount could read it a second time.
  }
  return value
}

// ─── Across the instance's login ──────────────────────────────────────

/**
 * How long a value kept for the login stays good. Long enough to find a token
 * and paste it; short enough that a login long after — the tab left on the
 * login page, the link long forgotten — does not bring back something unasked.
 */
export const AFTER_LOGIN_MAX_AGE_MS = 10 * 60 * 1000

/**
 * Called on the way to `/login`: keep `kept` (stamped with the time) under
 * `key` for after the login, or — with `null` — make sure no older one is left
 * to come back instead.
 *
 * In `sessionStorage`, so it belongs to this tab alone and ends with it.
 */
export function keepForLogin(
  key: string,
  kept: Record<string, unknown> | null
): void {
  try {
    if (kept === null) {
      sessionStorage.removeItem(key)
    } else {
      sessionStorage.setItem(key, JSON.stringify({ ...kept, at: Date.now() }))
    }
  } catch {
    // No storage: the value is lost to the login, as it always was.
  }
}

/**
 * What was kept under `key` for after the login, once: it is gone after this,
 * whatever it was. `null` for nothing, for something that is not a record,
 * and for one kept too long ago (or stamped in the future). The record's own
 * fields are the caller's to check.
 */
export function takeKeptForLogin(
  key: string,
  now: number = Date.now()
): Record<string, unknown> | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(key)
    sessionStorage.removeItem(key)
  } catch {
    return null
  }
  if (raw === null) return null
  try {
    const kept: unknown = JSON.parse(raw)
    if (!kept || typeof kept !== "object") return null
    const { at } = kept as { at?: unknown }
    if (typeof at !== "number" || !Number.isFinite(at)) return null
    const age = now - at
    if (age < 0 || age > AFTER_LOGIN_MAX_AGE_MS) return null
    return kept as Record<string, unknown>
  } catch {
    return null
  }
}

/** Drop a value kept for a login that never came. The workspace calls this
 *  as it loads: by then that login is over, one way or the other. */
export function forgetKeptForLogin(key: string): void {
  try {
    sessionStorage.removeItem(key)
  } catch {
    // Nothing kept, then.
  }
}
