"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { describeAgentOptions } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { AgentOptionsSnapshot, AgentType } from "@/lib/types"

// Module-scope probe cache, isolated from the chat selectors (same approach as
// delegation-agent-defaults). 30s TTL absorbs rapid re-opens without a stale
// snapshot surviving a real config change. The inflight map dedups concurrent
// callers so the editor + its config section share a single probe.
const CACHE_TTL_MS = 30_000

interface CachedSnapshot {
  snapshot: AgentOptionsSnapshot
  ts: number
}

// Keyed by (agent, folderPath): the same agent probed in two target folders can
// surface different folder/project-scoped slash commands or options, so a folder
// switch must not return another folder's cached snapshot. JSON.stringify is a
// collision-free composite key (and avoids a literal NUL separator).
const snapshotCache = new Map<string, CachedSnapshot>()
const inflight = new Map<string, Promise<AgentOptionsSnapshot>>()

function cacheKey(agent: AgentType, folderPath: string | null): string {
  return JSON.stringify([agent, folderPath ?? null])
}

function readCache(
  agent: AgentType,
  folderPath: string | null
): AgentOptionsSnapshot | null {
  const key = cacheKey(agent, folderPath)
  const entry = snapshotCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    snapshotCache.delete(key)
    return null
  }
  return entry.snapshot
}

function fetchOptions(
  agent: AgentType,
  folderPath: string | null
): Promise<AgentOptionsSnapshot> {
  const key = cacheKey(agent, folderPath)
  let promise = inflight.get(key)
  if (!promise) {
    promise = describeAgentOptions(agent, folderPath)
      .then((snapshot) => {
        snapshotCache.set(key, { snapshot, ts: Date.now() })
        inflight.delete(key)
        return snapshot
      })
      .catch((err) => {
        inflight.delete(key)
        throw err
      })
    inflight.set(key, promise)
  }
  return promise
}

export interface AgentOptionsState {
  snapshot: AgentOptionsSnapshot | null
  /** Which agent `snapshot` was probed from — NOT necessarily the `agentType`
   *  argument. The two diverge for the whole debounce window after an agent
   *  switch (the previous snapshot stays on screen until the re-probe lands),
   *  so anything that interprets the snapshot's CONTENT — localising the
   *  agent's own vocabulary, say — has to key on this rather than on the
   *  currently-selected agent. Null whenever `snapshot` is. */
  snapshotAgentType: AgentType | null
  loading: boolean
  error: string | null
  reload: () => void
  /** Resolve the snapshot for a save-time read, keyed to the CURRENT agent +
   *  folder (never a snapshot retained across an agent/folder switch): the cached
   *  one if fresh, else the in-flight/fresh probe, bounded so a wedged probe never
   *  blocks saving (returns null on timeout/failure → caller falls back to raw
   *  overrides). */
  ensure: () => Promise<AgentOptionsSnapshot | null>
}

/**
 * Probe (`describeAgentOptions`) the agent's modes / config options / slash
 * commands via a transient session, with a shared module cache. One probe feeds
 * both the automation editor's config selectors and its `/` command menu — the
 * config snapshot now carries `available_commands` (captured in the same probe).
 */
export function useAgentOptions(
  agentType: AgentType,
  folderPath: string | null = null,
  /** When false, the automatic probe is suppressed (no transient CLI spawn) —
   *  for editors whose agent-override section is collapsed. `ensure()` still
   *  probes on demand at save time. */
  enabled: boolean = true
): AgentOptionsState {
  // Snapshot and its producer live in ONE state value so they can never be
  // rendered out of step — see `snapshotAgentType`.
  const [loaded, setLoaded] = useState<{
    agent: AgentType
    snapshot: AgentOptionsSnapshot
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reqRef = useRef(0)

  const load = useCallback(
    (agent: AgentType, folder: string | null, force: boolean) => {
      // Bump FIRST so a cache hit also invalidates any still-in-flight probe for a
      // previously-selected (agent, folder) — otherwise that slow probe's late
      // result would overwrite the snapshot for the now-current one.
      const id = ++reqRef.current
      const key = cacheKey(agent, folder)
      if (force) {
        snapshotCache.delete(key)
        inflight.delete(key)
      } else {
        const cached = readCache(agent, folder)
        if (cached) {
          setLoaded({ agent, snapshot: cached })
          setError(null)
          setLoading(false)
          return
        }
      }
      setLoading(true)
      setError(null)
      setLoaded(null)
      fetchOptions(agent, folder)
        .then((fresh) => {
          if (reqRef.current !== id) return
          setLoaded({ agent, snapshot: fresh })
          setLoading(false)
        })
        .catch((e) => {
          if (reqRef.current !== id) return
          setError(toErrorMessage(e))
          setLoading(false)
        })
    },
    []
  )

  useEffect(() => {
    if (!enabled) return
    // Debounce so switching agents/folders quickly doesn't fire a probe (CLI
    // spawn) per click; the last (agent, folder) landed on wins.
    const handle = window.setTimeout(() => {
      void load(agentType, folderPath, false)
    }, 250)
    return () => window.clearTimeout(handle)
  }, [agentType, folderPath, load, enabled])

  const reload = useCallback(
    () => load(agentType, folderPath, true),
    [agentType, folderPath, load]
  )

  const ensure = useCallback(async (): Promise<AgentOptionsSnapshot | null> => {
    // Resolve against the CURRENT (agent, folder), not the retained React
    // `snapshot`: after an agent/folder switch the previous snapshot lingers until
    // the debounced re-probe lands, and returning it here would pin the wrong
    // agent's/folder's defaults into the save. The module cache + inflight map are
    // keyed by (agent, folder), so a hit is instant and a switch rides the
    // effect's in-flight probe (no double spawn).
    const cached = readCache(agentType, folderPath)
    if (cached) return cached
    // Bound the wait so a wedged probe degrades to "save with raw overrides"
    // rather than hanging the save.
    let timer: number | undefined
    const timeout = new Promise<null>((resolve) => {
      timer = window.setTimeout(() => resolve(null), 5000)
    })
    try {
      return await Promise.race([
        fetchOptions(agentType, folderPath).catch(() => null),
        timeout,
      ])
    } finally {
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [agentType, folderPath])

  return {
    snapshot: loaded?.snapshot ?? null,
    snapshotAgentType: loaded?.agent ?? null,
    loading,
    error,
    reload,
    ensure,
  }
}
