import { useEffect, useState } from "react"

import { fetchWorkspaceBgMarketAsset } from "@/lib/workspace-background-market"
import {
  createBackgroundObjectUrl,
  revokeBackgroundObjectUrl,
  type BackgroundAsset,
} from "@/lib/workspace-background"

// Cache fetched *asset data* per URL (thumbs are immutable content-addressed
// paths) — NOT the blob URL. Paging back / reopening the dialog resolves
// without another wallhaven fetch. Each consumer mints its own blob URL and
// revokes it on unmount, so a shared entry can never be revoked out from
// under a still-mounted consumer.
//
// Bounded, because the entries are whole base64 images and nothing here is
// scoped to the dialog's lifetime: an unbounded map would keep every thumbnail
// ever scrolled past for as long as the page lives. Insertion order makes `Map`
// an LRU for free — re-inserting on a hit moves an entry to the young end.
const assetCache = new Map<string, Promise<BackgroundAsset>>()
/** Ten pages of listings (24 per page) — deep enough that ordinary back-paging
 *  never re-fetches, shallow enough to stay a few MB. */
const DEFAULT_ASSET_CACHE_LIMIT = 240
let assetCacheLimit = DEFAULT_ASSET_CACHE_LIMIT

function rememberAsset(url: string, asset: Promise<BackgroundAsset>): void {
  assetCache.delete(url)
  assetCache.set(url, asset)
  while (assetCache.size > assetCacheLimit) {
    const oldest = assetCache.keys().next()
    if (oldest.done) break
    assetCache.delete(oldest.value)
  }
}

function loadAsset(url: string): Promise<BackgroundAsset> {
  const existing = assetCache.get(url)
  if (existing) {
    rememberAsset(url, existing)
    return existing
  }

  const promise = fetchWorkspaceBgMarketAsset(url)
  rememberAsset(url, promise)
  // Don't cache a rejection — a transient network blip stays retryable. The
  // eviction is identity-guarded so a superseded request's late failure
  // can't evict a newer entry.
  promise.catch(() => {
    if (assetCache.get(url) === promise) assetCache.delete(url)
  })
  return promise
}

export interface ProxiedThumb {
  /** Blob URL for the proxied thumbnail, or `null` while loading / on failure. */
  src: string | null
  loading: boolean
  failed: boolean
}

interface Outcome {
  src: string | null
  failed: boolean
}

/**
 * Resolve a wallhaven thumbnail URL to a locally-served blob URL by proxying
 * the bytes through the backend (`background_market_asset`) — the webview
 * can't reach th.wallhaven.cc directly on some networks, so market cards
 * render wherever the listing loads. Keyed by URL; state is only written
 * from async callbacks, never synchronously in the effect body.
 */
export function useProxiedBackgroundThumb(url: string): ProxiedThumb {
  const [state, setState] = useState<{ url: string | null; outcome: Outcome }>(
    () => ({ url: null, outcome: { src: null, failed: false } })
  )

  useEffect(() => {
    if (!url) return

    let cancelled = false
    let objectUrl: string | null = null
    loadAsset(url)
      .then((asset) => {
        if (cancelled) return
        objectUrl = createBackgroundObjectUrl(asset)
        setState({ url, outcome: { src: objectUrl, failed: false } })
      })
      .catch(() => {
        if (cancelled) return
        setState({ url, outcome: { src: null, failed: true } })
      })

    return () => {
      cancelled = true
      if (objectUrl) revokeBackgroundObjectUrl(objectUrl)
    }
  }, [url])

  if (state.url === url) {
    return {
      src: state.outcome.src,
      loading: false,
      failed: state.outcome.failed,
    }
  }
  // `url` changed and the effect hasn't resolved the new one yet.
  return { src: null, loading: true, failed: false }
}

/**
 * Test-only: drop cached asset data so module state doesn't leak across tests.
 * `limit` shrinks the cache so eviction can be exercised without mounting 240
 * hooks; omit it to restore the production ceiling.
 */
export function __resetBackgroundThumbCacheForTests(
  limit: number = DEFAULT_ASSET_CACHE_LIMIT
): void {
  assetCache.clear()
  assetCacheLimit = limit
}
