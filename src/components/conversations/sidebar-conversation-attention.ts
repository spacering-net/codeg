"use client"

import { useEffect, useMemo, useSyncExternalStore } from "react"

import {
  useConnectionStore,
  type ConnectionState,
  type ConnectionStoreApi,
} from "@/contexts/acp-connections-context"
import type { ConnectionStatus } from "@/lib/types"
import { useTabStore, type TabItem } from "@/stores/tab-store"

interface SidebarAttentionTarget {
  contextKey: string
  conversationKey: string
}

export interface SidebarCompletionObservation extends SidebarAttentionTarget {
  status: ConnectionStatus | undefined
}

export interface SidebarCompletionState {
  observations: ReadonlyMap<string, SidebarCompletionObservation>
  unreadConversationKeys: ReadonlySet<string>
}

export function connectionNeedsAttention(
  connection: ConnectionState | undefined
): boolean {
  if (!connection) return false
  return Boolean(
    connection.pendingPermission ||
    connection.pendingQuestion ||
    (connection.pendingAskQuestion?.questions.length ?? 0) > 0 ||
    connection.pendingPlanApproval
  )
}

export function sidebarAttentionTargets(
  tabs: readonly TabItem[]
): SidebarAttentionTarget[] {
  return tabs.flatMap((tab) =>
    tab.conversationId == null
      ? []
      : [
          {
            contextKey: tab.id,
            conversationKey: `${tab.agentType}:${tab.conversationId}`,
          },
        ]
  )
}

export function createSidebarAttentionStore(
  targets: readonly SidebarAttentionTarget[],
  store: ConnectionStoreApi
) {
  const contextKeys = [...new Set(targets.map((target) => target.contextKey))]

  return {
    subscribe(callback: () => void) {
      const unsubscribers = contextKeys.map((key) =>
        store.subscribeKey(key, callback)
      )
      return () => {
        for (const unsubscribe of unsubscribers) unsubscribe()
      }
    },
    getSnapshot() {
      return targets
        .filter((target) =>
          connectionNeedsAttention(store.getConnection(target.contextKey))
        )
        .map((target) => target.conversationKey)
        .sort()
        .join("\n")
    },
  }
}

export function reduceSidebarCompletionState(
  state: SidebarCompletionState,
  observations: readonly SidebarCompletionObservation[],
  activeConversationKey: string | null
): SidebarCompletionState {
  const nextObservations = new Map(
    observations.map((observation) => [observation.contextKey, observation])
  )
  const openConversationKeys = new Set(
    observations.map((observation) => observation.conversationKey)
  )
  const unreadConversationKeys = new Set(
    [...state.unreadConversationKeys].filter((key) =>
      openConversationKeys.has(key)
    )
  )

  for (const observation of observations) {
    const previous = state.observations.get(observation.contextKey)

    if (observation.status === "prompting") {
      unreadConversationKeys.delete(observation.conversationKey)
    } else if (
      previous?.status === "prompting" &&
      observation.status === "connected"
    ) {
      if (observation.conversationKey === activeConversationKey) {
        unreadConversationKeys.delete(observation.conversationKey)
      } else {
        unreadConversationKeys.add(observation.conversationKey)
      }
    }
  }

  if (activeConversationKey) {
    unreadConversationKeys.delete(activeConversationKey)
  }

  return {
    observations: nextObservations,
    unreadConversationKeys,
  }
}

interface SidebarCompletionTracker {
  subscribe: (callback: () => void) => () => void
  getSnapshot: () => string
  setInputs: (
    targets: readonly SidebarAttentionTarget[],
    activeConversationKey: string | null
  ) => void
}

