"use client"

import { useCallback, useEffect, useRef, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { useShallow } from "zustand/react/shallow"
import {
  followStoredFolderTabsPreference,
  useFolderTabsStore,
  shouldSeedConversation,
} from "@/stores/folder-tabs-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useAcpActions } from "@/contexts/acp-connections-context"
import { useWorkspaceActions } from "@/contexts/workspace-context"
import { useSortedAvailableAgents } from "@/hooks/use-sorted-available-agents"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import {
  dropParkedFolderGroupViews,
  pruneOrphanDraftsOnce,
  runCorrectionOnce,
  runRecoveryOnce,
  useTabStore,
  type OpenedDraftTarget,
  type TabItem,
} from "@/stores/tab-store"
import {
  CONVERSATION_CHANGED_EVENT,
  TABS_CHANGED_EVENT,
  type ConversationChange,
  type TabsChanged,
} from "@/lib/types"

export type { OpenedDraftTarget, TabItem }
export { useTabStore, useTabActions } from "@/stores/tab-store"

interface TabProviderProps {
  children: ReactNode
}

/**
 * Thin lifecycle glue for `useTabStore`: injects the React-land dependencies
 * (i18n labels, `activateConversationPane`, `acpDisconnect`, agent availability)
 * and drives the effects that need a React lifecycle — the persisted-tab
 * hydration, the debounced CAS save, the cross-client `tabs://changed` and
 * sub-session `conversation://changed` subscriptions, the provisional-agent
 * correction gate, and post-hydration recovery. All state and logic live in the
 * store; this component renders nothing but `children`.
 */
export function TabProvider({ children }: TabProviderProps) {
  const t = useTranslations("Folder.tabContext")
  const { activateConversationPane } = useWorkspaceActions()
  const { disconnect } = useAcpActions()
  // Tab teardown closes the surface either way, so the store's side effect
  // stays `Promise<void>` and drops `disconnect`'s teardown-confirmed flag —
  // that answer only matters to callers that report a restart to the user.
  const acpDisconnect = useCallback(
    async (contextKey: string) => {
      await disconnect(contextKey)
    },
    [disconnect]
  )
  const { sortedTypes: sortedAvailableAgents, fresh: agentsFresh } =
    useSortedAvailableAgents()

  // App-workspace gates for the correction / recovery / child-reconcile effects.
  const foldersHydrated = useAppWorkspaceStore((s) => s.foldersHydrated)
  const conversations = useAppWorkspaceStore((s) => s.conversations)
  const conversationsLoading = useAppWorkspaceStore(
    (s) => s.conversationsLoading
  )

  // Tab-store slices used only as effect dependencies (this component renders
  // nothing, so subscribing here doesn't cascade to any consumer).
  const tabsFollowFolder = useFolderTabsStore((s) => s.enabled)
  const rawTabs = useTabStore((s) => s.rawTabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const previewReplacedTabIds = useTabStore((s) => s.previewReplacedTabIds)
  const draftRetargetRequests = useTabStore((s) => s.draftRetargetRequests)
  const tabsHydrated = useTabStore((s) => s.tabsHydrated)
  const saveReconcileTick = useTabStore((s) => s.saveReconcileTick)
  const reseedTick = useTabStore((s) => s.reseedTick)

  const preferenceHydrated = useRef(false)
  useEffect(() => {
    if (!tabsHydrated || !foldersHydrated || preferenceHydrated.current) return
    preferenceHydrated.current = true
    useTabStore.getState().syncActiveFolderId()
    useFolderTabsStore.getState().hydratePreference()
    dropParkedFolderGroupViews()
  }, [tabsHydrated, foldersHydrated])
  // From then on, a switch made in another window applies here too.
  useEffect(() => {
    if (!tabsHydrated || !foldersHydrated) return
    window.addEventListener("storage", followStoredFolderTabsPreference)
    return () =>
      window.removeEventListener("storage", followStoredFolderTabsPreference)
  }, [tabsHydrated, foldersHydrated])

  // ── Runtime dependency injection ─────────────────────────────────────────────
  // Labels first (declared before hydrate) so seed titles are translated before
  // the hydration effect runs.
  useEffect(() => {
    useTabStore.getState().setLabels({
      loadingConversation: t("loadingConversation"),
      newConversation: t("newConversation"),
      untitledConversation: t("untitledConversation"),
    })
  }, [t])

  useEffect(() => {
    useTabStore
      .getState()
      .setSideEffects({ activateConversationPane, acpDisconnect })
  }, [activateConversationPane, acpDisconnect])

  useEffect(() => {
    useTabStore
      .getState()
      .setAgentAvailability(sortedAvailableAgents, agentsFresh)
  }, [sortedAvailableAgents, agentsFresh])

  // Sync the active tab's folderId up to the app-workspace store so derived
  // consumers (useActiveFolder, branch polling) reflect the focused folder.
  useEffect(() => {
    useTabStore.getState().syncActiveFolderId()
  }, [rawTabs, activeTabId])

  // Fire the preview-replacement callbacks and trim the consumed queue.
  useEffect(() => {
    useTabStore.getState().consumePreviewReplaced()
  }, [previewReplacedTabIds])

  // Disconnect + retarget each queued draft-retarget request.
  useEffect(() => {
    useTabStore.getState().consumeDraftRetargets()
  }, [draftRetargetRequests])

  // Hydrate from persisted opened_tabs on mount.
  useEffect(() => useTabStore.getState().hydrate(), [])

  // Debounced compare-and-set save + broadcast.
  useEffect(() => {
    useTabStore.getState().runSaveEffect()
  }, [rawTabs, activeTabId, tabsHydrated, saveReconcileTick])

  // Clear a pending save only on unmount — NOT on every effect re-run.
  useEffect(() => () => useTabStore.getState().clearSaveTimer(), [])

  // Reconcile the sub-session summary cache to the open child tabs.
  useEffect(() => {
    useTabStore.getState().reconcileChildSummaries()
  }, [rawTabs, conversations, conversationsLoading, reseedTick])

  // Keep seeded sub-session summaries live off the global conversation channel.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const dispose = await subscribe<ConversationChange>(
        CONVERSATION_CHANGED_EVENT,
        (change) => useTabStore.getState().handleChildConversationChange(change)
      )
      if (disposed) dispose()
      else unlisten = dispose
    })()
    const offReconnect = onTransportReconnect(() =>
      useTabStore.getState().handleChildReconnect()
    )
    return () => {
      disposed = true
      unlisten?.()
      offReconnect?.()
    }
  }, [])

  // Subscribe to the global `tabs://changed` side-channel.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const dispose = await subscribe<TabsChanged>(
        TABS_CHANGED_EVENT,
        (change) => useTabStore.getState().handleTabsChanged(change)
      )
      if (disposed) {
        dispose()
        return
      }
      unlisten = dispose
      // Close the initial-connect window (a change committed between the hydrate
      // snapshot read and the subscription going live is dropped by the
      // broadcaster). One reconcile after subscribe is ready catches it.
      void useTabStore.getState().refetchTabs()
    })()
    const offReconnect = onTransportReconnect(() =>
      useTabStore.getState().refetchTabs()
    )
    return () => {
      disposed = true
      unlisten?.()
      offReconnect?.()
    }
  }, [])

  // Correction must wait for the fresh agent list, hydrated tabs, and hydrated
  // folders (so folder defaults resolve). One-shot per session via the store.
  useEffect(() => {
    if (!agentsFresh) return
    if (!tabsHydrated) return
    if (!foldersHydrated) return
    runCorrectionOnce()
  }, [agentsFresh, tabsHydrated, foldersHydrated])

  // Once tabs AND folders are in: drop restored drafts whose folder is gone
  // (hydration is deliberately folder-blind), then — only if that leaves nothing
  // at all — recover a draft so the workspace is never blank. Order matters: an
  // orphaned draft must not suppress recovery. State is re-read after the prune
  // because the closure's `rawTabs` predates it.
  useEffect(() => {
    if (!tabsHydrated || !foldersHydrated) return
    pruneOrphanDraftsOnce()
    if (
      !shouldSeedConversation(
        useFolderTabsStore.getState().enabled,
        useTabStore.getState().rawTabs.length === 0
      )
    )
      return
    runRecoveryOnce()
  }, [tabsHydrated, foldersHydrated, rawTabs, tabsFollowFolder])

  // Persist the active draft's context for the next cold start.
  useEffect(() => {
    useTabStore.getState().persistLastActiveContext()
  }, [rawTabs, activeTabId, tabsHydrated])

  return <>{children}</>
}

