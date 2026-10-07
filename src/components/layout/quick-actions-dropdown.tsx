"use client"

import { useCallback, useState } from "react"
import {
  FolderGit2,
  FolderOpenDot,
  GamepadDirectional,
  Globe,
  LayoutTemplate,
  ListTodo,
  Map as MapIcon,
  MonitorCloud,
  PawPrint,
  Rocket,
  Settings,
  Zap,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useAutomationsView } from "@/contexts/automations-view-context"
import { useTasksView } from "@/contexts/tasks-view-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useOptionalWorkspaceActions } from "@/contexts/workspace-context"
import { useRemoteWorkspaceConnections } from "@/hooks/use-remote-workspace-connections"
import { openProjectBootWindow } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { BLANK_PAGE_URL } from "@/lib/browser/browser-url"
import { useBrowserCapabilities } from "@/lib/browser/use-browser-capabilities"
import { openPetWindow } from "@/lib/pet/api"
import { CloneDialog } from "./clone-dialog"
import { RemoteWorkspaceManageDialog } from "./remote-workspace-manage-dialog"
import { WorkspaceFolderDialog } from "./workspace-folder-dialog"

/**
 * The quick-actions launcher pinned to the status bar's leading edge — the
 * window's bottom-left corner.
 *
 * Every entry here already exists somewhere else (the sidebar's nav rows, the
 * folder-list context menu, the top-left chrome, the file tab strip's "+",
 * Settings › Appearance), but those homes are scattered and several of them
 * disappear with the sidebar collapsed — or, for the file strip, whenever no
 * file tab is open. The status bar never unmounts, so this menu is the one
 * always-on path to all of them. Items are grouped by what they act on rather
 * than by where they used to live: workspace (open/clone/boot/remote),
 * navigation (every full-page workbench route), and then the two window-level
 * extras — a browser tab and the desktop pet. Search and the
 * per-folder session actions (manage / import) are the deliberate omissions —
 * search has a permanent button in the window's top-left chrome, and the
 * session actions are folder-scoped, so they live where a folder is: "Manage
 * conversations" in the folder row's context menu, "Import local sessions"
 * there and on the Folders section header. Both go away with the sidebar, but
 * a copy here could only ever act on whatever folder happened to be active,
 * which is not what a folder-scoped action means.
 *
 * Dialogs are rendered as siblings of the menu, not inside it: the menu
 * unmounts its content on close, which would take a nested dialog with it.
 */
