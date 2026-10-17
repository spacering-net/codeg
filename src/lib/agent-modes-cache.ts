"use client"

/**
 * Remembers the LAST modes list each agent advertised, so a default-mode
 * preference can be matched to a real mode id at connect time.
 *
 * Why a cache at all: the default-mode injection happens in
 * `getSavedPrefsForConnect`, which runs BEFORE `session/new` — while the only
 * source of valid mode ids, the `session_modes` event, arrives AFTER. Guessing
 * an id ("yolo" for every agent) is not an option: the backend silently falls
 * back to the agent's own default when the preferred id is not in the offered
 * list, so a wrong guess is indistinguishable from a no-op. Caching what the
 * agent actually offered last time makes the fallback match real.
 *
 * Written from the `session_modes` event branch only — it must never trigger
 * `saveModePreference` (that is the user's manual pick, a different thing).
 * Entries are replaced wholesale: a modes list that changed shape means the
 * old ids are stale anyway. A `Map`, not a plain object — agent types are
 * strings codeg does not choose (see model-label-store for the prototype
 * pollution write-up).
 */

import type { SessionModeStateInfo } from "@/lib/types"

const STORAGE_KEY = "codeg:agent-modes-cache"

/** agentType → mode ids the agent offered the last time it ran. */
const cache = new Map<string, string[]>()
let loaded = false

function ensureLoaded() {
  if (loaded || typeof window === "undefined") return
  loaded = true
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
    for (const [agentType, ids] of Object.entries(
      parsed as Record<string, unknown>
    )) {
      if (!Array.isArray(ids)) continue
      const kept = ids.filter((id): id is string => typeof id === "string")
      if (kept.length > 0) cache.set(agentType, kept)
    }
  } catch {
    /* ignore */
  }
}

function persist() {
  if (typeof window === "undefined") return
  try {
    const out: Record<string, string[]> = {}
    for (const [agentType, ids] of cache) out[agentType] = ids
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(out))
  } catch {
    /* ignore */
  }
}

/** Record the modes an agent just advertised. Replaces any previous list. */
export function rememberAgentModes(
  agentType: string,
  modes: SessionModeStateInfo
) {
  const ids = modes.available_modes
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string")
  if (ids.length === 0) return
  ensureLoaded()
  cache.set(agentType, ids)
  persist()
}

/** Mode ids the agent offered last time; empty when never seen. */
export function getCachedAgentModes(agentType: string): string[] {
  ensureLoaded()
  return cache.get(agentType) ?? []
}

/** Drop the whole cache (settings "reset" affordance). */
export function clearAgentModesCache() {
  ensureLoaded()
  cache.clear()
  persist()
}
