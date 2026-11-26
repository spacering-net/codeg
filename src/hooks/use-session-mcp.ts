"use client"

/**
 * Shared lightweight MCP inventory & probe store for session-scoped surfaces
 * (`SessionMcpSection` in Session Details and `SessionMcpPopover` in the
 * composer status bar).
 *
 * Design goals:
 * - Zero polling. Reads `mcpInventory()` lazily only when an active consumer
 *   requests it (e.g. expanded MCP section or open popover), deduplicating
 *   concurrent fetches across all mounted tabs.
 * - Subscribes once (ref-counted) to `mcp://changed` while active consumers
 *   exist; marks data dirty and refreshes only for active consumers.
 * - Shares probe results across the Session Details section and Composer
 *   popover so probing a server in one surface updates the other immediately.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"

import { mcpApply, mcpInventory, mcpProbe, onMcpChanged } from "@/lib/mcp/api"
import { mcpFailureOf, type McpFailure } from "@/lib/mcp/errors"
import { isSaved } from "@/lib/mcp/results"
import {
  deriveSessionMcpState,
  sessionProbeEntryKey,
  type SessionMcpProbeMap,
  type UnifiedMcpState,
} from "@/lib/mcp/session-state"
import type {
  McpAgentId,
  McpAgentInventory,
  McpInventory,
  McpProbeResult,
} from "@/lib/mcp/types"
import { getTransport } from "@/lib/transport"
import type {
  AgentType,
  ConfigStaleKind,
  ConnectionStatus,
  SessionFailureRecord,
  SessionMcpState,
} from "@/lib/types"

interface SessionMcpStoreSnapshot {
  phase: "idle" | "loading" | "ready" | "error"
  inventory: McpInventory | null
  error: McpFailure | null
  dirty: boolean
  probes: SessionMcpProbeMap
}

let snapshot: SessionMcpStoreSnapshot = {
  phase: "idle",
  inventory: null,
  error: null,
  dirty: true,
  probes: {},
}

let inFlightInventory: Promise<McpInventory | null> | null = null
let inventorySeq = 0
let probeSeq = 0
const probeSeqByKey = new Map<string, number>()

const listeners = new Set<() => void>()
let activeConsumers = 0
let unsubChanged: (() => void) | null = null
let unsubReconnect: (() => void) | null = null
let subscribingChanged = false

function emit(): void {
  for (const listener of listeners) listener()
}

function setSnapshot(
  updater: (prev: SessionMcpStoreSnapshot) => SessionMcpStoreSnapshot
): void {
  const next = updater(snapshot)
  if (next === snapshot) return
  snapshot = next
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): SessionMcpStoreSnapshot {
  return snapshot
}

function pruneStaleProbes(inventory: McpInventory): void {
  const prev = snapshot.probes
  const keys = Object.keys(prev)
  if (keys.length === 0) return

  const fingerprints = new Map<string, string | null>()
  for (const agent of inventory.agents) {
    for (const entry of agent.entries) {
      fingerprints.set(`entry:${agent.agent}:${entry.key}`, entry.fingerprint)
    }
  }

  let changed = false
  const next: Record<string, SessionMcpProbeMap[string]> = {}
  for (const key of keys) {
    const rec = prev[key]
    if (rec.phase === "loading") {
      next[key] = rec
      continue
    }
    if (key.startsWith("entry:")) {
      if (fingerprints.has(key) && fingerprints.get(key) === rec.fingerprint) {
        next[key] = rec
      } else {
        changed = true
      }
      continue
    }
    next[key] = rec
  }
  if (changed) {
    setSnapshot((cur) => ({ ...cur, probes: next }))
  }
}

export async function refreshSessionMcpInventory(): Promise<McpInventory | null> {
  if (inFlightInventory) return inFlightInventory
  const seq = ++inventorySeq
  setSnapshot((prev) => ({
    ...prev,
    phase: prev.inventory ? prev.phase : "loading",
    dirty: false,
  }))
  let run: Promise<McpInventory | null> | null = null
  run = (async () => {
    try {
      const inv = await mcpInventory()
      if (seq !== inventorySeq) return inv
      setSnapshot((prev) => ({
        ...prev,
        phase: "ready",
        inventory: inv,
        error: null,
        dirty: false,
      }))
      pruneStaleProbes(inv)
      return inv
    } catch (error) {
      if (seq !== inventorySeq) return null
      setSnapshot((prev) => ({
        ...prev,
        phase: "error",
        error: mcpFailureOf(error),
        dirty: true,
      }))
      return null
    } finally {
      if (inFlightInventory === run) inFlightInventory = null
    }
  })()
  inFlightInventory = run
  return run
}

function retainActiveWatcher(): () => void {
  activeConsumers += 1
  if (activeConsumers === 1 && !unsubChanged && !subscribingChanged) {
    subscribingChanged = true
    onMcpChanged(() => {
      setSnapshot((prev) => ({ ...prev, dirty: true }))
      if (activeConsumers > 0) {
        void refreshSessionMcpInventory()
      }
    })
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
        setSnapshot((prev) => ({ ...prev, dirty: true }))
        if (activeConsumers > 0) {
          void refreshSessionMcpInventory()
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

export async function runSessionMcpProbe(
  agent: McpAgentId,
  key: string,
  fingerprint: string | null
): Promise<McpProbeResult | null> {
  const probeKey = sessionProbeEntryKey(agent, key)
  const seq = ++probeSeq
  probeSeqByKey.set(probeKey, seq)
  setSnapshot((prev) => ({
    ...prev,
    probes: {
      ...prev.probes,
      [probeKey]: {
        phase: "loading",
        fingerprint,
        result: prev.probes[probeKey]?.result ?? null,
        failure: null,
      },
    },
  }))
  try {
    const result = await mcpProbe({ agent, key })
    if (probeSeqByKey.get(probeKey) !== seq) return result
    setSnapshot((prev) => ({
      ...prev,
      probes: {
        ...prev.probes,
        [probeKey]: {
          phase: "ready",
          fingerprint,
          result,
          failure: null,
        },
      },
    }))
    return result
  } catch (error) {
    if (probeSeqByKey.get(probeKey) !== seq) return null
    const failure = mcpFailureOf(error)
    setSnapshot((prev) => ({
      ...prev,
      probes: {
        ...prev.probes,
        [probeKey]: {
          phase: "error",
          fingerprint,
          result: null,
          failure: { kind: failure.kind, detail: failure.detail ?? null },
        },
      },
    }))
    return null
  }
}

/** Test-only reset to keep unit tests isolated. */
export function resetSessionMcpStoreForTests(): void {
  unsubChanged?.()
  unsubChanged = null
  unsubReconnect?.()
  unsubReconnect = null
  subscribingChanged = false
  activeConsumers = 0
  inFlightInventory = null
  inventorySeq = 0
  probeSeq = 0
  probeSeqByKey.clear()
  snapshot = {
    phase: "idle",
    inventory: null,
    error: null,
    dirty: true,
    probes: {},
  }
  emit()
}

