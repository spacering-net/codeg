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

// Share the current picture between the status bar and the account popover.
// Keep active requests until they settle so changing the picture does not
// duplicate a fetch. Older settled pictures need no cache entry.
let cached: { path: string; request: Promise<SrnAsset> } | undefined
const pending = new Map<string, Promise<SrnAsset>>()

function load(
  path: string,
  fetch: (path: string) => Promise<SrnAsset>
): Promise<SrnAsset> {
  if (cached?.path === path) return cached.request
  const active = pending.get(path)
  if (active) {
    cached = { path, request: active }
    return active
  }

  const request: Promise<SrnAsset> = fetch(path)
    .then((asset) => {
      const mime = asset.mime.split(";")[0].trim().toLowerCase()
      if (!IMAGE_TYPES.has(mime)) throw new Error(`Not an avatar: ${mime}`)
      return { mime, dataBase64: asset.dataBase64 }
    })
    .finally(() => {
      if (pending.get(path) === request) pending.delete(path)
    })
  pending.set(path, request)
  cached = { path, request }
  request.catch(() => {
    if (cached?.request === request) cached = undefined
  })
  return request
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
  cached = undefined
  pending.clear()
}
