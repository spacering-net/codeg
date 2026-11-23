"use client"

/**
 * The quick actions: the app's always-on launcher, inside the one menu at the
 * status bar's leading edge (`status-bar-srn.tsx`), between the SRN
 * account's head and its sign-in row.
 *
 * Every entry here already exists somewhere else (the sidebar's nav rows, the
 * folder-list context menu, the top-left chrome, the file tab strip's "+",
 * Settings › Appearance, the tray menu), but those homes are scattered and
 * several of them disappear with the sidebar collapsed — or, for the file
 * strip, whenever no file tab is open. The status bar never unmounts, so this
 * menu is the one always-on path to all of them.
 *
 * No group titles: the full-page workbench routes come first, as rows; then,
 * after a divider, the launch group — what opens something to work in. The
 * project actions (open/clone/boot) fold into "Open project", the remote
 * workspaces are a submenu of their own beside it (the desktop's only), the
 * local workspace is one row (in a remote workspace window only: it is about
 * which window, not which project), and the two window-level extras (a
 * browser tab, the desktop pet) are rows of their own after them. Search and
 * the per-folder session actions (manage / import) are the deliberate omissions —
 * search has a permanent button in the window's top-left chrome, and the
 * session actions are folder-scoped, so they live where a folder is: "Manage
 * conversations" in the folder row's context menu, "Import local sessions"
 * there and on the Folders section header. Both go away with the sidebar, but
 * a copy here could only ever act on whatever folder happened to be active,
 * which is not what a folder-scoped action means.
 *
 * The rows are the whole menu's (`status-bar-menu-rows.tsx`): the account's
 * are drawn with them too, on the grid its head sets.
 *
 * In three parts, because the menu is not this file's: {@link useQuickActions}
 * holds the state and the handlers, {@link QuickActionsItems} draws the rows
 * inside the account menu's content, and {@link QuickActionsDialogs} renders
 * the dialogs as siblings of that menu, not inside it: the menu unmounts its
 * content on close — submenus included — which would take a nested dialog
 * with it.
 */

