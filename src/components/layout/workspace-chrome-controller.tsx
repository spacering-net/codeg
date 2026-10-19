"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  openSettingsWindow,
  openImportSessionsWindow,
  updateConversationPinned,
} from "@/lib/api"
import {
  useAcpActions,
  useConnectionStore,
} from "@/contexts/acp-connections-context"
import { useZoomLevel, useFloatingBall } from "@/hooks/use-appearance"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useIsActiveChatMode } from "@/hooks/use-is-active-chat-mode"
import { useSidebarContext } from "@/contexts/sidebar-context"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useTerminalContext } from "@/contexts/terminal-context"
import { useSortedAvailableAgents } from "@/hooks/use-sorted-available-agents"
import { useTabActions, useTabStore } from "@/contexts/tab-context"
import { requestCreateTaskFromText } from "@/lib/task-compose-events"
import { requestRenameConversation } from "@/lib/rename-conversation-events"
import {
  requestDeleteConversation,
  requestFocusModeSelector,
  requestTogglePlanFull,
} from "@/lib/floating-ball-session-events"
import {
  nextRecentConversation,
  readRecentSessionDepth,
} from "@/lib/recent-sessions-prefs"
import {
  useWorkspaceActions,
  useWorkspaceFileTabs,
  useWorkspaceView,
  type WorkspacePane,
} from "@/contexts/workspace-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useSearchDialog } from "@/contexts/search-dialog-context"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import {
  isConversationDeleted,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { popClosedTab } from "@/lib/closed-tab-stack"
import {
  matchShortcutEvent,
  numberedTabIndexFromEvent,
  pickNumberedTabId,
} from "@/lib/keyboard-shortcuts"
import {
  CLOSE_SHORTCUT_EVENT,
  closeShortcutOrigin,
  MENU_CLOSE_CHORD,
  tabShortcutTarget,
  workspacePaneOf,
  type CloseShortcutPayload,
} from "@/lib/menu-close-shortcut"
import { getCurrentWindowLabel } from "@/lib/browser/window-label"
import { closeCurrentWindow } from "@/lib/platform"
import { getShellTransport, isDesktop } from "@/lib/transport"
import { SearchCommandDialog } from "@/components/conversations/search-command-dialog"
import { FloatingBall } from "@/components/layout/floating-ball"
import { WorkspaceFolderDialog } from "@/components/layout/workspace-folder-dialog"
import { stepZoom, DEFAULT_ZOOM_LEVEL } from "@/lib/theme-presets"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import type { AgentType } from "@/lib/types"
import type { FloatingBallAction } from "@/lib/floating-ball-gestures"

/**
 * Next entry in a cycling list. With a current agent it picks the following
 * one (wrapping); without one — or when the current agent has since dropped
 * out of the list — it starts from the head. The favorites list re-reads its
 * configured order on every stroke, so cycling there follows what settings
 * shows rather than a stale snapshot.
 */
function nextInCycle(
  current: AgentType | undefined,
  list: AgentType[]
): AgentType {
  if (list.length === 0) return current ?? list[0]
  if (current == null || !list.includes(current)) return list[0]
  const index = list.indexOf(current)
  return list[(index + 1) % list.length]
}

/**
 * Headless owner of the workspace's global keyboard shortcuts and the two
 * dialogs the shortcuts summon (search, remote directory browser). These used
 * to live in the full-width `FolderTitleBar`; with the desktop title bar removed
 * (its buttons relocated into per-column edge clusters), this component keeps
 * the shortcuts + dialogs alive on BOTH desktop and mobile, independent of any
 * visible bar. Renders no visible chrome — only the dialogs.
 */
