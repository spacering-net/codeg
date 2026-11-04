"use client"

import { useCallback, useEffect } from "react"
import { create } from "zustand"
import {
  listAgentAccounts,
  type AgentAccountsResult,
} from "@/lib/agent-accounts"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import type { UnsubscribeFn } from "@/lib/transport/types"
import type { AgentType } from "@/lib/types"

const ACP_AGENTS_UPDATED_EVENT = "app://acp-agents-updated"

interface AccountsEntry {
  data: AgentAccountsResult | null
  error: boolean
}

// One cached list per agent type, shared by every consumer. Every open
// conversation tab mounts this hook (hidden ones included), and each instance
// used to fetch for itself, so one registry change sent a request per tab.
const useAgentAccountsStore = create<{
  byAgent: Partial<Record<string, AccountsEntry>>
}>(() => ({ byAgent: {} }))

// Per agent type, the latest reload issued and the latest one that wrote
// state. As in `use-acp-agents`: a response older than the last write is
// dropped, while a newer one still lands when an even newer reload is pending.
const latestRequestId = new Map<string, number>()
const latestWriteId = new Map<string, number>()
// Mounted consumers per agent type. A type's cached list lives only while it
// has one: the update listeners are what keep it current. `generation` counts
// how often it was dropped, so a mount undone before its first fetch started
// (React's dev double-mount) does not fetch twice.
const consumers = new Map<string, number>()
const generation = new Map<string, number>()
let disposers: Array<() => void> = []

async function reload(agentType: AgentType): Promise<void> {
  const requestId = (latestRequestId.get(agentType) ?? 0) + 1
  latestRequestId.set(agentType, requestId)
  let entry: AccountsEntry
  try {
    entry = { data: await listAgentAccounts(agentType), error: false }
  } catch {
    // Keep the last list a failed refresh would replace: with one shared
    // copy, clearing it would empty every tab at once on a transient error.
    const previous = useAgentAccountsStore.getState().byAgent[agentType]
    entry = { data: previous?.data ?? null, error: true }
  }
  if (!consumers.get(agentType)) return
  if (requestId <= (latestWriteId.get(agentType) ?? 0)) return
  latestWriteId.set(agentType, requestId)
  useAgentAccountsStore.setState((s) => ({
    byAgent: { ...s.byAgent, [agentType]: entry },
  }))
}

function reloadMounted() {
  for (const agentType of consumers.keys()) void reload(agentType as AgentType)
}

function startSharedSubscription() {
  // This subscription's own callback. Transports keep handlers in a set, so a
  // function shared across subscriptions would let one torn down before its
  // subscribe resolved remove the next one's handler when it finally does.
  const onUpdate = () => reloadMounted()
  let eventUnsub: UnsubscribeFn | null = null
  let eventDisposed = false
  void subscribe<unknown>(ACP_AGENTS_UPDATED_EVENT, onUpdate)
    .then((dispose) => {
      if (eventDisposed) {
        dispose()
        return
      }
      eventUnsub = dispose
    })
    .catch(() => {
      // No event channel: the lists still load on mount and on reconnect.
    })
  disposers.push(() => {
    eventDisposed = true
    if (eventUnsub) {
      try {
        eventUnsub()
      } catch {
        // Ignore — disposing twice or transport gone is harmless.
      }
    }
  })
  // Web/remote transports drop events emitted while disconnected. Registering
  // runs synchronously inside a mount effect, so a transport that cannot be
  // reached must not throw out of it: the lists still load on mount.
  let offReconnect: UnsubscribeFn | null = null
  try {
    offReconnect = onTransportReconnect(onUpdate)
  } catch {
    // No reconnect notifications.
  }
  disposers.push(() => {
    try {
      offReconnect?.()
    } catch {
      // Ignore.
    }
  })
}

function acquire(agentType: AgentType): () => void {
  if (consumers.size === 0) startSharedSubscription()
  const count = consumers.get(agentType) ?? 0
  consumers.set(agentType, count + 1)
  if (count === 0) {
    // Deferred so mounting never writes the store synchronously in an effect.
    const mounted = generation.get(agentType) ?? 0
    queueMicrotask(() => {
      if ((generation.get(agentType) ?? 0) === mounted) void reload(agentType)
    })
  }
  return () => {
    const left = (consumers.get(agentType) ?? 1) - 1
    if (left > 0) {
      consumers.set(agentType, left)
      return
    }
    consumers.delete(agentType)
    generation.set(agentType, (generation.get(agentType) ?? 0) + 1)
    // Unwatched, the list can miss an update: drop it (and any reload still
    // in flight) so the next consumer starts from a fresh fetch.
    latestWriteId.set(agentType, latestRequestId.get(agentType) ?? 0)
    useAgentAccountsStore.setState((s) => {
      const byAgent = { ...s.byAgent }
      delete byAgent[agentType]
      return { byAgent }
    })
    if (consumers.size === 0) {
      for (const dispose of disposers) dispose()
      disposers = []
    }
  }
}

export function useAgentAccounts(agentType: AgentType) {
  useEffect(() => acquire(agentType), [agentType])
  const entry = useAgentAccountsStore((s) => s.byAgent[agentType])
  const refresh = useCallback(() => reload(agentType), [agentType])
  return {
    accounts: entry?.data?.accounts ?? [],
    capability: entry?.data?.capabilities.find(
      (c) => c.agentType === agentType
    ),
    loading: entry === undefined,
    error: entry?.error ?? false,
    refresh,
  }
}

/** Test-only: drop every cached list, listener and counter. */
export function resetAgentAccountsStore(): void {
  for (const dispose of disposers) dispose()
  disposers = []
  consumers.clear()
  generation.clear()
  latestRequestId.clear()
  latestWriteId.clear()
  useAgentAccountsStore.setState({ byAgent: {} })
}
