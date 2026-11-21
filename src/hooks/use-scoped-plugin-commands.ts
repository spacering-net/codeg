"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"
import { useActiveFolder } from "@/contexts/active-folder-context"
import * as tabContextModule from "@/contexts/tab-context"
import type { PluginScreenRouteTarget } from "@/contexts/workbench-route-context"
import { toErrorMessage } from "@/lib/app-error"
import {
  formatPluginCommandResult,
  isCurrentReadyHostTransport,
  pluginPanelKey,
  selectPluginCommands,
  subscribeHostTransportChange,
  useHostPlugins,
  usePluginHostScope,
  type InstalledPlugin,
  type PluginCommandScope,
  type ResolvedPluginCommand,
} from "@/lib/host-plugins"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

interface ActiveConversationTabSnapshot {
  id: string
  kind: string
  conversationId: number | null
  isChat?: boolean
}

type TabStoreLike = {
  <T>(
    selector: (state: {
      activeTabId: string | null
      tabs: ActiveConversationTabSnapshot[]
    }) => T
  ): T
  getState?: () => {
    activeTabId: string | null
    tabs: ActiveConversationTabSnapshot[]
  }
}

function selectActiveTab(state: {
  activeTabId: string | null
  tabs: ActiveConversationTabSnapshot[]
}): ActiveConversationTabSnapshot | null {
  if (!state.activeTabId) return null
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? null
}

function getOptionalTabStore(): TabStoreLike | null {
  try {
    const store = (
      tabContextModule as {
        useTabStore?: TabStoreLike
      }
    ).useTabStore
    return typeof store === "function" ? store : null
  } catch {
    // Partial mock in unit tests without useTabStore.
    return null
  }
}

function useActiveConversationTab(): ActiveConversationTabSnapshot | null {
  const store = getOptionalTabStore()
  if (store) {
    return store(selectActiveTab)
  }
  return null
}

function readLiveActiveConversationTab(): ActiveConversationTabSnapshot | null {
  const store = getOptionalTabStore()
  if (typeof store?.getState === "function") {
    return selectActiveTab(store.getState())
  }
  return null
}

const MAX_ERROR_DESCRIPTION_CHARS = 240
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect

function truncateErrorDescription(message: string): string {
  const trimmed = message.trim()
  if (trimmed.length <= MAX_ERROR_DESCRIPTION_CHARS) return trimmed
  return `${trimmed.slice(0, MAX_ERROR_DESCRIPTION_CHARS - 1)}…`
}

export interface ScopedPluginCommandExecutors {
  openConversations?: () => void
  openPluginScreen?: (target: PluginScreenRouteTarget) => void
  openPluginPanel?: (panelKey: string) => void
}

export interface UseScopedPluginCommandsOptions extends ScopedPluginCommandExecutors {
  /**
   * Whether to actively subscribe to the host plugin catalog. While any
   * `callMethod` invocation is in-flight, the hook keeps its catalog and scope
   * tracking active until the call settles.
   */
  enabled?: boolean
  /**
   * When true, callers (such as a dropdown menu that unmounts on item select)
   * allow an already-started `callMethod` call to still validate against live
   * host/store state after the menu closes, while still dropping stale
   * responses if the workspace, session, plugin catalog, or Transport changes.
   */
  allowAfterUnmount?: boolean
}

export interface UseScopedPluginCommandsResult {
  commands: ResolvedPluginCommand[]
  folderId: number | null
  conversationId: number | null
  pendingKeys: ReadonlySet<string>
  executeCommand: (command: ResolvedPluginCommand) => void
  scopeLabel: (scope: PluginCommandScope) => string
}

