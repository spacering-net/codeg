/**
 * Service Worker registration for the web build.
 *
 * The SW exists to make a discarded PWA tab cheap to reload and to answer
 * navigations offline with the app shell — see `public/sw.js` for the
 * caching policy. It cannot prevent the discard itself (that is the
 * browser's memory policy), and registration here is deliberately narrow:
 *
 *   - never on desktop (the Tauri webview must not have its resource loads
 *     intercepted by a service worker),
 *   - never outside a secure context (http://LAN deployments: the browser
 *     would reject the registration anyway, and Notification needs the same
 *     context),
 *   - never in development, where the served asset layout doesn't match the
 *     static export the policy is written for.
 *
 * Everything is fire-and-forget: a failed registration has no visible
 * consequence and the next page load retries.
 */

import { isDesktop } from "./transport"

export const SERVICE_WORKER_PATH = "/sw.js"
export const SERVICE_WORKER_SCOPE = "/"

/** Mirrors CACHEABLE_PREFIXES in `public/sw.js`: what the worker stores. */
export const CACHEABLE_PREFIXES = [
  "/_next/static/",
  "/vs/",
  "/icon",
  "/manifest.json",
]

/**
 * The script URL to register. It carries the app version (inlined at build
 * by next.config.ts) because the worker names its caches after it: a new
 * release changes the URL, which installs a new worker, which retires the
 * old release's caches. Without it the caches would never turn over.
 */
export function serviceWorkerUrl(
  version: string | undefined = process.env.CODEG_APP_VERSION
): string {
  return version
    ? `${SERVICE_WORKER_PATH}?v=${encodeURIComponent(version)}`
    : SERVICE_WORKER_PATH
}

/** Whether this environment should have the app service worker (no side effects). */
export function serviceWorkerEligible(): boolean {
  if (typeof window === "undefined") return false
  if (!("serviceWorker" in navigator)) return false
  if (!window.isSecureContext) return false
  if (isDesktop()) return false
  if (process.env.NODE_ENV !== "production") return false
  return true
}

/**
 * Register the service worker; resolves whether a registration was issued.
 * A rejection from the browser API is swallowed — registration is an
 * optimization, not a feature gate.
 */
export async function registerAppServiceWorker(): Promise<boolean> {
  if (!serviceWorkerEligible()) return false
  try {
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      recacheLoadedAssets
    )
    await navigator.serviceWorker.register(serviceWorkerUrl(), {
      scope: SERVICE_WORKER_SCOPE,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Same-origin files this page has loaded that the worker would cache, each
 * once, in load order.
 */
export function loadedCacheableAssets(): string[] {
  const urls = new Set<string>()
  for (const entry of performance.getEntriesByType("resource")) {
    let url: URL
    try {
      url = new URL(entry.name)
    } catch {
      continue
    }
    if (url.origin !== window.location.origin) continue
    if (!CACHEABLE_PREFIXES.some((p) => url.pathname.startsWith(p))) continue
    urls.add(url.href)
  }
  return [...urls]
}

/**
 * Runs whenever a worker takes control of this page. What the page loaded
 * before then is not in that worker's cache: on a first visit there was no
 * worker at all, and after an update it went into the previous release's
 * cache, which the next release deletes. An offline reload later in this
 * session would then find the shell document but not the scripts it boots
 * with. Asking for the same files again, through the new worker this time,
 * lets it store them — answered from the HTTP cache or the previous
 * release's cache, rarely from the network.
 */
function recacheLoadedAssets(): void {
  for (const url of loadedCacheableAssets()) {
    void fetch(url).catch(() => {})
  }
}