function createSidebarCompletionTracker(
  store: ConnectionStoreApi
): SidebarCompletionTracker {
  let targets: readonly SidebarAttentionTarget[] = []
  let targetsSignature = ""
  let activeConversationKey: string | null = null
  let state: SidebarCompletionState = {
    observations: new Map(),
    unreadConversationKeys: new Set(),
  }
  let snapshot = ""
  let unsubscribeConnections: (() => void)[] = []
  const listeners = new Set<() => void>()

  const publish = () => {
    const observations = targets.map((target) => ({
      ...target,
      status: store.getConnection(target.contextKey)?.status,
    }))
    state = reduceSidebarCompletionState(
      state,
      observations,
      activeConversationKey
    )
    const nextSnapshot = [...state.unreadConversationKeys].sort().join("\n")
    if (nextSnapshot === snapshot) return
    snapshot = nextSnapshot
    for (const listener of listeners) listener()
  }

  const unsubscribeAllConnections = () => {
    for (const unsubscribe of unsubscribeConnections) unsubscribe()
    unsubscribeConnections = []
  }

  return {
    subscribe(callback) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    getSnapshot() {
      return snapshot
    },
    setInputs(nextTargets, nextActiveConversationKey) {
      const nextSignature = nextTargets
        .map((target) => `${target.contextKey}\t${target.conversationKey}`)
        .join("\n")
      const targetsChanged = nextSignature !== targetsSignature

      targets = nextTargets
      targetsSignature = nextSignature
      activeConversationKey = nextActiveConversationKey

      if (targetsChanged) {
        unsubscribeAllConnections()
        const contextKeys = [
          ...new Set(targets.map((target) => target.contextKey)),
        ]
        unsubscribeConnections = contextKeys.map((key) =>
          store.subscribeKey(key, publish)
        )
      }

      publish()
    },
  }
}

const completionTrackers = new WeakMap<
  ConnectionStoreApi,
  SidebarCompletionTracker
>()

function getSidebarCompletionTracker(
  store: ConnectionStoreApi
): SidebarCompletionTracker {
  const existing = completionTrackers.get(store)
  if (existing) return existing

  const tracker = createSidebarCompletionTracker(store)
  completionTrackers.set(store, tracker)
  return tracker
}

const EMPTY_ATTENTION_KEYS: ReadonlySet<string> = new Set()

export function useSidebarConversationAttention(
  tabs: readonly TabItem[]
): ReadonlySet<string> {
  const connectionStore = useConnectionStore()
  const targets = useMemo(() => sidebarAttentionTargets(tabs), [tabs])
  const attentionStore = useMemo(
    () => createSidebarAttentionStore(targets, connectionStore),
    [targets, connectionStore]
  )
  const snapshot = useSyncExternalStore(
    attentionStore.subscribe,
    attentionStore.getSnapshot,
    attentionStore.getSnapshot
  )

  return useMemo(
    () => (snapshot ? new Set(snapshot.split("\n")) : EMPTY_ATTENTION_KEYS),
    [snapshot]
  )
}

const EMPTY_COMPLETION_KEYS: ReadonlySet<string> = new Set()

export function useSidebarConversationCompletion(
  tabs: readonly TabItem[],
  activeTabId: string | null
): ReadonlySet<string> {
  const connectionStore = useConnectionStore()
  const targets = useMemo(() => sidebarAttentionTargets(tabs), [tabs])
  const completionTracker = useMemo(
    () => getSidebarCompletionTracker(connectionStore),
    [connectionStore]
  )
  const activeConversationKey = useMemo(() => {
    const activeTab = tabs.find((tab) => tab.id === activeTabId)
    return activeTab?.conversationId == null
      ? null
      : `${activeTab.agentType}:${activeTab.conversationId}`
  }, [tabs, activeTabId])
  const snapshot = useSyncExternalStore(
    completionTracker.subscribe,
    completionTracker.getSnapshot,
    completionTracker.getSnapshot
  )

  useEffect(() => {
    completionTracker.setInputs(targets, activeConversationKey)
  }, [completionTracker, targets, activeConversationKey])

  return useMemo(
    () => (snapshot ? new Set(snapshot.split("\n")) : EMPTY_COMPLETION_KEYS),
    [snapshot]
  )
}

export function SidebarConversationCompletionBridge() {
  const tabs = useTabStore((state) => state.tabs)
  const activeTabId = useTabStore((state) => state.activeTabId)
  useSidebarConversationCompletion(tabs, activeTabId)
  return null
}
