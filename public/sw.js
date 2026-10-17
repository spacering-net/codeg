/*
 * codeg's service worker for the web build.
 *
 * Why this exists: when a PWA window sits minimized, browser memory
 * policies (Edge sleeping tabs, Chrome's Memory Saver) can discard the tab,
 * and coming back is a full page reload. Nothing a page can do stops that
 * discard. This script makes the reload cheap instead: build assets with
 * hashed names are served from Cache Storage, and a navigation that can't
 * reach the server falls back to a cached copy of the app shell — which
 * boots the app and lets the existing connection guard show its
 * disconnected state rather than a blank tab.
 *
 * Policy, deliberately narrow:
 *   - /api/**, /ws* and any cross-origin request pass through untouched.
 *     (WebSockets never enter a fetch handler anyway; this is belt and
 *     braces for anything that looks like one.)
 *   - Same-origin GETs under the cacheable prefixes below are cache-first.
 *   - Navigations are network-first. A successful HTML response is stored
 *     in the shell cache under its path — the query is stripped, because a
 *     reload comes back under whatever query the route launched with and a
 *     cache match is exact. Only a server that can't answer — the fetch
 *     fails outright, or a proxy in front of a restarting server says 5xx —
 *     makes the worker answer instead, with that route's cached document or
 *     else the root app shell. Every other response (a redirect to an auth
 *     proxy's login page, a 4xx) is the server's real answer and passes
 *     through untouched.
 *   - Cache Storage is only ever an optimization: a failed cache read falls
 *     through to the network, and a failed write (a full quota) is dropped
 *     without failing the response it was copying.
 *
 * Versions: the page registers this script as /sw.js?v=<app version>, so
 * each release installs a new worker whose caches are named after it and
 * start empty, and activate() drops the older codeg caches, keeping only
 * the previous release's assets for pages still running it. That is what
 * bounds Cache Storage — it never expires entries on its own, so hashed
 * build output would otherwise pile up release after release — and what
 * keeps the files without a content hash (Monaco's loader and editor entry
 * points under /vs, the icons, the manifest) from being served stale after
 * an update. Builds that keep the version keep their caches. Bump POLICY
 * when older caches must not be reused at all: the next activation then
 * keeps none of them.
 *
 * Retiring this worker takes a replacement, not a deletion: the static
 * handler answers a missing /sw.js with index.html as text/html, the
 * browser's update check rejects that, and the installed worker keeps
 * running. Ship a sw.js that deletes the codeg caches and unregisters itself.
 */

const POLICY = "v1"
const BUILD = new URL(self.location.href).searchParams.get("v") || "unversioned"
const VERSION = `${POLICY}-${BUILD}`
const ASSETS_PREFIX = `codeg-assets-${POLICY}-`
const ASSETS_CACHE = `${ASSETS_PREFIX}${BUILD}`
const SHELL_CACHE = `codeg-shell-${VERSION}`
const SHELL_PATH = "/index.html"

// Stored at install, before this worker can answer anything. The root shell
// is what a route without a document of its own falls back to, and the root
// page redirects to /workspace or /login (src/app/page.tsx). Those two must
// be cached whenever the shell is: offline, the redirect's client-side
// fetch fails and Next falls back to a full navigation, which would land
// back on the shell — a reload loop for as long as the server is away.
const BOOT_DOCUMENTS = [SHELL_PATH, "/workspace", "/login"]

// Same-origin GETs under these prefixes may be cached: Next's hashed
// export output, the bundled Monaco under public/vs, and the app's own
// icons and manifest. Everything else — page HTML routes, /api, /ws — is
// served live. src/lib/service-worker.ts mirrors this list.
const CACHEABLE_PREFIXES = ["/_next/static/", "/vs/", "/icon", "/manifest.json"]

// Next names everything under here after its content, so a URL can never
// change what it serves; Monaco's entry points, the icons and the manifest
// keep their names from one release to the next.
const IMMUTABLE_PREFIX = "/_next/static/"

// Build files a document names by URL: its script and stylesheet tags and
// the chunk list in its inline RSC payload, where quotes are escaped —
// hence the backslash among the characters that end a match.
const ASSET_REFERENCE = /\/_next\/static\/[^"'\\\s<>)]+/g

self.addEventListener("install", (event) => {
  // The page that registers this worker loaded everything before the worker
  // existed, so nothing of this release is cached yet. The install succeeds
  // only once the boot documents and every build file they name that the
  // server has are stored; otherwise the current worker, if any, stays and
  // the next page load registers again. Then swap in at once — waiting
  // would only delay that.
  event.waitUntil(seedRelease())
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const older = (await caches.keys()).filter(
        (name) =>
          name.startsWith("codeg-") &&
          name !== ASSETS_CACHE &&
          name !== SHELL_CACHE
      )
      // Keep one older asset cache: the newest of this policy, which is the
      // release this one replaces — keys() lists caches in creation order,
      // and only a successful install leaves its caches behind, created
      // afresh. Pages still running that release go on lazy-loading its
      // hashed chunks from it after the server has dropped them; the next
      // release deletes it.
      const previousAssets = older
        .filter((name) => name.startsWith(ASSETS_PREFIX))
        .pop()
      await Promise.all(
        older
          .filter((name) => name !== previousAssets)
          .map((name) => caches.delete(name))
      )
      await self.clients.claim()
    })()
  )
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return
  if (url.pathname === "/ws" || url.pathname.startsWith("/ws/")) return

  if (request.mode === "navigate") {
    event.respondWith(navigateNetworkFirst(event, url.pathname))
    return
  }
  if (CACHEABLE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
    event.respondWith(cacheFirst(event, url.pathname))
  }
})