export function WorkspaceChromeController() {
  const tBall = useTranslations("FloatingBall")
  const { activeFolder } = useActiveFolder()
  const isChatMode = useIsActiveChatMode()
  const { toggle } = useSidebarContext()
  const { toggle: toggleAuxPanel } = useAuxPanelContext()
  const { toggle: toggleTerminal } = useTerminalContext()
  const { openNewConversationTab, openTab, switchTab, closeTab } =
    useTabActions()
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  // cycleRecentSessions picks from the localStorage LRU queue; isAvailable
  // filters to conversations this window can actually open (cross-window
  // pollution guard: the queue is shared, the tabs are per-window).
  const conversations = useAppWorkspaceStore((s) => s.conversations)
  const rawTabs = useTabStore((s) => s.rawTabs)
  // Tab-close/navigation shortcuts used to live in the visible tab strips.
  // Mobile no longer mounts those strips, so this always-mounted controller now
  // owns them too (see the keydown handler below).
  const { mode, activePane, filesMaximized, conversationMaximized } =
    useWorkspaceView()
  const { activeFileTabId, fileTabs } = useWorkspaceFileTabs()
  const {
    closeFileTab,
    closeAllFileTabs,
    switchFileTab,
    openFilePreview,
    openBrowserTab,
    setActivePane,
  } = useWorkspaceActions()
  const { openConversations, setRoute } = useWorkbenchRoute()
  const { shortcuts } = useShortcutSettings()
  const { zoomLevel, setZoomLevel } = useZoomLevel()
  // Stopping a turn is the one floating-ball action with no shortcut: the
  // composer's stop button is the only other entry point, and it belongs to
  // whichever conversation happens to be mounted. The active connection is
  // what the workspace considers "the turn in front of the user".
  const { cancel } = useAcpActions()
  const { getActiveKey, getConnection } = useConnectionStore()
  // Agent cycling (floating ball "next agent" / "favorite agents") needs the
  // same enabled+available list the draft tabs resolve their defaults from.
  const { sortedTypes: sortedAvailableAgents } = useSortedAvailableAgents()
  const { confirmDraftAgent, openChatModeTab } = useTabActions()
  // Session files ("open the session folder") opens the aux panel's file tree;
  // no active folder means there is nothing to reveal (same guard as the
  // toggle-files keyboard shortcut below).
  const auxPanel = useAuxPanelContext()
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const { floatingBallFavoriteAgents: favoriteAgents } = useFloatingBall()
  // Search open-state is shared (see search-dialog-context): the trigger lives
  // in the sidebar, but this always-mounted controller owns the dialog and the
  // ⌘K shortcut so search works even when the sidebar is collapsed.
  const { open: searchOpen, setOpen: setSearchOpen } = useSearchDialog()
  const [browserOpen, setBrowserOpen] = useState(false)

  // One dialog on every platform: it owns directory selection *and* the
  // follow-up step that links other folders into the new workspace, so the
  // native picker can't be a separate path that skips half the flow.
  const handleOpenFolder = useCallback(() => setBrowserOpen(true), [])

  const handleOpenSettings = useCallback(() => {
    openSettingsWindow().catch((err) => {
      console.error("[WorkspaceChromeController] failed to open settings:", err)
    })
  }, [])

  // Close the current tab of the strip that belongs to `pane`. False when
  // there is none, which leaves ⌘W to the OS: it closes the window.
  const closeCurrentTab = useCallback(
    (pane: WorkspacePane): boolean => {
      const target = tabShortcutTarget(
        mode,
        pane,
        filesMaximized,
        conversationMaximized
      )
      if (target.conversation) {
        if (!activeTabId) return false
        closeTab(activeTabId)
        return true
      }
      if (target.files) {
        if (!activeFileTabId) return false
        closeFileTab(activeFileTabId)
        return true
      }
      return false
    },
    [
      activeFileTabId,
      activeTabId,
      closeFileTab,
      closeTab,
      conversationMaximized,
      filesMaximized,
      mode,
    ]
  )

  // ⌘W the macOS app menu caught (see `menu-close-shortcut`): pressed where
  // the listener below cannot hear it — inside an iframe, a browser page, an
  // HTML document view — or heard there and let through. The first kind is
  // routed as if it had been pressed at the element that stands for that
  // spot; the second keeps the meaning ⌘W always had, closing the window.
  const handleMenuClose = useCallback(
    (payload: CloseShortcutPayload) => {
      const closeWindow = () => {
        closeCurrentWindow().catch((err) => {
          console.error("[WorkspaceChromeController] ⌘W close failed:", err)
        })
      }
      // Not this person's close-tab key.
      if (!matchShortcutEvent(MENU_CLOSE_CHORD, shortcuts.close_current_tab)) {
        closeWindow()
        return
      }
      const origin = closeShortcutOrigin(payload.surfaceTabId)
      // A surface this document does not show: nothing here is safe to close.
      if (origin.kind === "unknown") return
      // The listener below heard it and had no tab to close.
      if (origin.kind === "page") {
        closeWindow()
        return
      }
      let pane = activePane
      const pressedIn =
        origin.kind === "element" ? workspacePaneOf(origin.element) : null
      if (pressedIn) {
        pane = pressedIn
        // What a click there would have done (see the pane handlers in the
        // workspace layout): a page gives the workspace no pointer or focus
        // event of its own. It also routes the next ⌘W, which arrives with
        // no view holding the keyboard once this page has closed. Never into
        // a column the other one is maximized over.
        const covered =
          pressedIn === "files" ? conversationMaximized : filesMaximized
        if (mode === "fusion" && !covered) {
          setActivePane(pressedIn)
        }
      }
      if (!closeCurrentTab(pane)) closeWindow()
    },
    [
      activePane,
      closeCurrentTab,
      conversationMaximized,
      filesMaximized,
      mode,
      setActivePane,
      shortcuts.close_current_tab,
    ]
  )
  const handleMenuCloseRef = useRef(handleMenuClose)
  useEffect(() => {
    handleMenuCloseRef.current = handleMenuClose
  }, [handleMenuClose])
  useEffect(() => {
    if (!isDesktop()) return
    let disposed = false
    let unsubscribe: (() => void) | null = null
    // This app's own backend — the menu is local even in a window whose
    // workspace is on a remote server.
    getShellTransport()
      .subscribe<CloseShortcutPayload>(CLOSE_SHORTCUT_EVENT, (payload) => {
        if (payload.window !== getCurrentWindowLabel()) return
        handleMenuCloseRef.current(payload)
      })
      .then((fn) => {
        if (disposed) fn()
        else unsubscribe = fn
      })
      .catch((err) => {
        console.error("[WorkspaceChromeController] ⌘W listener failed:", err)
      })
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [])

  // Reopen the most recently closed tab, at the slot it was closed from. Shared
  // by the shortcut and the floating ball so the two cannot drift.
  const reopenClosedTab = useCallback(() => {
    // Every entry carries the slot it was closed from, and each opener
    // puts the tab back there (clamped to the strip) rather than at the
    // end.
    while (true) {
      const closed = popClosedTab()
      if (!closed) return
      if (closed.kind === "file") {
        void openFilePreview(closed.path, {
          folderId: closed.folderId ?? undefined,
          index: closed.index,
        })
        return
      }
      if (closed.kind === "browser") {
        // Back at the page it was showing; a tab already on that page is
        // activated instead (the usual one-tab-per-URL rule).
        openBrowserTab(closed.url, {
          folderId: closed.folderId ?? undefined,
          index: closed.index,
          profile: closed.profile,
          // Said only when it was remote: otherwise the address decides,
          // as it does when the tab comes back after a restart.
          ...(closed.remote === true ? { remote: true } : {}),
          ...(closed.device ? { device: closed.device } : {}),
        })
        return
      }
      if (closed.conversationId != null) {
        // A deletion seen at any point wins. `applyConversationRemove`
        // purges what is on the stack when it runs, but a tab that was
        // still open then gets recorded afterwards, when the user closes
        // it by hand — that entry can only be caught here.
        if (isConversationDeleted(closed.conversationId)) continue
        openConversations()
        openTab(
          closed.folderId,
          closed.conversationId,
          closed.agentType,
          closed.isPinned,
          closed.title,
          { index: closed.index }
        )
        return
      }
      const folder = useAppWorkspaceStore.getState().getFolder(closed.folderId)
      const workingDir = closed.workingDir ?? folder?.path
      if (!workingDir) continue
      openConversations()
      openNewConversationTab(closed.folderId, workingDir, {
        index: closed.index,
      })
      return
    }
  }, [
    openBrowserTab,
    openConversations,
    openFilePreview,
    openNewConversationTab,
    openTab,
  ])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (matchShortcutEvent(e, shortcuts.toggle_search)) {
        e.preventDefault()
        setSearchOpen((prev) => !prev)
        return
      }
      if (matchShortcutEvent(e, shortcuts.toggle_sidebar)) {
        e.preventDefault()
        toggle()
        return
      }
      if (matchShortcutEvent(e, shortcuts.toggle_terminal)) {
        e.preventDefault()
        toggleTerminal()
        return
      }
      if (matchShortcutEvent(e, shortcuts.toggle_aux_panel)) {
        // The aux panel hosts the Session Details tab, so it's usable in chat
        // mode too; only suppress the toggle when there's nothing to show.
        if (!activeFolder && !isChatMode) return
        e.preventDefault()
        toggleAuxPanel()
        return
      }
      if (matchShortcutEvent(e, shortcuts.new_conversation)) {
        if (!activeFolder) return
        e.preventDefault()
        // Return to the conversation workspace if a route (e.g. Automations) was
        // covering the content region, else the new tab opens unseen.
        openConversations()
        openNewConversationTab(activeFolder.id, activeFolder.path)
        return
      }
      if (matchShortcutEvent(e, shortcuts.open_folder)) {
        e.preventDefault()
        void handleOpenFolder()
        return
      }
      if (matchShortcutEvent(e, shortcuts.open_settings)) {
        e.preventDefault()
        handleOpenSettings()
        return
      }

      // Tab navigation + close. These once lived in the visible tab strips,
      // which mobile no longer mounts; owning them here keeps mod+w / mod+tab /
      // mod+shift+tab working at every width — and, crucially, keeps
      // preventDefault firing so mod+w never falls through to closing the OS
      // window. Routing mirrors the old split: conversation pane vs files pane.
      const { conversation: conversationPaneActive, files: filesPaneActive } =
        tabShortcutTarget(
          mode,
          activePane,
          filesMaximized,
          conversationMaximized
        )

      const isNextTab = matchShortcutEvent(e, shortcuts.next_tab)
      const isPrevTab = matchShortcutEvent(e, shortcuts.prev_tab)
      if (isNextTab || isPrevTab) {
        if (!conversationPaneActive) return
        if (tabs.length < 2 || !activeTabId) return
        const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId)
        if (currentIndex === -1) return
        e.preventDefault()
        const offset = isNextTab ? 1 : -1
        const nextIndex = (currentIndex + offset + tabs.length) % tabs.length
        switchTab(tabs[nextIndex].id)
        return
      }

      const numberedIndex = numberedTabIndexFromEvent(e, shortcuts)
      if (numberedIndex !== null) {
        // A Ctrl chord belongs to a focused terminal — with the defaults it is
        // a control code, and Ctrl+6 is the Ctrl+^ that switches vim's
        // alternate file — so decline there, the same way the zoom listener
        // declines Ctrl+-/Ctrl+= (see appearance-provider). This covers a
        // remapped Ctrl binding too, which is the behaviour we want. Cmd
        // carries no shell meaning, so on macOS the jump keeps working over a
        // focused terminal.
        if (
          e.ctrlKey &&
          !e.metaKey &&
          e.target instanceof Element &&
          e.target.closest('[data-terminal-panel-region="true"]')
        ) {
          return
        }
        if (conversationPaneActive) {
          const tabId = pickNumberedTabId(
            tabs.map((tab) => tab.id),
            numberedIndex
          )
          if (!tabId) return
          e.preventDefault()
          switchTab(tabId)
          return
        }
        if (filesPaneActive) {
          const tabId = pickNumberedTabId(
            fileTabs.map((tab) => tab.id),
            numberedIndex
          )
          if (!tabId) return
          e.preventDefault()
          switchFileTab(tabId)
          return
        }
        return
      }

      if (matchShortcutEvent(e, shortcuts.close_all_file_tabs)) {
        if (!filesPaneActive) return
        e.preventDefault()
        closeAllFileTabs()
        return
      }

      if (matchShortcutEvent(e, shortcuts.close_current_tab)) {
        if (closeCurrentTab(activePane)) e.preventDefault()
        return
      }

      if (matchShortcutEvent(e, shortcuts.reopen_last_closed_tab)) {
        e.preventDefault()
        reopenClosedTab()
        return
      }
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [
    activeFolder,
    handleOpenFolder,
    handleOpenSettings,
    openConversations,
    openNewConversationTab,
    openTab,
    openFilePreview,
    openBrowserTab,
    setSearchOpen,
    shortcuts,
    toggle,
    toggleAuxPanel,
    toggleTerminal,
    isChatMode,
    tabs,
    activeTabId,
    switchTab,
    closeCurrentTab,
    reopenClosedTab,
    mode,
    activePane,
    filesMaximized,
    conversationMaximized,
    fileTabs,
    closeAllFileTabs,
    switchFileTab,
  ])

  const handleFloatingBallAction = useCallback(
    (action: FloatingBallAction) => {
      switch (action) {
        case "newConversation":
          if (!activeFolder) return
          openConversations()
          openNewConversationTab(activeFolder.id, activeFolder.path)
          return
        case "toggleSidebar":
          toggle()
          return
        case "toggleAuxPanel":
          toggleAuxPanel()
          return
        case "toggleSearch":
          setSearchOpen((prev) => !prev)
          return
        case "toggleTerminal":
          toggleTerminal()
          return
        case "nextTab":
        case "prevTab": {
          if (tabs.length < 2 || !activeTabId) return
          const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId)
          if (currentIndex === -1) return
          const offset = action === "nextTab" ? 1 : -1
          const nextIndex = (currentIndex + offset + tabs.length) % tabs.length
          switchTab(tabs[nextIndex].id)
          return
        }
        case "reopenClosedTab":
          reopenClosedTab()
          return
        case "openFolder":
          void handleOpenFolder()
          return
        case "zoomIn":
          setZoomLevel(stepZoom(zoomLevel, 1))
          return
        case "zoomOut":
          setZoomLevel(stepZoom(zoomLevel, -1))
          return
        case "zoomReset":
          setZoomLevel(DEFAULT_ZOOM_LEVEL)
          return
        case "stopGenerating": {
          const key = getActiveKey()
          if (!key) return
          void cancel(key).catch((err) => {
            console.error("[WorkspaceChromeController] stop failed:", err)
          })
          return
        }
        case "openSettings":
          handleOpenSettings()
          return
        case "openTodos":
          setRoute("tasks")
          return
        case "openTodosNew":
          // Park the draft before switching — the Tasks page consumes it on
          // mount, and on the live event when the route is already active.
          requestCreateTaskFromText({
            text: "",
            folderId: activeFolder?.id ?? null,
          })
          setRoute("tasks")
          return
        case "openAutomations":
          setRoute("automations")
          return
        case "openCanvas":
          setRoute("canvas")
          return
        case "openAgents":
          void openSettingsWindow("agents").catch((err) => {
            console.error("[WorkspaceChromeController] agents settings:", err)
          })
          return
        case "openSystemAdmin":
          void openSettingsWindow("system").catch((err) => {
            console.error("[WorkspaceChromeController] system settings:", err)
          })
          return
        case "renameConversation": {
          const id = activeTab?.conversationId
          if (id == null) {
            toast.info(tBall("toasts.renameNeedsSavedSession"))
            return
          }
          requestRenameConversation({ conversationId: id })
          return
        }
        case "openSessionFolder":
          if (!activeFolder) {
            toast.info(tBall("toasts.sessionFolderNeedsWorkspace"))
            return
          }
          auxPanel.openTab("file_tree")
          return
        case "openSessionDetails":
          auxPanel.openTab("session_details")
          return
        case "openChanges":
          if (!activeFolder) {
            toast.info(tBall("toasts.sessionFolderNeedsWorkspace"))
            return
          }
          auxPanel.openTab("changes")
          return
        case "openGitLog":
          if (!activeFolder) {
            toast.info(tBall("toasts.sessionFolderNeedsWorkspace"))
            return
          }
          auxPanel.openTab("git_log")
          return
        case "cycleAgent":
        case "cycleFavoriteAgent": {
          const list =
            action === "cycleAgent"
              ? sortedAvailableAgents
              : sortedAvailableAgents.filter((a) => favoriteAgents.includes(a))
          if (list.length <= 1) {
            toast.info(tBall("toasts.cycleNeedsMoreAgents"))
            return
          }
          const tab = activeTab
          // The switch retargets the draft's ACP connection via
          // useConnectionLifecycle; a persisted conversation's agent is fixed,
          // so open a fresh draft pinned to the next agent instead.
          if (!tab || tab.conversationId != null) {
            const next = nextInCycle(tab?.agentType, list)
            if (activeFolder) {
              openNewConversationTab(activeFolder.id, activeFolder.path, {
                forceAgent: next,
              })
            } else {
              openChatModeTab({ forceAgent: next })
            }
            return
          }
          const next = nextInCycle(tab.agentType, list)
          confirmDraftAgent(tab.id, next)
          return
        }
        case "openBallBindings":
          void openSettingsWindow("appearance").catch((err) => {
            console.error(
              "[WorkspaceChromeController] appearance settings:",
              err
            )
          })
          return
        case "openCollaboration":
          void openSettingsWindow("collaboration").catch((err) => {
            console.error(
              "[WorkspaceChromeController] collaboration settings:",
              err
            )
          })
          return
        case "openImportSessions":
          void openImportSessionsWindow().catch((err) => {
            console.error("[WorkspaceChromeController] import sessions:", err)
          })
          return
        case "deleteCurrentConversation":
          requestDeleteConversation(activeTab?.conversationId ?? null)
          return
        case "togglePinConversation": {
          const conv = conversations.find(
            (c) => c.id === activeTab?.conversationId
          )
          if (!conv) {
            toast.info(tBall("toasts.renameNeedsSavedSession"))
            return
          }
          void updateConversationPinned(conv.id, conv.pinned_at == null)
            .then(() => toast.info(tBall("toasts.pinToggled")))
            .catch((err) => {
              console.error("[WorkspaceChromeController] pin toggle:", err)
            })
          return
        }
        case "focusModeSelector":
          requestFocusModeSelector(activeTab?.conversationId ?? null)
          return
        case "togglePlanFullAccess":
          requestTogglePlanFull(activeTab?.conversationId ?? null)
          return
        case "cycleRunningSessions": {
          // "Running" = this window's connections currently generating. The
          // connection store is per-window, so a session streaming in another
          // window is invisible here — the toast phrasing accounts for that.
          const runningTabs = rawTabs.filter(
            (tab) => getConnection(tab.id)?.status === "prompting"
          )
          if (runningTabs.length === 0) {
            toast.info(tBall("toasts.noRunningSession"))
            return
          }
          if (runningTabs.length <= 1) {
            toast.info(tBall("toasts.noOtherRunning"))
            return
          }
          const currentIndex = runningTabs.findIndex(
            (tab) => tab.id === activeTabId
          )
          // Active tab not running → jump to the first running tab; otherwise
          // step forward through the running set in tab order.
          const nextIndex = (currentIndex + 1) % runningTabs.length
          switchTab(runningTabs[nextIndex].id)
          return
        }
        case "cycleRecentSessions": {
          if (!activeFolder) return
          const target = nextRecentConversation(
            activeTab?.conversationId ?? null,
            readRecentSessionDepth(),
            (id) =>
              conversations.some((c) => c.id === id) &&
              rawTabs.some((tab) => tab.conversationId === id)
          )
          if (target == null) {
            toast.info(tBall("toasts.noOtherRecent"))
            return
          }
          const tab = rawTabs.find((t) => t.conversationId === target)
          if (tab) switchTab(tab.id)
          return
        }
        case "panel":
          return
      }
    },
    [
      activeFolder,
      activeTab,
      activeTabId,
      auxPanel,
      cancel,
      confirmDraftAgent,
      conversations,
      favoriteAgents,
      getActiveKey,
      getConnection,
      handleOpenFolder,
      handleOpenSettings,
      openChatModeTab,
      openConversations,
      openNewConversationTab,
      rawTabs,
      reopenClosedTab,
      setSearchOpen,
      setRoute,
      setZoomLevel,
      sortedAvailableAgents,
      switchTab,
      tBall,
      tabs,
      toggle,
      toggleAuxPanel,
      toggleTerminal,
      zoomLevel,
    ]
  )

  return (
    <>
      <SearchCommandDialog open={searchOpen} onOpenChange={setSearchOpen} />
      <WorkspaceFolderDialog open={browserOpen} onOpenChange={setBrowserOpen} />
      <FloatingBall onAction={handleFloatingBallAction} />
    </>
  )
}
