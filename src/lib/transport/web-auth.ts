// Shared helpers for web-mode HTTP calls — the JSON transport in
// `web-transport.ts` and direct multipart/file callers in `lib/api.ts` both
// need consistent token retrieval and 401 redirect behavior. Keeping them in
// one place means a future move from `localStorage` to cookies (or rotation
// rules, multi-tenant prefixing, etc.) doesn't have to be remembered at every
// call site.

const TOKEN_KEY = "codeg_token"
// Set when the server admitted this browser without a token: a proxy in front
// of it vouched for the user (`CODEG_AUTH=proxy-jwt` on codeg-server).
const PROXY_AUTH_KEY = "codeg_proxy_auth"
// As long as the transport's own health probe waits (`web-transport.ts`).
const PROBE_TIMEOUT_MS = 8_000

// Codeg marks its own 401 with this bearer challenge (`web/auth.rs`). A 401
// without it came from something in front of Codeg — typically an
// identity-aware proxy whose session expired — and re-entering the Codeg token
// cannot fix that; a top-level reload lets the proxy run its login flow.
const CODEG_CHALLENGE = /^bearer\s+realm="codeg"(?:\s*,|$)/i

export type UnauthorizedSource = "codeg" | "proxy"

export function codegAuthHeaders(token: string): Record<string, string> {
  return {
    // Signed in through a proxy there is no token, and an empty bearer is
    // noise at best.
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    // Asks a proxy in front of Codeg (e.g. Cloudflare Access) to answer an
    // expired session with 401 instead of a redirect to its login page on
    // another origin, which fetch cannot follow and reports as a network
    // error — leaving the UI reconnecting forever.
    "X-Requested-With": "XMLHttpRequest",
  }
}

/**
 * Who answered a 401, from its `WWW-Authenticate` header (null if absent).
 * Signed in through a proxy without a token, every 401 is the proxy's to
 * resolve: there is no token to re-enter, only the proxy's login.
 */
export function unauthorizedSource(
  challenge: string | null
): UnauthorizedSource {
  if (isProxyAuthenticated() && !getCodegToken()) return "proxy"
  return CODEG_CHALLENGE.test((challenge ?? "").trim()) ? "codeg" : "proxy"
}

export function isProxyAuthenticated(): boolean {
  return localStorage.getItem(PROXY_AUTH_KEY) === "1"
}

/** A token, or a proxy that admitted this browser without one. */
export function hasCodegCredentials(): boolean {
  return Boolean(getCodegToken()) || isProxyAuthenticated()
}

/**
 * Asks the server whether it admits this browser without a token, which it
 * does only when a proxy in front of it vouched for the user. Remembers the
 * answer for the transport; an unreachable server leaves it as it was.
 */
export async function probeProxyAuthentication(): Promise<
  "proxy" | "unauthorized" | "unreachable"
> {
  // A server that takes the request and never answers counts as unreachable,
  // rather than holding the page, or a subscription waiting on this, forever.
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch("/api/health", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...codegAuthHeaders("") },
      body: "{}",
      signal: controller.signal,
    })
  } catch {
    return "unreachable"
  } finally {
    clearTimeout(timeout)
  }
  if (res.ok) {
    localStorage.setItem(PROXY_AUTH_KEY, "1")
    return "proxy"
  }
  if (res.status === 401) {
    localStorage.removeItem(PROXY_AUTH_KEY)
    return "unauthorized"
  }
  return "unreachable"
}

export function getCodegToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ""
}

export function redirectToCodegLogin(): void {
  if (window.location.pathname.startsWith("/login")) return
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(PROXY_AUTH_KEY)
  window.location.href = "/login"
}
