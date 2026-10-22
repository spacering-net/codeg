"use client"

import { useCallback, useEffect, useState } from "react"
import {
  CircleDot,
  Folder,
  FolderPen,
  GitCommit,
  GitPullRequestArrow,
  ListTodo,
  ReceiptText,
  Zap,
  type LucideIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import {
  useAuxPanelContext,
  type AuxPanelTab,
} from "@/contexts/aux-panel-context"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useActiveProjectFolderId } from "@/hooks/use-active-project-folder"
import { useIsActiveChatMode } from "@/hooks/use-is-active-chat-mode"
import { useIsMobile } from "@/hooks/use-mobile"
import { usePlatform } from "@/hooks/use-platform"
import { useTabReselect } from "@/hooks/use-tab-reselect"
import { useZoomLevel } from "@/hooks/use-appearance"
import { useAuxTabOrder, type AuxTabOrder } from "@/lib/aux-panel-tab-order"
import { useFolderForgeProvider } from "@/lib/forge-provider-cache"
import { isDesktop } from "@/lib/platform"
import { rightChromeReserve } from "@/lib/window-chrome"
import { cn } from "@/lib/utils"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { AuxPanelTabRail } from "./aux-panel-tab-rail"
import { ChromeReserve } from "./chrome-reserve"
import { SessionDetailsTab } from "./aux-panel-session-details-tab"
import { FileTreeTab } from "./aux-panel-file-tree-tab"
import { GitChangesTab } from "./aux-panel-git-changes-tab"
import { GitLogTab } from "./aux-panel-git-log-tab"
import { AutomationsAuxTab } from "./aux-panel-automations-tab"
import { TasksAuxTab } from "./aux-panel-tasks-tab"
import { ForgeAuxTab } from "./aux-panel-forge-tab"

const LAZY_TABS: AuxPanelTab[] = [
  "file_tree",
  "changes",
  "git_log",
  "automations",
  "tasks",
  "issues",
  "pull_requests",
]

// Icon for every aux tab. The desktop rail and the mobile tab row both map the
// stored order (see `aux-panel-tab-order.ts`) over these, so the two surfaces
// can never drift.
// The work tabs wear the left sidebar's own glyphs for the same pages
// (automations, to-dos) and the repository panel's state glyphs for an open
// issue and an open pull request.
const TAB_ICONS: Record<AuxPanelTab, LucideIcon> = {
  session_details: ReceiptText,
  file_tree: Folder,
  changes: FolderPen,
  git_log: GitCommit,
  automations: Zap,
  tasks: ListTodo,
  issues: CircleDot,
  pull_requests: GitPullRequestArrow,
}
// The three folder-content tabs share one label namespace (Folder.auxPanel.tabs);
// session details resolves from its own (Folder.sessionDetails.menuLabel), and
// the work tabs are named exactly as the pages they mirror. The value type is
// the literal key union so next-intl's typed `t()` accepts it.
const FOLDER_TAB_LABEL_KEY: Record<
  "file_tree" | "changes" | "git_log",
  "files" | "changes" | "commits"
> = {
  file_tree: "files",
  changes: "changes",
  git_log: "commits",
}

/** What the tab switchers list while the folder tabs are hidden. */
const SESSION_DETAILS_ONLY: AuxTabOrder = ["session_details"]

/**
 * Decide which aux-panel tabs are available and which to actually show.
 *
 * The folder-scoped tabs (files/changes/commits, and the project's automations,
 * tasks, issues and pull requests) only make sense with a real folder
 * workspace open, so chat sessions and the folderless state collapse to just
 * the Session Details tab. `effectiveTab` keeps the rendered selection
 * valid even when the stored `activeTab` is a now-hidden folder tab, avoiding a
 * one-frame flash before the reconciling effect corrects the stored value.
 */
export function resolveAuxTabView(
  activeTab: AuxPanelTab,
  activeFolderId: number | null,
  isChatMode: boolean
): { showFolderTabs: boolean; effectiveTab: AuxPanelTab } {
  const showFolderTabs = activeFolderId != null && !isChatMode
  return {
    showFolderTabs,
    effectiveTab: showFolderTabs ? activeTab : "session_details",
  }
}