export interface TabContextValue {
  tabs: TabItem[]
  activeTabId: string | null
  tabsHydrated: boolean
  tileByGroup: Record<string, boolean>
  openTab: (
    folderId: number,
    conversationId: number,
    agentType: TabItem["agentType"],
    pin?: boolean,
    title?: string
  ) => void
  /** See `TabStoreState.closeTab` for `recordForReopen`. */
  closeTab: (tabId: string, options?: { recordForReopen?: boolean }) => void
  closeConversationTab: (
    folderId: number,
    conversationId: number,
    agentType: TabItem["agentType"]
  ) => void
  closeOtherTabs: (tabId: string) => void
  closeAllTabs: () => void
  closeTabsByFolder: (folderId: number) => void
  switchTab: (tabId: string) => void
  pinTab: (tabId: string) => void
  toggleGroupTile: (groupId: string) => void
  consumeRemoteActivation: () => boolean
  openNewConversationTab: (
    folderId: number,
    workingDir: string,
    options?: {
      inheritFromActive?: boolean
      folderDefaultAgent?: TabItem["agentType"] | null
      targetGroup?: string
      forceAgent?: TabItem["agentType"]
      /** See the tab store's `openNewConversationTab`. */
      retargetTabId?: string
    }
  ) => OpenedDraftTarget
  openChatModeTab: (options?: {
    targetGroup?: string
    forceAgent?: TabItem["agentType"]
    /** See the tab store's `openNewConversationTab`. */
    retargetTabId?: string
  }) => OpenedDraftTarget
  setChatDraftWorkingDir: (tabId: string, workingDir: string) => void
  confirmDraftAgent: (tabId: string, agentType: TabItem["agentType"]) => void
  setDraftAgentFromFallback: (
    tabId: string,
    agentType: TabItem["agentType"]
  ) => void
  bindConversationTab: (
    tabId: string,
    conversationId: number,
    agentType: TabItem["agentType"],
    title: string,
    runtimeConversationId?: number,
    folderId?: number,
    workingDir?: string
  ) => void
  setTabRuntimeConversationId: (
    tabId: string,
    runtimeConversationId: number
  ) => void
  reorderTabs: (reorderedTabs: TabItem[]) => void
  onPreviewTabReplaced: (callback: (tabId: string) => void) => () => void
}

