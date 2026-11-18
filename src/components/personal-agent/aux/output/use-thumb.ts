"use client"

/** A picture's thumbnail on the output tab: read from the assistant's working
 *  directory once it comes into view, a few at a time, and kept — within a
 *  budget of bytes — so a switch of tabs or assistants does not read it
 *  again. A picture too large is not read: its kind's icon stands for it. */

import { useEffect, useState, type RefObject } from "react"

import { readWorkspaceFileBase64 } from "@/lib/api"
import { imageDataUrl } from "@/lib/image-diff"
import type { PersonalAgentOutputDoc } from "@/lib/types"

/** The largest picture read for a thumbnail. */
export const THUMB_MAX_BYTES = 1024 * 1024
/** The thumbnails kept, in characters of their data URLs. */
const CACHE_BUDGET = 24 * 1024 * 1024
/** Reads at once. */
const AT_ONCE = 4

/** Kept thumbnails, oldest first; `null`: it could not be read. */
const cache = new Map<string, string | null>()
let cached = 0

function remember(key: string, url: string | null) {
  const old = cache.get(key)
  if (old) cached -= old.length
  cache.delete(key)
  cache.set(key, url)
  if (url) cached += url.length
  for (const [k, v] of cache) {
    if (cached <= CACHE_BUDGET || k === key) break
    cache.delete(k)
    if (v) cached -= v.length
  }
}

let running = 0
const waiting: (() => void)[] = []

function schedule(job: () => Promise<void>) {
  const run = () => {
    running += 1
    void job().finally(() => {
      running -= 1
      waiting.shift()?.()
    })
  }
  if (running < AT_ONCE) run()
  else waiting.push(run)
}

export function __resetThumbsForTests() {
  cache.clear()
  cached = 0
  running = 0
  waiting.length = 0
}

/** `doc`'s thumbnail, once read; `null` before, or when it cannot be. The
 *  element `ref` holds is watched to read it once it is near the view. */
export function useThumb(
  workdir: string | null,
  doc: PersonalAgentOutputDoc,
  ref: RefObject<HTMLElement | null>
): string | null {
  const key = workdir ? `${workdir}\0${doc.path}\0${doc.modified_at}` : null
  const [src, setSrc] = useState(() => (key ? (cache.get(key) ?? null) : null))
  const tooLarge = doc.size > THUMB_MAX_BYTES
  useEffect(() => {
    if (!key || !workdir || tooLarge) return
    // Kept: the newest again, last to go.
    if (cache.has(key)) {
      remember(key, cache.get(key) ?? null)
      return
    }
    let live = true
    let started = false
    const load = () => {
      if (started) return
      started = true
      schedule(() =>
        readWorkspaceFileBase64(workdir, doc.path, THUMB_MAX_BYTES)
          .then((b64) => {
            const url = imageDataUrl(doc.path, b64)
            remember(key, url)
            if (live) setSrc(url)
          })
          .catch(() => remember(key, null))
      )
    }
    const el = ref.current
    if (typeof IntersectionObserver === "undefined" || !el) {
      load()
      return () => {
        live = false
      }
    }
    const watch = new IntersectionObserver(
      (seen) => {
        if (seen.some((e) => e.isIntersecting)) {
          watch.disconnect()
          load()
        }
      },
      { rootMargin: "200px" }
    )
    watch.observe(el)
    return () => {
      live = false
      watch.disconnect()
    }
  }, [key, workdir, doc.path, tooLarge, ref])
  return src
}