async function seedRelease() {
  // New bytes under the active worker's own URL come from the browser's
  // update check after the server moved to another release: the static
  // handler ignores the ?v= query. Installing them would share the active
  // worker's caches, and wipe them if this install then failed. Refuse;
  // the next page from the server registers its own release's URL.
  if (self.registration.active?.scriptURL === self.location.href) {
    throw new Error("superseded: the page will register its own release")
  }
  // Start this release's caches empty: what an earlier activation of the
  // same version left (a rollback, a stale page registering it again) may
  // hold fixed-name files from whatever the server served back then.
  await dropReleaseCaches()
  const documents = await Promise.all(BOOT_DOCUMENTS.map(fetchBootDocument))
  // A document alone doesn't boot offline: the scripts it names must be
  // stored with it, or an update installed from another tab would replace
  // a working offline workspace with one whose new chunks never loaded.
  const referenced = new Set()
  for (const [, response] of documents) {
    const html = await response.clone().text()
    for (const match of html.matchAll(ASSET_REFERENCE)) referenced.add(match[0])
  }
  // A failed fetch or a 5xx fails the install, to be retried. Any other
  // answer that isn't the file (the static handler's index.html fallback,
  // a 404) means there is nothing to store, and must not block every
  // future install.
  const assets = await Promise.all(
    [...referenced].map(async (path) => {
      const response = await fetch(path)
      if (response.status >= 500) {
        throw new Error(`cannot seed ${path}: HTTP ${response.status}`)
      }
      return [path, response]
    })
  )
  try {
    const shell = await caches.open(SHELL_CACHE)
    const assetCache = await caches.open(ASSETS_CACHE)
    await Promise.all([
      ...documents.map(([path, response]) => shell.put(path, response)),
      ...assets
        .filter(([, response]) => isStorableAsset(response))
        .map(([path, response]) => assetCache.put(path, response)),
    ])
  } catch (error) {
    // Leave nothing behind: activate() takes the newest asset cache for the
    // previous release, so a half-stored failed install must not be one.
    await dropReleaseCaches().catch(() => {})
    throw error
  }
}

async function fetchBootDocument(path) {
  const response = await fetch(path, { cache: "reload" })
  // A redirect here is an auth proxy's login page, not the app.
  if (!response.ok || response.redirected || !isHtml(response)) {
    throw new Error(`cannot seed ${path}: HTTP ${response.status}`)
  }
  return [path, response]
}

function dropReleaseCaches() {
  return Promise.all([caches.delete(SHELL_CACHE), caches.delete(ASSETS_CACHE)])
}

async function navigateNetworkFirst(event, path) {
  let response
  try {
    response = await fetch(event.request)
  } catch (error) {
    const cached = await cachedDocument(path)
    if (cached) return cached
    throw error
  }
  if (response.status >= 500) {
    return (await cachedDocument(path)) || response
  }
  if (response.ok && isHtml(response)) {
    putInBackground(event, SHELL_CACHE, path, response.clone())
  }
  return response
}

async function cachedDocument(path) {
  return (
    (await cacheMatch(SHELL_CACHE, path)) ||
    (await cacheMatch(SHELL_CACHE, SHELL_PATH))
  )
}

async function cacheFirst(event, path) {
  const request = event.request
  const immutable = path.startsWith(IMMUTABLE_PREFIX)
  // A hashed URL serves the same bytes from any release's cache. A fixed
  // name only counts from this release's, and a miss revalidates with the
  // server: the HTTP cache may still hold the previous release's copy as
  // heuristically fresh (the static handler sends no Cache-Control), and
  // storing that would pin it here until the next release.
  let cached = await cacheMatch(ASSETS_CACHE, request)
  if (!cached && immutable) {
    cached = await previousReleaseMatch(request)
    // Copy it over, so this release's cache holds what its pages use and
    // the next release's cleanup can't take it away.
    if (cached) putInBackground(event, ASSETS_CACHE, request, cached.clone())
  }
  if (cached) return cached
  const response = await (immutable
    ? fetch(request)
    : fetch(request, { cache: "no-cache" }))
  // A 200 here is not always the asset: the static handler falls back to
  // index.html for hashed URLs it no longer has (an app update orphans old
  // chunk names), and an auth proxy can answer anything with its login
  // page. Caching that HTML under a script URL would keep breaking the app
  // across a rollback, so a response that is not what its URL claims never
  // enters the cache.
  if (isStorableAsset(response)) {
    putInBackground(event, ASSETS_CACHE, request, response.clone())
  }
  return response
}

function isStorableAsset(response) {
  return response.ok && response.type === "basic" && !isHtml(response)
}

async function cacheMatch(cacheName, key) {
  try {
    const cache = await caches.open(cacheName)
    return await cache.match(key)
  } catch {
    return undefined
  }
}

// Other releases' asset caches only: the shell cache keys documents by
// path, and a navigation to a hashed URL the server no longer has would
// have stored its index.html fallback there.
async function previousReleaseMatch(key) {
  try {
    for (const name of await caches.keys()) {
      if (!name.startsWith(ASSETS_PREFIX) || name === ASSETS_CACHE) continue
      const hit = await (await caches.open(name)).match(key)
      if (hit) return hit
    }
  } catch {
    // Unreadable storage is a miss.
  }
  return undefined
}

// Copies a response into a cache without holding it back: the caller
// returns the original at once (so it streams), and the event stays alive
// until the copy is stored or dropped.
function putInBackground(event, cacheName, key, response) {
  event.waitUntil(
    caches
      .open(cacheName)
      .then((cache) => cache.put(key, response))
      .catch(() => {})
  )
}

function isHtml(response) {
  return (response.headers.get("content-type") || "").includes("text/html")
}