export function AuxPanel() {
  const t = useTranslations("Folder.auxPanel.tabs")
  const tDetails = useTranslations("Folder.sessionDetails")
  const tAutomations = useTranslations("Automations")
  const tTasks = useTranslations("Tasks")
  const tForge = useTranslations("Forge")
  const { isOpen, activeTab, setActiveTab, setOpen } = useAuxPanelContext()
  const { activeFolderId } = useActiveFolder()
  const isChatMode = useIsActiveChatMode()
  const isMobile = useIsMobile()
  const { isWindows, isLinux } = usePlatform()
  const { zoomLevel } = useZoomLevel()
  const tabOrder = useAuxTabOrder()
  const [mountedTabs, setMountedTabs] = useState<Set<AuxPanelTab>>(
    () => new Set(LAZY_TABS.filter((tab) => tab === activeTab))
  )

  const { showFolderTabs, effectiveTab } = resolveAuxTabView(
    activeTab,
    activeFolderId,
    isChatMode
  )
  // GitLab calls them merge requests, GitHub and Gitea pull requests: the tab
  // is named for the forge the project's remote is on, as the repository
  // panel's own switcher is. Looked up only while the tab is on the rail.
  const projectFolderId = useActiveProjectFolderId()
  const forgeProvider = useFolderForgeProvider(
    isOpen && showFolderTabs ? projectFolderId : null
  )

  // Ensure the shown tab is mounted (covers both user clicks and programmatic changes)
  if (
    isOpen &&
    LAZY_TABS.includes(effectiveTab) &&
    !mountedTabs.has(effectiveTab)
  ) {
    setMountedTabs((prev) => new Set(prev).add(effectiveTab))
  }

  // Reconcile the stored selection when folder tabs disappear (e.g. entering a
  // chat session), so other consumers of `activeTab` stay in sync with what's
  // shown. Done in an effect — never a render-time setState on the provider.
  useEffect(() => {
    if (!showFolderTabs && activeTab !== "session_details") {
      setActiveTab("session_details")
    }
  }, [showFolderTabs, activeTab, setActiveTab])

  const handleTabValueChange = useCallback(
    (value: string) => {
      setActiveTab(value as AuxPanelTab)
    },
    [setActiveTab]
  )

  // Clicking the tab that is already showing hides the panel, on the desktop
  // rail and in the mobile drawer alike.
  const closePanel = useCallback(() => setOpen(false), [setOpen])

  // The window-chrome overlay (terminal / aux / settings, plus the native
  // caption buttons on desktop Windows/Linux) floats over the top strip's
  // RIGHT end. The strip keeps exactly that much blank, so the title truncates
  // before it can run underneath.
  const winLinuxControls = isDesktop() && (isWindows || isLinux)
  const rightReserve = rightChromeReserve(winLinuxControls, zoomLevel)

  const tabLabel = useCallback(
    (tab: AuxPanelTab) => {
      switch (tab) {
        case "session_details":
          return tDetails("menuLabel")
        case "automations":
          return tAutomations("title")
        case "tasks":
          return tTasks("title")
        case "issues":
          return tForge("tabIssues")
        case "pull_requests":
          return tForge(forgeProvider === "gitlab" ? "tabMrs" : "tabPrs")
        default:
          return t(FOLDER_TAB_LABEL_KEY[tab])
      }
    },
    [t, tDetails, tAutomations, tTasks, tForge, forgeProvider]
  )

  const shownTabs = showFolderTabs ? tabOrder : SESSION_DETAILS_ONLY

  if (!isOpen) return null

  const panels = (
    <>
      <TabsContent
        value="session_details"
        forceMount
        className="mt-0 flex-1 min-h-0 overflow-hidden"
      >
        <SessionDetailsTab />
      </TabsContent>
      <TabsContent
        value="file_tree"
        forceMount
        className="mt-0 flex-1 min-h-0 overflow-hidden"
      >
        {mountedTabs.has("file_tree") ? <FileTreeTab /> : null}
      </TabsContent>
      <TabsContent
        value="changes"
        forceMount
        className="mt-0 flex-1 min-h-0 overflow-hidden"
      >
        {mountedTabs.has("changes") ? <GitChangesTab /> : null}
      </TabsContent>
      <TabsContent
        value="git_log"
        forceMount
        className="mt-0 flex-1 min-h-0 overflow-hidden"
      >
        {mountedTabs.has("git_log") ? <GitLogTab /> : null}
      </TabsContent>
      <TabsContent
        value="automations"
        forceMount
        className="mt-0 flex-1 min-h-0 overflow-hidden"
      >
        {mountedTabs.has("automations") ? <AutomationsAuxTab /> : null}
      </TabsContent>
      <TabsContent
        value="tasks"
        forceMount
        className="mt-0 flex-1 min-h-0 overflow-hidden"
      >
        {mountedTabs.has("tasks") ? <TasksAuxTab /> : null}
      </TabsContent>
      <TabsContent
        value="issues"
        forceMount
        className="mt-0 flex-1 min-h-0 overflow-hidden"
      >
        {mountedTabs.has("issues") ? (
          <ForgeAuxTab auxTab="issues" forgeTab="issues" />
        ) : null}
      </TabsContent>
      <TabsContent
        value="pull_requests"
        forceMount
        className="mt-0 flex-1 min-h-0 overflow-hidden"
      >
        {mountedTabs.has("pull_requests") ? (
          <ForgeAuxTab auxTab="pull_requests" forgeTab="prs" />
        ) : null}
      </TabsContent>
    </>
  )

  return (
    // Desktop: background matches the middle workspace (bg-background), not the
    // darker sidebar shade, so the right column reads as one surface with it.
    // Mobile (Drawer) is unchanged — keep the sidebar shade.
    <aside
      className={cn(
        "group/aux-panel flex h-full min-h-0 flex-col overflow-hidden text-sidebar-foreground select-none",
        // 桌面态背景交给 workspace 的 ws-surface wrapper，让背景图透出（未启用时
        // wrapper 等价 bg-background，零回归）；移动态是抽屉，保持不透明。
        isMobile ? "bg-sidebar" : ""
      )}
    >
      <Tabs
        value={effectiveTab}
        onValueChange={handleTabValueChange}
        // The desktop switcher is a vertical rail, so ↑/↓ walk it; the mobile
        // row stays horizontal.
        orientation={isMobile ? "horizontal" : "vertical"}
        className="flex h-full min-h-0 flex-col gap-0"
      >
        {isMobile ? (
          <>
            {/* Mobile (Drawer): full-width underline tabs + a divider, in the
                stored order. Not draggable — a sideways drag in the row would
                fight the drawer's own swipe-to-close. */}
            <TabsList
              variant="line"
              className="h-10 w-full shrink-0 justify-start border-b border-border ws-chrome-border px-3 group-data-horizontal/tabs:h-10"
            >
              {shownTabs.map((tab) => (
                <MobileAuxTabTrigger
                  key={tab}
                  tab={tab}
                  label={tabLabel(tab)}
                  selected={tab === effectiveTab}
                  onReselect={closePanel}
                />
              ))}
              {/* Trailing drag region lets the empty part of the tab row move
                  the window. */}
              <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
            </TabsList>
            {panels}
          </>
        ) : (
          <>
            {/* Desktop top strip: the selected tab's title where the tabs used
                to be (they moved to the rail below). It shares this h-10 row
                with the fixed top-right window-chrome overlay, which floats
                over the reserved slot at its end; the title and the empty
                remainder are window-drag regions, the row being the window's
                top edge.
                Off-image `bg-muted` matches the conversation/file strips +
                bottom StatusBar. With a workspace background image on, the
                composition-family pair `ws-transparent-bg ws-strip-line` makes
                this top strip go transparent (revealing the real background
                like the column body / conversation + file tab strips do) and
                draws a hairline bottom border to separate it from the tab
                content — both are `[data-workspace-bg="on"]`-gated, so
                off-image is unchanged. */}
            <div className="flex h-10 shrink-0 items-center bg-muted ws-transparent-bg ws-strip-line pl-3">
              <h2
                data-tauri-drag-region
                className="min-w-0 truncate text-[0.8125rem] leading-5 font-semibold"
              >
                {tabLabel(effectiveTab)}
              </h2>
              <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
              <ChromeReserve width={rightReserve} line={false} />
            </div>
            <div className="flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">{panels}</div>
              <AuxPanelTabRail
                tabs={shownTabs}
                visible={showFolderTabs}
                icons={TAB_ICONS}
                labelOf={tabLabel}
                activeTab={effectiveTab}
                onReselect={closePanel}
              />
            </div>
          </>
        )}
      </Tabs>
    </aside>
  )
}

/** One tab of the mobile drawer's row. A tap on the tab already showing
 *  closes the drawer, as a click does on the desktop rail. */
function MobileAuxTabTrigger({
  tab,
  label,
  selected,
  onReselect,
}: {
  tab: AuxPanelTab
  label: string
  selected: boolean
  onReselect: () => void
}) {
  const { triggerProps } = useTabReselect(selected, onReselect)
  const Icon = TAB_ICONS[tab]
  return (
    <TabsTrigger value={tab} title={label} aria-label={label} {...triggerProps}>
      <Icon className="h-3.5 w-3.5" />
    </TabsTrigger>
  )
}
