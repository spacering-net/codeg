"use client"

/**
 * Read the global "live feedback enabled" flag (the `feedback.enabled` setting)
 * for gating the conversation feedback bar. Cached at module scope so opening
 * several conversation tabs doesn't refetch per tab.
 *
 * Cross-window reactive: the settings UI runs in a SEPARATE window
 * (`openSettingsWindow`), so a frontend-only cache would never see its save.
 * The backend broadcasts `feedback-settings://changed` on every save; this hook
 * subscribes to it (once per window) and updates every mounted instance live —
 * the same backend-emit + frontend-subscribe pattern as `conversation://changed`.
 * `primeFeedbackEnabled` additionally gives the saving window an instant,
 * optimistic update before the broadcast round-trips.
 *
 * A `saveGeneration` guard makes an explicit update (save or broadcast)
 * authoritative over an in-flight initial load: if one lands while
 * `getFeedbackSettings()` is still resolving, the stale fetched value is
 * discarded instead of clobbering the newer value.
 */

import { useEffect, useState } from "react"

import { getFeedbackSettings } from "@/lib/api"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import { FEEDBACK_SETTINGS_CHANGED_EVENT } from "@/lib/types"
import type { FeedbackSettings } from "@/lib/api"

let cached: boolean | null = null
let inflight: Promise<boolean> | null = null
/** Bumped by every save and broadcast: a read that started before one of
 *  them is older than the value it would overwrite. */
let saveGeneration = 0
/** Reads of the stored value — the initial load, reconnect re-fetches —
 *  numbered as they start, so a read that lands after a later one has
 *  committed is dropped too. */
let readsStarted = 0
let newestReadCommitted = 0
let crossWindowWired = false
const listeners = new Set<(enabled: boolean) => void>()

function notify(enabled: boolean): void {
  for (const listener of listeners) listener(enabled)
}

/** Authoritative update: bump the generation so a slower in-flight initial load
 *  can't overwrite it, set the cache, and notify all mounted hooks. Shared by
 *  the local optimistic prime and the cross-window broadcast handler. */
function applyEnabled(enabled: boolean): void {
  saveGeneration += 1
  cached = enabled
  notify(enabled)
}

/** Seed/overwrite the cache and notify all mounted hooks (called by the
 *  settings page after a successful save). Authoritative and instant for the
 *  saving window; other windows converge via the backend broadcast below. */
export function primeFeedbackEnabled(enabled: boolean): void {
  // A primed cache is never loaded again, so it must follow broadcasts from
  // here on even if no hook in this window has mounted yet.
  ensureCrossWindowSync()
  applyEnabled(enabled)
}

/** Start a read of the stored value. The returned commit applies what it
 *  read only if no save or broadcast happened since (those are
 *  authoritative — don't clobber them), and no read that started later has
 *  committed already. Reads never bump `saveGeneration`: one read must not
 *  void another that is newer than it. */
function beginRead(): (value: boolean) => void {
  const read = ++readsStarted
  const startGeneration = saveGeneration
  return (value) => {
    if (saveGeneration !== startGeneration || read < newestReadCommitted) {
      return
    }
    newestReadCommitted = read
    cached = value
    notify(value)
  }
}

/** Kick off (or reuse) the one-shot initial load. */
function ensureLoaded(): Promise<boolean> {
  if (inflight) return inflight
  const commit = beginRead()
  inflight = getFeedbackSettings()
    .then((s) => s.enabled)
    .catch(() => false)
    .then((value) => {
      commit(value)
      return cached ?? value
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** Wire the cross-window convergence once per window: subscribe to the backend
 *  `feedback-settings://changed` broadcast (so a save in the settings window
 *  reaches this window's open conversations), and re-fetch on WS reconnect since
 *  the broadcaster drops events fired while no client is listening. */
function ensureCrossWindowSync(): void {
  if (crossWindowWired) return
  crossWindowWired = true
  void subscribe<FeedbackSettings>(FEEDBACK_SETTINGS_CHANGED_EVENT, (s) => {
    applyEnabled(s.enabled)
  }).catch(() => {
    // Wiring failed (e.g. transport not ready yet) — clear the guard so a later
    // mount retries instead of silently never subscribing.
    crossWindowWired = false
  })
  // Returns null on desktop IPC (no disconnect window) → harmless no-op there.
  onTransportReconnect(() => {
    const commit = beginRead()
    void getFeedbackSettings()
      .then((s) => commit(s.enabled))
      .catch(() => {})
  })
}

export function useFeedbackEnabled(): boolean {
  // Lazy init reads the cache at mount (covers a value cached by an earlier
  // mount/save/broadcast). Subsequent changes — the initial load's commit, every
  // save, and every cross-window broadcast — arrive through `notify` (via the
  // listener registered below), so the effect never calls setState itself.
  const [enabled, setEnabled] = useState<boolean>(() => cached ?? false)

  useEffect(() => {
    ensureCrossWindowSync()
    listeners.add(setEnabled)
    if (cached === null) void ensureLoaded()
    return () => {
      listeners.delete(setEnabled)
    }
  }, [])

  return enabled
}