/**
 * Backwards-compatible whole-value accessor over the tab store. Kept so existing
 * consumers keep working during the incremental selector migration; new/hot
 * consumers should read `useTabStore(selector)` / `useTabActions()` directly to
 * subscribe to the narrowest slice they render. `useShallow` keeps the returned
 * object stable, so this re-renders only when a read field (tabs/activeTabId/
 * tabsHydrated/tileByGroup) changes — matching the former context's behavior.
 */
export function useTabContext(): TabContextValue {
  return useTabStore(
    useShallow((s) => ({
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      tabsHydrated: s.tabsHydrated,
      tileByGroup: s.tileByGroup,
      openTab: s.openTab,
      closeTab: s.closeTab,
      closeConversationTab: s.closeConversationTab,
      closeOtherTabs: s.closeOtherTabs,
      closeAllTabs: s.closeAllTabs,
      closeTabsByFolder: s.closeTabsByFolder,
      switchTab: s.switchTab,
      pinTab: s.pinTab,
      toggleGroupTile: s.toggleGroupTile,
      consumeRemoteActivation: s.consumeRemoteActivation,
      openNewConversationTab: s.openNewConversationTab,
      openChatModeTab: s.openChatModeTab,
      setChatDraftWorkingDir: s.setChatDraftWorkingDir,
      confirmDraftAgent: s.confirmDraftAgent,
      setDraftAgentFromFallback: s.setDraftAgentFromFallback,
      bindConversationTab: s.bindConversationTab,
      setTabRuntimeConversationId: s.setTabRuntimeConversationId,
      reorderTabs: s.reorderTabs,
      onPreviewTabReplaced: s.onPreviewTabReplaced,
    }))
  )
}