import { useCallback, useState } from "react"
import {
  DraftingCompass,
  FolderGit2,
  FolderOpen,
  FolderOpenDot,
  Globe,
  LayoutTemplate,
  ListTodo,
  Map as MapIcon,
  Monitor,
  MonitorCloud,
  PawPrint,
  Rocket,
  Settings,
  Zap,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { HarnessUpdatesBadge } from "@/components/harness/harness-updates-badge"
import { LabelWithHint } from "@/components/layout/label-with-hint"
import {
  MENU_TEXT,
  MenuRow,
  MenuSub,
} from "@/components/layout/status-bar-menu-rows"
import { DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { useAutomationsView } from "@/contexts/automations-view-context"
import { useHarnessView } from "@/contexts/harness-view-context"
import { useTasksView } from "@/contexts/tasks-view-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useOptionalWorkspaceActions } from "@/contexts/workspace-context"
import { useRemoteWorkspaceConnections } from "@/hooks/use-remote-workspace-connections"
import { openProjectBootWindow } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { BLANK_PAGE_URL } from "@/lib/browser/browser-url"
import { useBrowserCapabilities } from "@/lib/browser/use-browser-capabilities"
import { openPetWindow } from "@/lib/pet/api"
import { isRemoteDesktopWindow } from "@/lib/platform"
import { openLocalWorkspace } from "@/lib/remote-workspace"
import { cn } from "@/lib/utils"
import { CloneDialog } from "./clone-dialog"
import { RemoteWorkspaceManageDialog } from "./remote-workspace-manage-dialog"
import { WorkspaceFolderDialog } from "./workspace-folder-dialog"

/** A count at a row's end: the sidebar's chip, in the tint of what it
 *  counts. */
const COUNT_CLASS =
  "inline-flex h-[0.9375rem] min-w-[0.9375rem] shrink-0 items-center justify-center rounded-full px-1 font-mono text-[0.625rem] leading-none font-medium"

export function useQuickActions() {
  const tRemote = useTranslations("RemoteWorkspace")
  const tPet = useTranslations("Pet.manager")

  const { unseenFailures } = useAutomationsView()
  const { attentionCount } = useTasksView()
  const { updatesCount: harnessUpdates } = useHarnessView()
  const { setRoute, openConversations } = useWorkbenchRoute()
  // The file tab strip carries the other "+" for this; the launcher covers the
  // case that strip cannot — with no file tab open there is no strip at all.
  const openBrowserTab = useOptionalWorkspaceActions()?.openBrowserTab ?? null
  const browserCapabilities = useBrowserCapabilities()

  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [remoteManageOpen, setRemoteManageOpen] = useState(false)

  // Remote connections are only reachable on the desktop runtime (a web client
  // can't spawn another window bound to a different server), so their whole
  // submenu — and the window-level extras, whose pet is the desktop's too —
  // self-hide elsewhere.
  const {
    desktop,
    connections: remoteConnections,
    refresh: refreshRemote,
    open: handleOpenRemote,
  } = useRemoteWorkspaceConnections()
  // Only a remote workspace window has a local workspace to go back to; in the
  // local one the row would just focus the window it was picked from.
  const remoteWindow = isRemoteDesktopWindow()

  const handleProjectBoot = useCallback(() => {
    openProjectBootWindow().catch((err) => {
      console.error("[QuickActions] failed to open project boot:", err)
    })
  }, [])

  const handleOpenLocal = useCallback(() => {
    openLocalWorkspace().catch((err) => {
      toast.error(tRemote("openLocalFailed"), {
        description: toErrorMessage(err),
      })
    })
  }, [tRemote])

  // The file column — where browser tabs live — only exists on the
  // conversations route; every other workbench route is rendered in its place.
  // So return there first, or the new tab would open somewhere off screen.
  const handleOpenBrowser = useCallback(() => {
    if (!openBrowserTab) return
    openConversations()
    openBrowserTab(BLANK_PAGE_URL)
  }, [openBrowserTab, openConversations])

  // Summoning fails when no pet has been made active yet (the backend refuses
  // rather than opening an empty window), so surface that instead of a silent
  // no-op — the fix lives in Settings › Appearance › Pets.
  const handleShowPet = useCallback(() => {
    openPetWindow().catch((err) => {
      toast.error(tPet("errors.summonFailed"), {
        description: toErrorMessage(err),
      })
    })
  }, [tPet])

  return {
    unseenFailures,
    attentionCount,
    harnessUpdates,
    setRoute,
    openBrowserTab,
    browserAvailable: browserCapabilities?.available ?? false,
    desktop,
    remoteConnections,
    refreshRemote,
    handleOpenRemote,
    remoteWindow,
    handleProjectBoot,
    handleOpenLocal,
    handleOpenBrowser,
    handleShowPet,
    folderDialogOpen,
    setFolderDialogOpen,
    cloneOpen,
    setCloneOpen,
    remoteManageOpen,
    setRemoteManageOpen,
  }
}

export type QuickActions = ReturnType<typeof useQuickActions>

/** The rows, as items of the menu they are put in: the routes, then the
 *  launch group. */
export function QuickActionsItems({ actions }: { actions: QuickActions }) {
  const t = useTranslations("Folder.statusBar.quickActions")
  const tFolderDropdown = useTranslations("Folder.folderNameDropdown")
  const tSidebar = useTranslations("Folder.sidebar")
  const tRemote = useTranslations("RemoteWorkspace")
  const {
    unseenFailures,
    attentionCount,
    harnessUpdates,
    setRoute,
    openBrowserTab,
    browserAvailable,
    desktop,
    remoteConnections,
    refreshRemote,
    handleOpenRemote,
    remoteWindow,
    handleProjectBoot,
    handleOpenLocal,
    handleOpenBrowser,
    handleShowPet,
    setFolderDialogOpen,
    setCloneOpen,
    setRemoteManageOpen,
  } = actions
  const browserRow = browserAvailable && openBrowserTab !== null

  return (
    <>
      {/* Every full-page workbench route the sidebar lists, in the sidebar's
          own order. The badged rows carry the same badges as their sidebar
          twins: failures are destructive-tinted, tasks waiting on the user
          are not. None of them mark the current route the way the sidebar
          rows do — this is a launcher, not a nav list, and every other row
          in it is stateless, so a tinted row here reads as hover/focus
          rather than "you are here". */}
      <MenuRow
        icon={<Zap />}
        label={tSidebar("automations")}
        trailing={
          unseenFailures > 0 && (
            <span
              className={cn(COUNT_CLASS, "bg-destructive/15 text-destructive")}
            >
              {unseenFailures}
            </span>
          )
        }
        onSelect={() => setRoute("automations")}
      />
      <MenuRow
        icon={<ListTodo />}
        label={tSidebar("tasks")}
        trailing={
          attentionCount > 0 && (
            <span className={cn(COUNT_CLASS, "bg-primary/10 text-primary")}>
              {attentionCount}
            </span>
          )
        }
        onSelect={() => setRoute("tasks")}
      />
      <MenuRow
        icon={<LayoutTemplate />}
        label={tSidebar("forge")}
        onSelect={() => setRoute("forge")}
      />
      <MenuRow
        icon={<MapIcon />}
        label={tSidebar("canvas")}
        onSelect={() => setRoute("canvas")}
      />
      <MenuRow
        icon={<DraftingCompass />}
        label={
          <LabelWithHint
            label={tSidebar("harness")}
            hint={tSidebar("harnessHint")}
          />
        }
        trailing={
          harnessUpdates > 0 && <HarnessUpdatesBadge count={harnessUpdates} />
        }
        onSelect={() => setRoute("harness")}
      />

      {/* No Search row: it now has a permanent button in the window's
          top-left chrome (`LeftEdgeChrome`, and `FolderTitleBar` on mobile),
          which is visible without opening anything. This menu exists for
          actions whose only other home disappears with the sidebar. */}

      <DropdownMenuSeparator />

      {/* The launch group: what opens something to work in. */}
      <MenuSub icon={<FolderOpen />} label={t("openProject")}>
        <MenuRow
          icon={<FolderOpenDot />}
          label={tFolderDropdown("openFolder")}
          onSelect={() => setFolderDialogOpen(true)}
        />
        <MenuRow
          icon={<FolderGit2 />}
          label={tFolderDropdown("cloneRepository")}
          onSelect={() => setCloneOpen(true)}
        />
        <MenuRow
          icon={<Rocket />}
          label={tFolderDropdown("projectBoot")}
          onSelect={handleProjectBoot}
        />
      </MenuSub>
      {desktop && (
        <MenuSub
          icon={<MonitorCloud />}
          label={tRemote("openRemoteWorkspace")}
          // Read when it opens, not with the menu: the list is this
          // submenu's alone.
          onOpenChange={(open) => open && void refreshRemote()}
          contentClassName="min-w-60"
        >
          {remoteConnections.length === 0 ? (
            <div
              className={cn("py-2 ps-5 pe-3 text-muted-foreground", MENU_TEXT)}
            >
              {tRemote("empty")}
            </div>
          ) : (
            remoteConnections.map((connection) => (
              <MenuRow
                key={connection.id}
                icon={<MonitorCloud />}
                label={
                  <>
                    <span className="block truncate">{connection.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {connection.base_url}
                    </span>
                  </>
                }
                onSelect={() => handleOpenRemote(connection.id)}
              />
            ))
          )}
          <DropdownMenuSeparator />
          <MenuRow
            icon={<Settings />}
            label={tRemote("manage")}
            onSelect={() => setRemoteManageOpen(true)}
          />
        </MenuSub>
      )}
      {remoteWindow && (
        <MenuRow
          icon={<Monitor />}
          label={tRemote("openLocalWorkspace")}
          onSelect={handleOpenLocal}
        />
      )}

      {/* The window-level extras, as rows of their own. Desktop only: the
          pet is the desktop's, and the browser row is gated on the backend's
          own answer rather than on the platform — where there is no built-in
          browser there is nothing to open. */}
      {desktop && browserRow && (
        <MenuRow
          icon={<Globe />}
          label={t("browserTab")}
          onSelect={handleOpenBrowser}
        />
      )}
      {desktop && (
        <MenuRow
          icon={<PawPrint />}
          label={t("showPet")}
          onSelect={handleShowPet}
        />
      )}
    </>
  )
}

/** The dialogs the rows open, kept outside the menu that closes on them. */
export function QuickActionsDialogs({ actions }: { actions: QuickActions }) {
  const {
    desktop,
    refreshRemote,
    folderDialogOpen,
    setFolderDialogOpen,
    cloneOpen,
    setCloneOpen,
    remoteManageOpen,
    setRemoteManageOpen,
  } = actions
  return (
    <>
      <WorkspaceFolderDialog
        open={folderDialogOpen}
        onOpenChange={setFolderDialogOpen}
      />
      <CloneDialog open={cloneOpen} onOpenChange={setCloneOpen} />
      {/* Mounted only where its submenu exists, so web builds don't carry a
          dialog nothing can ever open. */}
      {desktop && (
        <RemoteWorkspaceManageDialog
          open={remoteManageOpen}
          onOpenChange={setRemoteManageOpen}
          onChanged={refreshRemote}
        />
      )}
    </>
  )
}
