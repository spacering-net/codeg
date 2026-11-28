"use client"

/**
 * Shared lightweight OAuth bridge store for MCP surfaces (`McpServerDetail`,
 * `McpSection`, `SessionMcpSection`, and `SessionMcpPopover`).
 *
 * Design goals (mirrors `use-session-mcp.ts`):
 * - Zero polling. Fetches `mcpOAuthList()` once when at least one active
 *   consumer is mounted, deduplicating concurrent requests.
 * - Subscribes once (ref-counted) to `mcp://oauth-changed` and transport
 *   reconnect events while active consumers exist.
 * - Gracefully degrades on older servers that do not implement
 *   `mcp_oauth_list`: silently sets `available: false, snapshot: null`
 *   without throwing or blocking any existing MCP or chat UI.
 */
import { useEffect, useSyncExternalStore } from "react"

import {
  mcpOAuthList,
  onMcpOAuthChanged,
  type McpOAuthBridgeSnapshot,
} from "@/lib/mcp/oauth"
import { getTransport } from "@/lib/transport"

interface McpOAuthStoreState {
  phase: "idle" | "loading" | "ready" | "unavailable"
  available: boolean
  snapshot: McpOAuthBridgeSnapshot | null
  dirty: boolean
}

let state: McpOAuthStoreState = {
  phase: "idle",
  available: true,
  snapshot: null,
  dirty: true,
}

let inFlightList: Promise<McpOAuthBridgeSnapshot | null> | null = null
let listSeq = 0

const listeners = new Set<() => void>()
let activeConsumers = 0
let unsubChanged: (() => void) | null = null
let unsubReconnect: (() => void) | null = null
let subscribingChanged = false

function emit(): void {
  for (const listener of listeners) listener()
}

function setState(
  updater: (prev: McpOAuthStoreState) => McpOAuthStoreState
): void {
  const next = updater(state)
  if (next === state) return
  state = next
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): McpOAuthStoreState {
  return state
}

export async function refreshMcpOAuthSnapshot(): Promise<McpOAuthBridgeSnapshot | null> {
  if (inFlightList) return inFlightList
  const seq = ++listSeq
  setState((prev) => ({
    ...prev,
    phase: prev.snapshot ? prev.phase : "loading",
    dirty: false,
  }))
  let run: Promise<McpOAuthBridgeSnapshot | null> | null = null
  run = (async () => {
    try {
      const snap = await mcpOAuthList()
      if (seq !== listSeq) return snap
      setState((prev) => ({
        ...prev,
        phase: "ready",
        available: true,
        snapshot: snap,
        dirty: false,
      }))
      return snap
    } catch {
      if (seq !== listSeq) return null
      setState((prev) => ({
        ...prev,
        phase: prev.snapshot ? prev.phase : "unavailable",
        available: prev.snapshot !== null,
        snapshot: prev.snapshot,
        dirty: false,
      }))
      return null
    } finally {
      if (inFlightList === run) inFlightList = null
    }
  })()
  inFlightList = run
  return run
}

/**
 * Push a fresh snapshot returned directly by a mutation (e.g. `mcpOAuthRevoke`)
 * so all subscribers update immediately without waiting for another round-trip.
 */
export function setMcpOAuthSnapshot(snapshot: McpOAuthBridgeSnapshot): void {
  listSeq += 1
  setState((prev) => ({
    ...prev,
    phase: "ready",
    available: true,
    snapshot,
    dirty: false,
  }))
}

function retainActiveWatcher(): () => void {
  activeConsumers += 1
  if (activeConsumers === 1 && !unsubChanged && !subscribingChanged) {
    subscribingChanged = true
    Promise.resolve()
      .then(() =>
        onMcpOAuthChanged(() => {
          setState((prev) => ({ ...prev, dirty: true }))
          if (activeConsumers > 0) {
            void refreshMcpOAuthSnapshot()
          }
        })
      )
      .then((stop) => {
        subscribingChanged = false
        if (activeConsumers === 0) {
          stop()
        } else {
          unsubChanged = stop
        }
      })
      .catch(() => {
        subscribingChanged = false
      })
    unsubReconnect =
      getTransport().onReconnect?.(() => {
        setState((prev) => ({ ...prev, dirty: true }))
        if (activeConsumers > 0) {
          void refreshMcpOAuthSnapshot()
        }
      }) ?? null
  }
  return () => {
    activeConsumers = Math.max(0, activeConsumers - 1)
    if (activeConsumers === 0) {
      unsubChanged?.()
      unsubChanged = null
      unsubReconnect?.()
      unsubReconnect = null
    }
  }
}

/** Test-only reset to keep unit tests isolated. */
export function resetMcpOAuthStoreForTests(): void {
  unsubChanged?.()
  unsubChanged = null
  unsubReconnect?.()
  unsubReconnect = null
  subscribingChanged = false
  activeConsumers = 0
  inFlightList = null
  listSeq = 0
  state = {
    phase: "idle",
    available: true,
    snapshot: null,
    dirty: true,
  }
  emit()
}

export interface UseMcpOAuthOptions {
  /** Whether this consumer is visible/active and allowed to load OAuth routes
   *  and subscribe to `mcp://oauth-changed`. Defaults to `true`. */
  active?: boolean
}

export interface UseMcpOAuthReturn {
  snapshot: McpOAuthBridgeSnapshot | null
  available: boolean
  loading: boolean
  refresh: () => Promise<McpOAuthBridgeSnapshot | null>
}

export function useMcpOAuth(
  options: UseMcpOAuthOptions = {}
): UseMcpOAuthReturn {
  const { active = true } = options
  const store = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useEffect(() => {
    if (!active) return
    const release = retainActiveWatcher()
    if (state.dirty || (state.phase === "idle" && state.snapshot === null)) {
      void refreshMcpOAuthSnapshot()
    }
    return release
  }, [active])

  return {
    snapshot: store.snapshot,
    available: store.available,
    loading: store.phase === "loading" && store.snapshot === null,
    refresh: refreshMcpOAuthSnapshot,
  }
}