export interface UseSessionMcpOptions {
  agentType: AgentType | null | undefined
  /** Whether the surface is currently visible/expanded and allowed to load
   *  inventory and subscribe to `mcp://changed`. */
  active: boolean
  connectionStatus?: ConnectionStatus | null
  sessionMcpState?: SessionMcpState | null
  sessionFailures?: readonly SessionFailureRecord[]
  errorText?: string | null
  configStale?: boolean
  configStaleKind?: ConfigStaleKind | null
  observedToolsByServer?: Readonly<Record<string, readonly string[]>>
}

export interface UseSessionMcpReturn {
  state: UnifiedMcpState
  inventoryAgent: McpAgentInventory | null
  loading: boolean
  error: McpFailure | null
  hasLoadedInventory: boolean
  refresh: () => Promise<McpInventory | null>
  probeServer: (key: string) => Promise<McpProbeResult | null>
  probeAllActive: () => Promise<void>
  pauseServer: (key: string) => Promise<"paused" | "already_paused" | "failed">
}

export function useSessionMcp(
  options: UseSessionMcpOptions
): UseSessionMcpReturn {
  const {
    agentType,
    active,
    connectionStatus,
    sessionMcpState,
    sessionFailures,
    errorText,
    configStale,
    configStaleKind,
    observedToolsByServer,
  } = options

  const store = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useEffect(() => {
    if (!active || !agentType) return
    const release = retainActiveWatcher()
    if (snapshot.dirty || snapshot.inventory === null) {
      void refreshSessionMcpInventory()
    }
    return release
  }, [active, agentType])

  const state = useMemo(() => {
    const inventoryAgent =
      store.inventory?.agents.find((item) => item.agent === agentType) ?? null
    return deriveSessionMcpState({
      agentType,
      connectionStatus,
      sessionMcpState,
      inventoryAgent,
      probeMap: store.probes,
      sessionFailures,
      errorText,
      configStale,
      configStaleKind,
      observedToolsByServer,
    })
  }, [
    agentType,
    connectionStatus,
    sessionMcpState,
    store.inventory,
    store.probes,
    sessionFailures,
    errorText,
    configStale,
    configStaleKind,
    observedToolsByServer,
  ])

  const inventoryAgent = useMemo(
    () =>
      store.inventory?.agents.find((item) => item.agent === state.mcpAgentId) ??
      null,
    [store.inventory, state.mcpAgentId]
  )

  const probeServer = useCallback(
    async (key: string): Promise<McpProbeResult | null> => {
      if (!state.mcpAgentId) return null
      const row = state.rows.find((item) => item.key === key)
      return runSessionMcpProbe(state.mcpAgentId, key, row?.fingerprint ?? null)
    },
    [state.mcpAgentId, state.rows]
  )

  const probeAllActive = useCallback(async () => {
    if (!state.mcpAgentId) return
    const targets = state.rows.filter(
      (row) => row.canProbe && !row.paused && !row.removedPendingReconnect
    )
    await Promise.all(
      targets.map((row) =>
        runSessionMcpProbe(state.mcpAgentId!, row.key, row.fingerprint)
      )
    )
  }, [state.mcpAgentId, state.rows])

  const pauseServer = useCallback(
    async (key: string): Promise<"paused" | "already_paused" | "failed"> => {
      if (!state.mcpAgentId) return "failed"
      try {
        const inv = await refreshSessionMcpInventory()
        const agentInv = inv?.agents.find(
          (item) => item.agent === state.mcpAgentId
        )
        const entry = agentInv?.entries.find((item) => item.key === key)
        if (!agentInv || !entry) return "failed"
        if (!entry.enabled) return "already_paused"
        if (
          !agentInv.writable ||
          !agentInv.can_disable ||
          entry.read_only ||
          entry.reserved ||
          agentInv.config.basis === null
        ) {
          return "failed"
        }
        const result = await mcpApply({
          basis: { [state.mcpAgentId]: agentInv.config.basis },
          ops: [
            {
              agent: state.mcpAgentId,
              key,
              action: "set_enabled",
              enabled: false,
            },
          ],
        })
        if (!isSaved(result)) return "failed"
        await refreshSessionMcpInventory()
        return "paused"
      } catch {
        return "failed"
      }
    },
    [state.mcpAgentId]
  )

  return {
    state,
    inventoryAgent,
    loading: store.phase === "loading" && store.inventory === null,
    error: store.error,
    hasLoadedInventory: store.inventory !== null,
    refresh: refreshSessionMcpInventory,
    probeServer,
    probeAllActive,
    pauseServer,
  }
}
