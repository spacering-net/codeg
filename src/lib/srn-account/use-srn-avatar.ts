"use client"

import { useEffect, useState } from "react"

import type { SrnAsset } from "@/lib/harness/types"
import {
  createPetSpriteObjectUrl,
  revokePetSpriteObjectUrl,
} from "@/lib/pet/sprite-url"
import { isSrnAvatarPath } from "./shape"

/**
 * Raster types only, for the reason `lib/harness/use-srn-asset.ts` gives: a
 * blob URL lives in the app's origin, and an SVG opened from one is a
 * document that can run script there.
 */
const IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
])

// The bytes per path, shared by the status bar's glyph and the popover's
// larger copy; each mints and revokes a blob URL of its own. Avatar paths
// change with the picture, so a path's bytes never go stale. One account, a
// handful of pictures over a session: no eviction needed beyond failures.
const cache = new Map<string, Promise<SrnAsset>>()

function load(
  path: string,
  fetch: (path: string) => Promise<SrnAsset>
): Promise<SrnAsset> {
  const cached = cache.get(path)
  if (cached) return cached
  const promise = fetch(path).then((asset) => {
    const mime = asset.mime.split(";")[0].trim().toLowerCase()
    if (!IMAGE_TYPES.has(mime)) throw new Error(`Not an avatar: ${mime}`)
    return { mime, dataBase64: asset.dataBase64 }
  })
  cache.set(path, promise)
  // A failure is not kept: the next mount tries again.
  promise.catch(() => {
    if (cache.get(path) === promise) cache.delete(path)
  })
  return promise
}

/**
 * The account's picture as something an `<img>` can show, or `null` — while
 * it loads, when there is none, and when it fails (the caller shows the
 * name's initial for all three). Never loaded from SpaceRing by the page:
 * `fetch` is the account source's, which asks the backend.
 */
export function useSrnAvatar(
  path: string | null | undefined,
  fetch: ((path: string) => Promise<SrnAsset>) | null
): string | null {
  const [shown, setShown] = useState<{ path: string; src: string }>()
  const usable = fetch && isSrnAvatarPath(path) ? path : null

  useEffect(() => {
    if (!usable || !fetch) return
    let cancelled = false
    let objectUrl: string | null = null
    load(usable, fetch)
      .then((asset) => {
        if (cancelled) return
        objectUrl = createPetSpriteObjectUrl(asset)
        setShown({ path: usable, src: objectUrl })
      })
      .catch(() => {
        // The initial stands in; nothing to report.
      })
    return () => {
      cancelled = true
      if (objectUrl) revokePetSpriteObjectUrl(objectUrl)
    }
  }, [usable, fetch])

  // Keyed by path: a new picture shows the initial until it arrives, not
  // the old one.
  return usable && shown?.path === usable ? shown.src : null
}

/** Test-only: forget the cached bytes. */
export function __resetSrnAvatarCacheForTests(): void {
  cache.clear()
}
