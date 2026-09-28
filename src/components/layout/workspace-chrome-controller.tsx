"use client"

import { useCallback, useEffect, useState } from "react"
import { openSettingsWindow } from "@/lib/api"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useIsActiveChatMode } from "@/hooks/use-is-active-chat-mode"
import { useSidebarContext } from "@/contexts/sidebar-context"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useTerminalContext } from "@/contexts/terminal-context"
import { useTabActions, useTabStore } from "@/contexts/tab-context"
import {
  useWorkspaceActions,
  useWorkspaceFileTabs,
  useWorkspaceView,
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
import { SearchCommandDialog } from "@/components/conversations/search-command-dialog"
import { WorkspaceFolderDialog } from "@/components/layout/workspace-folder-dialog"

/**
 * Headless owner of the workspace's global keyboard shortcuts and the two
 * dialogs the shortcuts summon (search, remote directory browser). These used
 * to live in the full-width `FolderTitleBar`; with the desktop title bar removed
 * (its buttons relocated into per-column edge clusters), this component keeps
 * the shortcuts + dialogs alive on BOTH desktop and mobile, independent of any
 * visible bar. Renders no visible chrome — only the dialogs.
 */
export function WorkspaceChromeController() {
  const { activeFolder } = useActiveFolder()
  const isChatMode = useIsActiveChatMode()
  const { toggle } = useSidebarContext()
  const { toggle: toggleAuxPanel } = useAuxPanelContext()
  const { toggle: toggleTerminal } = useTerminalContext()
  const { openNewConversationTab, openTab, switchTab, closeTab } =
    useTabActions()
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  // Tab-close/navigation shortcuts used to live in the visible tab strips.
  // Mobile no longer mounts those strips, so this always-mounted controller now
  // owns them too (see the keydown handler below).
  const { mode, activePane, filesMaximized } = useWorkspaceView()
  const { activeFileTabId, fileTabs } = useWorkspaceFileTabs()
  const {
    closeFileTab,
    closeAllFileTabs,
    switchFileTab,
    openFilePreview,
    openBrowserTab,
  } = useWorkspaceActions()
  const { openConversations } = useWorkbenchRoute()
  const { shortcuts } = useShortcutSettings()
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
      const conversationPaneActive =
        mode === "conversation" ||
        (mode === "fusion" && activePane === "conversation" && !filesMaximized)
      const filesPaneActive =
        mode === "fusion" && (activePane === "files" || filesMaximized)

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
        if (conversationPaneActive) {
          if (!activeTabId) return
          e.preventDefault()
          closeTab(activeTabId)
        } else if (filesPaneActive) {
          if (!activeFileTabId) return
          e.preventDefault()
          closeFileTab(activeFileTabId)
        }
        return
      }

      if (matchShortcutEvent(e, shortcuts.reopen_last_closed_tab)) {
        e.preventDefault()
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
          const folder = useAppWorkspaceStore
            .getState()
            .getFolder(closed.folderId)
          const workingDir = closed.workingDir ?? folder?.path
          if (!workingDir) continue
          openConversations()
          openNewConversationTab(closed.folderId, workingDir, {
            index: closed.index,
          })
          return
        }
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
    closeTab,
    mode,
    activePane,
    filesMaximized,
    fileTabs,
    activeFileTabId,
    closeFileTab,
    closeAllFileTabs,
    switchFileTab,
  ])

  return (
    <>
      <SearchCommandDialog open={searchOpen} onOpenChange={setSearchOpen} />
      <WorkspaceFolderDialog open={browserOpen} onOpenChange={setBrowserOpen} />
    </>
  )
}