export function useScopedPluginCommands({
  enabled = true,
  allowAfterUnmount = false,
  openConversations,
  openPluginScreen,
  openPluginPanel,
}: UseScopedPluginCommandsOptions = {}): UseScopedPluginCommandsResult {
  const t = useTranslations("HostPlugins")
  const locale = useLocale()
  const { activeFolder, activeFolderId } = useActiveFolder()
  const activeTab = useActiveConversationTab()
  const isChatMode = activeFolder?.kind === "chat" || activeTab?.isChat === true
  const folderId = activeFolderId != null && !isChatMode ? activeFolderId : null
  const conversationId =
    activeTab &&
    activeTab.kind === "conversation" &&
    activeTab.conversationId != null
      ? activeTab.conversationId
      : null

  const hostScope = usePluginHostScope()
  const [inFlightCount, setInFlightCount] = useState(0)
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(
    () => new Set()
  )

  const shouldSubscribe = enabled || inFlightCount > 0
  const { data: plugins, transport } = useHostPlugins(shouldSubscribe)

  const commands = useMemo(() => {
    if (!shouldSubscribe || !transport) return []
    return selectPluginCommands(plugins, { folderId, conversationId }, locale)
  }, [conversationId, folderId, locale, plugins, shouldSubscribe, transport])

  const generationRef = useRef(0)
  const mountedRef = useRef(true)
  const liveStateRef = useRef({
    folderId,
    conversationId,
    scopeKey: hostScope.scopeKey,
    transport,
    commands,
    generation: 0,
  })

  // Bump generation whenever workspace, saved conversation, host scope, or
  // Transport object identity changes so any in-flight `callMethod` response is
  // silently dropped.
  useIsomorphicLayoutEffect(() => {
    generationRef.current += 1
    liveStateRef.current = {
      folderId,
      conversationId,
      scopeKey: hostScope.scopeKey,
      transport,
      commands,
      generation: generationRef.current,
    }
    setPendingKeys((prev) => (prev.size > 0 ? new Set() : prev))
  }, [conversationId, folderId, hostScope.scopeKey, transport])

  useIsomorphicLayoutEffect(() => {
    liveStateRef.current.commands = commands
  }, [commands])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (!allowAfterUnmount) {
        generationRef.current += 1
      }
    }
  }, [allowAfterUnmount])

  const scopeLabel = useCallback(
    (scope: PluginCommandScope) => {
      switch (scope) {
        case "global":
          return t("commandScopeGlobal")
        case "workspace":
          return t("commandScopeWorkspace")
        case "session":
          return t("commandScopeSession")
      }
    },
    [t]
  )

  const executeCommand = useCallback(
    (command: ResolvedPluginCommand) => {
      if (command.action.type === "openWorkspacePanel") {
        if (folderId === null || !openPluginPanel) return
        openConversations?.()
        openPluginPanel(
          pluginPanelKey(command.pluginId, command.action.panelId)
        )
        return
      }
      if (command.action.type === "openScreen") {
        openPluginScreen?.({
          pluginId: command.pluginId,
          screenId: command.action.screenId,
        })
        return
      }

      // callMethod
      const activeTransport = transport
      if (!activeTransport || !isCurrentReadyHostTransport(activeTransport)) {
        return
      }
      if (command.scope === "workspace" && folderId === null) return
      if (command.scope === "session" && conversationId === null) return

      const method = command.action.method
      const capturedFolderId = folderId
      const capturedConversationId = conversationId
      const capturedScopeKey = hostScope.scopeKey
      const capturedGeneration = generationRef.current
      let invalidatedOutOfBand = false
      let catalogDirty = false
      let settled = false
      let stopCatalogWatch: (() => void) | undefined

      const stopTransportWatch = subscribeHostTransportChange(() => {
        if (!isCurrentReadyHostTransport(activeTransport)) {
          invalidatedOutOfBand = true
        }
      })
      if (typeof activeTransport.subscribe === "function") {
        void activeTransport
          .subscribe<unknown>("host-plugins://changed", () => {
            catalogDirty = true
          })
          .then(
            (stop) => {
              if (settled) stop()
              else stopCatalogWatch = stop
            },
            () => undefined
          )
      }

      setInFlightCount((count) => count + 1)
      setPendingKeys((prev) => {
        if (prev.has(command.key)) return prev
        const next = new Set(prev)
        next.add(command.key)
        return next
      })

      const isContextStillValid = () => {
        if (invalidatedOutOfBand) return false
        if (!isCurrentReadyHostTransport(activeTransport)) return false
        if (mountedRef.current) {
          const live = liveStateRef.current
          return (
            live.generation === capturedGeneration &&
            live.folderId === capturedFolderId &&
            live.conversationId === capturedConversationId &&
            live.scopeKey === capturedScopeKey &&
            live.transport === activeTransport &&
            live.commands.some(
              (candidate) =>
                candidate.key === command.key &&
                candidate.action.type === "callMethod" &&
                candidate.action.method === method
            )
          )
        }
        if (!allowAfterUnmount) return false
        // Fallback live store validation when a dropdown menu unmounted after selection.
        const wsState =
          typeof useAppWorkspaceStore.getState === "function"
            ? useAppWorkspaceStore.getState()
            : null
        const liveTab = readLiveActiveConversationTab()
        const liveFolder =
          wsState?.activeFolderId != null
            ? (wsState.allFolders?.find(
                (f) => f.id === wsState.activeFolderId
              ) ?? null)
            : null
        const liveIsChat =
          liveFolder?.kind === "chat" || liveTab?.isChat === true
        const liveFolderId =
          wsState?.activeFolderId != null && !liveIsChat
            ? wsState.activeFolderId
            : null
        const liveConversationId =
          liveTab &&
          liveTab.kind === "conversation" &&
          liveTab.conversationId != null
            ? liveTab.conversationId
            : null
        return (
          liveFolderId === capturedFolderId &&
          liveConversationId === capturedConversationId
        )
      }

      const verifyStillValid = async (): Promise<boolean> => {
        if (!isContextStillValid()) return false
        if (!catalogDirty) return true
        try {
          const freshCatalog =
            await activeTransport.call<InstalledPlugin[]>("host_plugins_list")
          if (!isContextStillValid()) return false
          return selectPluginCommands(
            freshCatalog,
            {
              folderId: capturedFolderId,
              conversationId: capturedConversationId,
            },
            locale
          ).some(
            (candidate) =>
              candidate.key === command.key &&
              candidate.action.type === "callMethod" &&
              candidate.action.method === method
          )
        } catch {
          return false
        }
      }

      void activeTransport
        .call<unknown>("host_plugins_call", {
          pluginId: command.pluginId,
          method,
          input: {
            scope: command.scope,
            folderId: capturedFolderId,
            conversationId: capturedConversationId,
          },
        })
        .then(
          async (result) => {
            if (!(await verifyStillValid())) return
            const feedback = formatPluginCommandResult(result)
            if (feedback) {
              toast.success(command.title, { description: feedback })
            } else {
              toast.success(t("commandDone", { title: command.title }))
            }
          },
          async (error: unknown) => {
            if (!(await verifyStillValid())) return
            toast.error(t("commandFailed", { title: command.title }), {
              description: truncateErrorDescription(toErrorMessage(error)),
            })
          }
        )
        .finally(() => {
          settled = true
          stopTransportWatch?.()
          stopCatalogWatch?.()
          if (!mountedRef.current) return
          setInFlightCount((count) => Math.max(0, count - 1))
          if (liveStateRef.current.generation !== capturedGeneration) return
          setPendingKeys((prev) => {
            if (!prev.has(command.key)) return prev
            const next = new Set(prev)
            next.delete(command.key)
            return next
          })
        })
    },
    [
      allowAfterUnmount,
      conversationId,
      folderId,
      hostScope.scopeKey,
      locale,
      openConversations,
      openPluginPanel,
      openPluginScreen,
      t,
      transport,
    ]
  )

  return {
    commands,
    folderId,
    conversationId,
    pendingKeys,
    executeCommand,
    scopeLabel,
  }
}