export function QuickActionsDropdown() {
  const t = useTranslations("Folder.statusBar.quickActions")
  const tFolderDropdown = useTranslations("Folder.folderNameDropdown")
  const tSidebar = useTranslations("Folder.sidebar")
  const tRemote = useTranslations("RemoteWorkspace")
  const tPet = useTranslations("Pet.manager")

  const { unseenFailures } = useAutomationsView()
  const { attentionCount } = useTasksView()
  const { setRoute, openConversations } = useWorkbenchRoute()
  // The file tab strip carries the other "+" for this; the launcher covers the
  // case that strip cannot — with no file tab open there is no strip at all.
  const openBrowserTab = useOptionalWorkspaceActions()?.openBrowserTab ?? null
  const browserCapabilities = useBrowserCapabilities()

  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [remoteManageOpen, setRemoteManageOpen] = useState(false)

  // Remote connections are only reachable on the desktop runtime (a web client
  // can't spawn another window bound to a different server), so the whole
  // submenu — and the pet entry below it — self-hide elsewhere.
  const {
    desktop,
    connections: remoteConnections,
    refresh: refreshRemote,
    open: handleOpenRemote,
  } = useRemoteWorkspaceConnections()

  const handleProjectBoot = useCallback(() => {
    openProjectBootWindow().catch((err) => {
      console.error("[QuickActionsDropdown] failed to open project boot:", err)
    })
  }, [])

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

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 hover:text-foreground/80"
            title={t("title")}
            aria-label={t("title")}
          >
            {/* Sized with `size-3.5`, NOT `h-3.5 w-3.5`: the Button base
                carries `[&_svg:not([class*='size-'])]:size-4`, and that
                selector's (0,2,1) specificity beats a bare `h-*`/`w-*`
                (0,1,0) — so the `h-3.5 w-3.5` spelling silently rendered this
                glyph at 1rem, the largest icon on a bar whose others are
                0.75–0.875rem. Spelling it `size-` is what opts out of that
                rule. 0.875rem is also exactly the sidebar's nav-icon size, so
                atop the bar's `pl-2` this glyph shares their leading edge, not
                just their rail axis. */}
            <GamepadDirectional aria-hidden="true" className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        {/* `side="top"`: the trigger sits on the window's bottom edge, so the
            menu has to grow upward. `w-auto` releases the shared content
            width-matches-trigger rule — the trigger is a 1.5rem icon. */}
        <DropdownMenuContent
          side="top"
          align="start"
          className="w-auto min-w-60"
        >
          <DropdownMenuLabel>{t("groups.workspace")}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setFolderDialogOpen(true)}>
            <FolderOpenDot />
            {tFolderDropdown("openFolder")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setCloneOpen(true)}>
            <FolderGit2 />
            {tFolderDropdown("cloneRepository")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleProjectBoot}>
            <Rocket />
            {tFolderDropdown("projectBoot")}
          </DropdownMenuItem>
          {desktop && (
            <DropdownMenuSub
              onOpenChange={(open) => open && void refreshRemote()}
            >
              <DropdownMenuSubTrigger>
                <MonitorCloud />
                {tRemote("openRemoteWorkspace")}
              </DropdownMenuSubTrigger>
              {/* The shared sub-content clips (`overflow-hidden`, no max
                  height) where the root content scrolls, so a long connection
                  list would strand its tail — including the manage row —
                  offscreen. Borrow the root's scroll behaviour. */}
              <DropdownMenuSubContent className="max-h-(--radix-dropdown-menu-content-available-height) w-72 overflow-x-hidden overflow-y-auto">
                {remoteConnections.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    {tRemote("empty")}
                  </div>
                ) : (
                  remoteConnections.map((connection) => (
                    <DropdownMenuItem
                      key={connection.id}
                      onSelect={() => handleOpenRemote(connection.id)}
                    >
                      <MonitorCloud />
                      <span className="min-w-0">
                        <span className="block truncate">
                          {connection.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {connection.base_url}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  ))
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setRemoteManageOpen(true)}>
                  <Settings />
                  {tRemote("manage")}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          {/* No Search row: it now has a permanent button in the window's
              top-left chrome (`LeftEdgeChrome`, and `FolderTitleBar` on mobile),
              which is visible without opening anything. This menu exists for
              actions whose only other home disappears with the sidebar. */}

          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t("groups.navigation")}</DropdownMenuLabel>
          {/* Every full-page workbench route the sidebar lists, in the sidebar's
              own order. The badged rows carry the same badges as their sidebar
              twins: failures are destructive-tinted, tasks waiting on the user
              are not. None of them mark the current route the way the sidebar
              rows do — this is a launcher, not a nav list, and every other row
              in it is stateless, so a tinted row here reads as hover/focus
              rather than "you are here". */}
          <DropdownMenuItem onSelect={() => setRoute("automations")}>
            <Zap />
            <span className="min-w-0 flex-1 truncate">
              {tSidebar("automations")}
            </span>
            {unseenFailures > 0 && (
              <span className="inline-flex h-[0.9375rem] min-w-[0.9375rem] shrink-0 items-center justify-center rounded-full bg-destructive/15 px-1 font-mono text-[0.625rem] font-medium leading-none text-destructive">
                {unseenFailures}
              </span>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRoute("tasks")}>
            <ListTodo />
            <span className="min-w-0 flex-1 truncate">{tSidebar("tasks")}</span>
            {attentionCount > 0 && (
              <span className="inline-flex h-[0.9375rem] min-w-[0.9375rem] shrink-0 items-center justify-center rounded-full bg-primary/10 px-1 font-mono text-[0.625rem] font-medium leading-none text-primary">
                {attentionCount}
              </span>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRoute("forge")}>
            <LayoutTemplate />
            {tSidebar("forge")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRoute("canvas")}>
            <MapIcon />
            {tSidebar("canvas")}
          </DropdownMenuItem>

          {desktop && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t("groups.more")}</DropdownMenuLabel>
              {/* Opens the same empty tab the file strip's "+" does. Gated on
                  the backend's own answer rather than on the platform: where
                  there is no built-in browser there is nothing to open. */}
              {(browserCapabilities?.available ?? false) && openBrowserTab && (
                <DropdownMenuItem onSelect={handleOpenBrowser}>
                  <Globe />
                  {t("browserTab")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={handleShowPet}>
                <PawPrint />
                {t("showPet")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

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
