"use client"

import { BrowserEvalConfirm } from "@/components/browser/browser-eval-confirm"
import { BrowserEventsBridge } from "@/components/browser/browser-events-bridge"
import { BrowserScreenshotMarkupHost } from "@/components/browser/browser-screenshot-markup"
import { BrowserServiceBridge } from "@/components/browser/browser-service-bridge"
import { BrowserTabsPersistence } from "@/components/browser/browser-tabs-persistence"
import { BrowserTabsSuspender } from "@/components/browser/browser-tabs-suspender"
import {
  Suspense,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import type { ImperativePanelGroupHandle } from "react-resizable-panels"
import { FolderTitleBar } from "@/components/layout/folder-title-bar"
import { Sidebar } from "@/components/layout/sidebar"
import { StatusBar } from "@/components/layout/status-bar"
import {
  AppWorkspaceProvider,
  ConversationStatusEventBridge,
} from "@/contexts/app-workspace-context"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { TaskProvider } from "@/contexts/task-context"
import { AlertProvider } from "@/contexts/alert-context"
import {
  AcpConnectionsProvider,
  useAcpActions,
} from "@/contexts/acp-connections-context"
import { DelegationProvider } from "@/contexts/delegation-context"
import { ConversationRuntimeProvider } from "@/contexts/conversation-runtime-context"
import { TabProvider, useTabStore, useTabActions } from "@/contexts/tab-context"
import { selectIsSplit } from "@/stores/tab-store"
import { SidebarProvider, useSidebarContext } from "@/contexts/sidebar-context"
import { SearchDialogProvider } from "@/contexts/search-dialog-context"
import { AutomationsViewProvider } from "@/contexts/automations-view-context"
import { TasksViewProvider } from "@/contexts/tasks-view-context"
import {
  WorkbenchRouteProvider,
  useWorkbenchRoute,
} from "@/contexts/workbench-route-context"
import {
  WorkbenchRoutePage,
  WorkbenchRouteStrip,
  useHasWorkbenchRouteStrip,
} from "@/components/workbench/workbench-content"
import {
  AuxPanelProvider,
  useAuxPanelContext,
} from "@/contexts/aux-panel-context"
import {
  TerminalProvider,
  useTerminalContext,
} from "@/contexts/terminal-context"
import { GitCredentialProvider } from "@/contexts/git-credential-context"
import {
  WorkspaceProvider,
  useWorkspaceActions,
  useWorkspaceView,
} from "@/contexts/workspace-context"
import { RemoteConnectionGate } from "@/contexts/remote-connection-context"
import { UpdateProvider } from "@/components/providers/update-provider"
import { useWorkspaceBackground, useZoomLevel } from "@/hooks/use-appearance"
import { FILL_MODE_STYLE } from "@/lib/workspace-background"
import { TabBar } from "@/components/tabs/tab-bar"
import { TerminalPanel } from "@/components/terminal/terminal-panel"
import { AuxPanel } from "@/components/layout/aux-panel"
import { LeftEdgeChrome } from "@/components/layout/left-edge-chrome"
import { RightEdgeChrome } from "@/components/layout/right-edge-chrome"
import { WorkspaceChromeController } from "@/components/layout/workspace-chrome-controller"
import { WindowControls } from "@/components/layout/window-controls"
import { FileWorkspaceTabBar } from "@/components/files/file-workspace-tab-bar"
import { FileWorkspaceHeader } from "@/components/files/file-workspace-header"
import { FileWorkspacePanel } from "@/components/files/file-workspace-panel"
import { ExternalConflictDialog } from "@/components/files/external-conflict-dialog"
import { AppToaster } from "@/components/ui/app-toaster"
import {
  DeepLinkBootstrap,
  PetFocusBridge,
} from "@/components/workspace/deep-link-bootstrap"
import { WorkspaceOpenFolderListener } from "@/components/workspace/workspace-open-folder-listener"
import { HeavyPluginsWarmup } from "@/components/ai-elements/heavy-plugins-warmup"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { cn } from "@/lib/utils"
import { isDesktop } from "@/lib/platform"
import {
  WINDOW_CAPTION_WIDTH,
  leftChromeReserve,
  rightChromeReserve,
} from "@/lib/window-chrome"
import { useIsMobile } from "@/hooks/use-mobile"
import { usePlatform } from "@/hooks/use-platform"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { OverlayHostHiddenProvider } from "@/components/ui/overlay-host-hidden"

function WorkspaceDocumentTitle() {
  const { activeFolder } = useActiveFolder()

  useEffect(() => {
    document.title = activeFolder ? `${activeFolder.name} - codeg` : "codeg"
  }, [activeFolder])

  return null
}

const TOAST_DURATION_MS = 15000
const WORKSPACE_PANEL_GROUP_ID = "workspace-panel-group"
const WORKSPACE_CONVERSATION_PANEL_ID = "workspace-conversation-panel"
const WORKSPACE_FILES_PANEL_ID = "workspace-files-panel"
const FOLDER_SHELL_GROUP_ID = "folder-shell-group"
const FOLDER_SHELL_LEFT_PANEL_ID = "folder-shell-left-panel"
const FOLDER_SHELL_MAIN_PANEL_ID = "folder-shell-main-panel"
const FOLDER_SHELL_RIGHT_PANEL_ID = "folder-shell-right-panel"
const FOLDER_MAIN_GROUP_ID = "folder-main-group"
const FOLDER_MAIN_WORKSPACE_PANEL_ID = "folder-main-workspace-panel"
const FOLDER_MAIN_TERMINAL_PANEL_ID = "folder-main-terminal-panel"
const DEFAULT_FUSION_LAYOUT: [number, number] = [56, 44]
const MIN_CENTER_WIDTH_PX = 420
const MIN_WORKSPACE_HEIGHT_PX = 220
const LAYOUT_EPSILON = 0.25
// Slide duration for panel show/hide; must match the CSS transition on
// `.panel-slide-animating > [data-panel]` in globals.css. The transition class
// is held a touch past this so the animation finishes before it's removed
// (removing it mid-transition would snap the final pixels).
const PANEL_SLIDE_MS = 240
const PANEL_SLIDE_CLEANUP_MS = PANEL_SLIDE_MS + 60

function TabKeysSync() {
  const tabs = useTabStore((s) => s.tabs)
  const { registerOpenTabKeys } = useAcpActions()
  const keys = useMemo(() => new Set(tabs.map((t) => t.id)), [tabs])
  useEffect(() => {
    registerOpenTabKeys(keys)
  }, [keys, registerOpenTabKeys])
  return null
}

function isSameLayout(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, index) => Math.abs(value - b[index]) <= LAYOUT_EPSILON)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function toPercent(pixels: number, totalPixels: number): number {
  if (totalPixels <= 0) return 0
  return (pixels / totalPixels) * 100
}

function resolvePanelSizeRange(
  minPixels: number,
  maxPixels: number,
  totalPixels: number
): { minSize: number; maxSize: number } {
  const safeTotal = totalPixels > 0 ? totalPixels : 1
  const minSize = clamp(toPercent(minPixels, safeTotal), 0, 100)
  const maxSize = clamp(toPercent(maxPixels, safeTotal), minSize, 100)
  return { minSize, maxSize }
}

/**
 * Returns `true` for a brief window after `open` flips, so the caller can add
 * the `.panel-slide-animating` class that animates the panel resize (a "push"
 * slide) on explicit show/hide toggles only — never on the initial mount, on
 * localStorage hydration, or during resize-handle drags. The first settled
 * `open` value (once `ready`) establishes a baseline without animating.
 *
 * The toggle is detected during render (React's sanctioned "adjust state when a
 * prop changes" pattern) rather than in an effect: turning the class on in the
 * render that observes the flip lands it in the same commit as the panel
 * resize, so the browser has the transition in place before `flex-grow`
 * changes. Turn-off is deferred to a timer keyed on a per-toggle sequence, so a
 * fresh toggle mid-slide re-arms the timer instead of inheriting the old one.
 */
function usePanelSlideOnToggle(open: boolean, ready: boolean): boolean {
  const [animating, setAnimating] = useState(false)
  const [slideSeq, setSlideSeq] = useState(0)
  const [prevOpen, setPrevOpen] = useState<boolean | null>(null)

  if (ready) {
    if (prevOpen === null) {
      // Adopt the hydrated value as the baseline without animating.
      setPrevOpen(open)
    } else if (prevOpen !== open) {
      setPrevOpen(open)
      setAnimating(true)
      setSlideSeq((seq) => seq + 1)
    }
  }

  useEffect(() => {
    if (slideSeq === 0) return
    const timer = setTimeout(() => setAnimating(false), PANEL_SLIDE_CLEANUP_MS)
    return () => clearTimeout(timer)
  }, [slideSeq])

  return animating
}

/**
 * The conversation surface while a full-page workbench route covers it: kept
 * MOUNTED (so background conversations keep streaming) and merely stopped from
 * painting.
 *
 * `inert` drops it from the tab order; `invisible` (visibility, not display —
 * keeps mount/layout/scroll) stops it painting, because with a workspace
 * background image the route overlay's ws-surface is translucent and the
 * conversation would ghost through it. `conversation-tab-hidden` hardens that
 * hidden subtree (see globals.css): it kills the subtree's transitions so
 * visibility flips instantly (transition-all ghosts) and re-hides the
 * descendants that declare `visibility: visible` themselves — Monaco's diff
 * panes do, which is why an open git-diff file tab used to show through the
 * tasks / automations / token-usage pages.
 *
 * The fourth part is `OverlayHostHiddenProvider`, and it is the reason this is
 * one component instead of the three lines it used to be in each shell. None
 * of the above reaches a layer that PORTALS out of this subtree, and the
 * session-viewer drawers do exactly that (to the body) — so a sub-agent
 * transcript opened from a conversation went on painting over the tasks board.
 * Keeping the flag welded to the class and the `inert` is what stops the next
 * hidden subtree from reintroducing that.
 */
function KeptMountedSurface({
  hidden,
  children,
}: {
  hidden: boolean
  children: React.ReactNode
}) {
  return (
    <OverlayHostHiddenProvider hidden={hidden}>
      <div
        className={cn(
          "h-full min-h-0",
          hidden && "conversation-tab-hidden invisible"
        )}
        inert={hidden || undefined}
      >
        {children}
      </div>
    </OverlayHostHiddenProvider>
  )
}

function WorkspaceContent({ children }: { children: React.ReactNode }) {
  const { mode, filesMaximized } = useWorkspaceView()
  const { setActivePane } = useWorkspaceActions()
  const panelGroupRef = useRef<ImperativePanelGroupHandle | null>(null)
  const fusionLayoutRef = useRef<[number, number]>(DEFAULT_FUSION_LAYOUT)
  const desiredLayoutRef = useRef<[number, number]>(DEFAULT_FUSION_LAYOUT)
  const appliedLayoutRef = useRef<[number, number] | null>(null)

  const markConversationActive = useCallback(() => {
    if (mode !== "fusion" || filesMaximized) return
    setActivePane("conversation")
  }, [mode, filesMaximized, setActivePane])

  const markFileActive = useCallback(() => {
    if (mode !== "fusion") return
    setActivePane("files")
  }, [mode, setActivePane])

  const applyLayout = useCallback((layout: [number, number]) => {
    desiredLayoutRef.current = layout
    if (
      appliedLayoutRef.current &&
      isSameLayout(appliedLayoutRef.current, layout)
    ) {
      return
    }

    const panelGroup = panelGroupRef.current
    if (!panelGroup) return

    try {
      panelGroup.setLayout(layout)
      appliedLayoutRef.current = layout
    } catch {
      /* retry via onLayout */
    }
  }, [])

  useEffect(() => {
    if (mode === "fusion") {
      applyLayout(fusionLayoutRef.current)
    }
  }, [applyLayout, mode])

  const handleLayout = useCallback(
    (layout: number[]) => {
      if (layout.length !== 2) return

      const normalizedLayout: [number, number] = [layout[0], layout[1]]
      appliedLayoutRef.current = normalizedLayout

      const desired = desiredLayoutRef.current
      if (mode !== "fusion" && !isSameLayout(normalizedLayout, desired)) {
        applyLayout(desired)
        return
      }

      if (mode !== "fusion") return

      const [conversationSize, fileSize] = normalizedLayout
      if (conversationSize <= 0 || fileSize <= 0) return
      fusionLayoutRef.current = [conversationSize, fileSize]
    },
    [applyLayout, mode]
  )

  const { isConversations } = useWorkbenchRoute()
  const hasRouteStrip = useHasWorkbenchRouteStrip()
  const { isOpen: sidebarOpen } = useSidebarContext()
  const { isOpen: auxOpen } = useAuxPanelContext()
  const { isMac, isWindows, isLinux } = usePlatform()
  const { zoomLevel } = useZoomLevel()
  const hasConvTabs = useTabStore((s) => s.tabs.length > 0)
  const isConvSplit = useTabStore(selectIsSplit)
  const winLinuxControls = isDesktop() && (isWindows || isLinux)
  // The window chrome (toggle/search left, terminal/aux/settings right) now
  // lives in fixed corner overlays (see FolderLayoutShell) that never move on
  // panel toggles. Each edge column just reserves the overlay's width so its
  // tabs never render underneath. The reserve scales with the app zoom so it
  // tracks the rem-sized overlay buttons (which grow with zoom).
  const leftReserve = leftChromeReserve(isMac && isDesktop(), zoomLevel)
  const rightReserve = rightChromeReserve(winLinuxControls, zoomLevel)
  // A middle column reserves the right overlay only when it (not the aux panel)
  // is the window's right edge: the file column in fusion, else conversation.
  const convReservesRight = !auxOpen && mode === "conversation"
  const fileReservesRight = !auxOpen && mode === "fusion"
  // Maximizing files overlays the whole middle area, so the file column then
  // also owns the window's LEFT edge when the sidebar is collapsed — reserve the
  // left overlay too (normally that's the conversation column's job).
  const fileReservesLeft = filesMaximized && !sidebarOpen

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <KeptMountedSurface hidden={!isConversations}>
        <ResizablePanelGroup
          id={WORKSPACE_PANEL_GROUP_ID}
          ref={panelGroupRef}
          direction="horizontal"
          onLayout={handleLayout}
        >
          <ResizablePanel
            id={WORKSPACE_CONVERSATION_PANEL_ID}
            order={1}
            defaultSize={56}
            minSize={mode === "fusion" ? 25 : 0}
          >
            {/* Conversations live in here, so a session viewer opened from one
                portals to the body and escapes the hiding below — same reason
                `KeptMountedSurface` carries this flag. */}
            <OverlayHostHiddenProvider hidden={filesMaximized}>
              <section
                className={cn(
                  "flex h-full min-h-0 flex-col overflow-hidden",
                  mode === "conversation" &&
                    "absolute inset-0 z-30 bg-background ws-transparent-bg",
                  // Covered by the files-maximized overlay: stop painting so it
                  // can't show through the now-translucent overlay. `invisible`
                  // (visibility:hidden), not display:none, keeps mount + box size
                  // intact so the stick-to-bottom scroll doesn't reset;
                  // conversation-tab-hidden is the shared hardening for a hidden
                  // keep-alive subtree (kills its transitions, and re-hides the
                  // descendants that declare `visibility: visible` themselves).
                  filesMaximized && "conversation-tab-hidden invisible"
                )}
                inert={filesMaximized || undefined}
              >
                {/* Conversation column top bar (UNSPLIT only): the tab strip,
                  plus a left reserve (only when the sidebar is collapsed, so
                  this column owns the window's left edge) and a right reserve
                  (only when it's the window's right edge) for the fixed corner
                  overlays. The detail header + tiles render inside {children},
                  directly below. `bg-muted` shades the strip like a browser tab
                  bar (matching the bottom StatusBar) — the active tab
                  (bg-background) reads as a white tab seated on it, with
                  reverse bottom corners. With a workspace background image on,
                  the strip + every tab go transparent (reveal the image); a
                  hairline bottom border (ws-strip-line) runs under the reserves
                  and inactive tabs while the active tab omits it and the border
                  arches over its top (the active browser-tab-item's `::after`)
                  instead. While SPLIT this row disappears entirely (no blank
                  drag strip above the shells): each group shell hosts its own
                  strip whose tail spacer is a window-drag region, and the
                  TOP-edge strips re-create the corner reserves themselves (see
                  SplitStripCornerReserve in conversation-detail-panel). */}
                {!isConvSplit && (
                  <div className="flex h-10 shrink-0 items-stretch bg-muted ws-transparent-bg">
                    {!sidebarOpen && (
                      <div
                        data-tauri-drag-region
                        className="h-full shrink-0 ws-strip-line"
                        style={{ width: leftReserve }}
                      />
                    )}
                    <div className="flex min-w-0 flex-1 items-stretch">
                      {hasConvTabs ? (
                        <TabBar />
                      ) : (
                        // No tabs → TabBar renders null; keep a drag region so
                        // the title bar can still move the window.
                        <div
                          data-tauri-drag-region
                          className="h-full min-w-0 flex-1 ws-strip-line"
                        />
                      )}
                    </div>
                    {convReservesRight && (
                      <div
                        data-tauri-drag-region
                        className="h-full shrink-0 ws-strip-line"
                        style={{ width: rightReserve }}
                      />
                    )}
                  </div>
                )}
                {/* Pane activation lives on the CONTENT, not the top bar: clicking
                  edge chrome (terminal/settings/toggles) or grabbing a drag
                  region stays pane-neutral so it never hijacks close-tab /
                  next-tab routing. Tabs self-activate via switchTab. */}
                <div
                  className="relative flex-1 min-h-0 overflow-hidden"
                  onPointerDownCapture={markConversationActive}
                  onFocusCapture={markConversationActive}
                >
                  {children}
                </div>
              </section>
            </OverlayHostHiddenProvider>
          </ResizablePanel>
          {/* The divider only belongs to a real two-column split. In conversation
              mode the column overlays the whole area, so the handle collapses to
              zero width. While files are MAXIMIZED it must go too: that overlay
              is translucent under a workspace background image, so the handle's
              1px `bg-border` line stayed visible straight through it — a stray
              vertical divider running down the maximized file column and on
              through the editor / diff canvas below. There it only turns
              invisible (no `w-0`): dropping its width would resize the
              conversation panel and reset its stick-to-bottom scroll, the very
              thing the overlay approach avoids. */}
          <ResizableHandle
            withHandle
            disabled={mode !== "fusion" || filesMaximized}
            className={cn(
              mode !== "fusion" &&
                "pointer-events-none w-0 opacity-0 after:w-0",
              mode === "fusion" &&
                filesMaximized &&
                "pointer-events-none invisible"
            )}
          />
          <ResizablePanel
            id={WORKSPACE_FILES_PANEL_ID}
            order={2}
            defaultSize={44}
            minSize={mode === "fusion" ? 20 : 0}
          >
            {/* When maximized, overlay the file section across the entire
                workspace area instead of resizing the conversation panel — that
                would fire ResizeObserver on the conversation's stick-to-bottom
                scroll container and reset its position.
                The `absolute inset-0` resolves to the outer `relative` wrapper
                (the static `h-full` wrapper here is skipped), not the Panel
                root. This depends on react-resizable-panels keeping the Panel
                root at `position: static`; if a future version sets
                `position: relative` there, this overlay (and the mirrored
                `mode === "conversation"` overlay above) would clip to the
                Panel's allocated slice and need to be lifted outside the panel
                group. */}
            <section
              className={cn(
                "flex h-full min-h-0 flex-col overflow-hidden",
                filesMaximized &&
                  "absolute inset-0 z-30 bg-background ws-transparent-bg",
                // Covered by the conversation overlay in conversation mode: hide
                // from paint (keep mount + layout) so it can't show through the
                // translucent overlay. conversation-tab-hidden goes with it —
                // an open git-diff tab lives in this column and Monaco's diff
                // panes set their own inline `visibility: visible` (see
                // globals.css), so `invisible` alone leaves them painting.
                mode === "conversation" && "conversation-tab-hidden invisible"
              )}
              aria-hidden={mode === "conversation"}
            >
              {/* File column top bar: the file tab strip + a right reserve for
                  the fixed corner overlay (only when the aux panel is collapsed,
                  so this column owns the window's right edge). Per-file actions
                  live in FileWorkspaceHeader below, above every
                  FileWorkspacePanel render branch. `bg-muted` shades the strip
                  like a browser tab bar (matches the conversation column and the
                  bottom StatusBar). With a workspace background image on, the
                  strip + every tab go transparent (reveal the image) and a
                  hairline bottom border (ws-strip-line) sits under the reserves
                  and inactive tabs, arching over the active tab (the active
                  browser-tab-item's `::after`) — same as the conversation column. */}
              <div className="flex h-10 shrink-0 items-stretch bg-muted ws-transparent-bg">
                {fileReservesLeft && (
                  <div
                    data-tauri-drag-region
                    className="h-full shrink-0 ws-strip-line"
                    style={{ width: leftReserve }}
                  />
                )}
                <div className="flex min-w-0 flex-1 items-stretch">
                  <FileWorkspaceTabBar />
                </div>
                {fileReservesRight && (
                  <div
                    data-tauri-drag-region
                    className="h-full shrink-0 ws-strip-line"
                    style={{ width: rightReserve }}
                  />
                )}
              </div>
              {/* Pane activation on the file content + its detail header, not
                  the top bar (see the conversation section). */}
              <div
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
                onPointerDownCapture={markFileActive}
                onFocusCapture={markFileActive}
              >
                <FileWorkspaceHeader />
                <div className="flex-1 min-h-0 overflow-hidden">
                  <FileWorkspacePanel />
                </div>
              </div>
            </section>
          </ResizablePanel>
        </ResizablePanelGroup>
      </KeptMountedSurface>
      {!isConversations ? (
        // `bg-background ws-transparent-bg` matches the conversation surface
        // exactly: opaque background normally, fully transparent (image shows
        // through, no frost) with a workspace background image on — the
        // conversation beneath is `invisible` so nothing else paints through.
        <div className="absolute inset-0 z-40 flex flex-col bg-background ws-transparent-bg">
          {/* Window-chrome strip: reserves the fixed corner overlays' h-10
              band, hosts the active route's title on the left, and keeps the
              empty middle as a window-drag region. With a title present it
              closes with the sidebar-header hairline (ws-chrome-border keeps
              it legible over a background image). */}
          <div
            className={cn(
              "flex h-10 shrink-0 items-stretch",
              hasRouteStrip && "border-b border-border/50 ws-chrome-border"
            )}
          >
            {!sidebarOpen && (
              <div
                data-tauri-drag-region
                className="h-full shrink-0"
                style={{ width: leftReserve }}
              />
            )}
            <WorkbenchRouteStrip />
            <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
          </div>
          <div className="min-h-0 flex-1">
            <WorkbenchRoutePage />
          </div>
        </div>
      ) : null}
    </div>
  )
}

function MobileWorkspaceContent({ children }: { children: React.ReactNode }) {
  const { mode, activePane } = useWorkspaceView()
  const { isConversations } = useWorkbenchRoute()
  const hasRouteStrip = useHasWorkbenchRouteStrip()

  const showConversation =
    mode === "conversation" || activePane === "conversation"

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <KeptMountedSurface hidden={!isConversations}>
        {showConversation ? (
          // Mobile mirrors the desktop chrome: no tab strip — the conversation
          // detail header (folder › title) renders inside {children}, and tabs
          // are navigated from the sidebar (single active conversation at a time).
          <section className="flex h-full min-h-0 flex-col overflow-hidden">
            <div className="relative flex-1 min-h-0 overflow-hidden">
              {children}
            </div>
          </section>
        ) : (
          // File view: the shared FileWorkspaceHeader (folder › file breadcrumb)
          // replaces the file tab strip, matching the desktop file column.
          <section className="flex h-full min-h-0 flex-col overflow-hidden">
            <FileWorkspaceHeader />
            <div className="flex-1 min-h-0 overflow-hidden">
              <FileWorkspacePanel />
            </div>
          </section>
        )}
      </KeptMountedSurface>
      {!isConversations ? (
        // Same canvas as the desktop overlay: conversation-identical background
        // (opaque normally, transparent under a workspace background image).
        <div className="absolute inset-0 z-40 flex flex-col bg-background ws-transparent-bg">
          {hasRouteStrip ? (
            <div className="flex h-10 shrink-0 items-stretch border-b border-border/50 ws-chrome-border">
              <WorkbenchRouteStrip />
              <div className="min-w-0 flex-1" />
            </div>
          ) : null}
          <div className="min-h-0 flex-1">
            <WorkbenchRoutePage />
          </div>
        </div>
      ) : null}
    </div>
  )
}

function MobileFolderWorkspaceShell({
  children,
}: {
  children: React.ReactNode
}) {
  const {
    isOpen: sidebarOpen,
    restored: sidebarRestored,
    toggle: toggleSidebar,
  } = useSidebarContext()
  const {
    isOpen: auxOpen,
    restored: auxRestored,
    toggle: toggleAux,
  } = useAuxPanelContext()
  const { isOpen: terminalOpen, toggle: toggleTerminal } = useTerminalContext()

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* These three opt back into press-outside-to-close, against the app-wide
          drawer default. They are mobile NAVIGATION: each covers most of the
          screen and the strip of page left showing is the affordance for
          getting back to it — tapping there to dismiss is the platform habit,
          and there is nothing behind them a user would want to click *through*
          to while they are open. */}
      <Drawer
        open={sidebarRestored && sidebarOpen}
        onOpenChange={toggleSidebar}
        swipeDirection="left"
        disablePointerDismissal={false}
      >
        <DrawerContent
          showCloseButton={false}
          className="w-[85%] max-w-[22.5rem] p-0"
        >
          <DrawerTitle className="sr-only">Sidebar</DrawerTitle>
          <Sidebar />
        </DrawerContent>
      </Drawer>

      <main className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        <MobileWorkspaceContent>{children}</MobileWorkspaceContent>
      </main>

      <Drawer
        open={auxRestored && auxOpen}
        onOpenChange={toggleAux}
        swipeDirection="right"
        disablePointerDismissal={false}
      >
        <DrawerContent
          showCloseButton={false}
          className="w-[85%] max-w-[22.5rem] p-0"
        >
          <DrawerTitle className="sr-only">Panel</DrawerTitle>
          <AuxPanel />
        </DrawerContent>
      </Drawer>

      <Drawer
        open={terminalOpen}
        onOpenChange={toggleTerminal}
        swipeDirection="down"
        disablePointerDismissal={false}
      >
        <DrawerContent showCloseButton={false} className="h-[95vh] p-0">
          <DrawerTitle className="sr-only">Terminal</DrawerTitle>
          <div className="h-full min-h-0 overflow-hidden">
            <TerminalPanel />
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  )
}

function FolderWorkspaceShell({ children }: { children: React.ReactNode }) {
  const {
    isOpen: sidebarOpen,
    restored: sidebarRestored,
    width: sidebarWidth,
    minWidth: sidebarMinWidth,
    maxWidth: sidebarMaxWidth,
    setWidth: setSidebarWidth,
  } = useSidebarContext()
  const {
    isOpen: auxOpenRequested,
    restored: auxRestored,
    width: auxWidth,
    minWidth: auxMinWidth,
    maxWidth: auxMaxWidth,
    setWidth: setAuxWidth,
  } = useAuxPanelContext()
  const {
    isOpen: terminalOpenRequested,
    height: terminalHeight,
    minHeight: terminalMinHeight,
    maxHeight: terminalMaxHeight,
    setHeight: setTerminalHeight,
  } = useTerminalContext()
  // A full-page workbench route (tasks / automations) replaces only the CENTER
  // panel — the terminal sits below it and the aux panel beside it, both
  // outside the overlay. Their toggles are hidden on those routes
  // (RightEdgeChrome), so anything left open would be stranded on screen with
  // no way to close it. Collapse both for the duration; the contexts keep the
  // user's real open state (and the terminal keeps running), so switching back
  // to conversations restores exactly what was there.
  const { isConversations } = useWorkbenchRoute()
  const auxOpen = auxOpenRequested && isConversations
  const terminalOpen = terminalOpenRequested && isConversations

  // Animate the shell (horizontal) group while the sidebar/aux toggle and the
  // main (vertical) group while the terminal toggles, so the panes slide open
  // and closed instead of snapping. Gated on `restored` so hydrating the
  // persisted open/closed state on load doesn't animate. The terminal has no
  // persisted state (always starts closed), so it's always "ready".
  const sidebarAnimating = usePanelSlideOnToggle(sidebarOpen, sidebarRestored)
  const auxAnimating = usePanelSlideOnToggle(auxOpen, auxRestored)
  const terminalAnimating = usePanelSlideOnToggle(terminalOpen, true)
  const shellSlideAnimating = sidebarAnimating || auxAnimating

  const shellGroupRef = useRef<ImperativePanelGroupHandle | null>(null)
  const mainGroupRef = useRef<ImperativePanelGroupHandle | null>(null)
  const shellContainerRef = useRef<HTMLDivElement | null>(null)
  const mainContainerRef = useRef<HTMLDivElement | null>(null)

  const [shellWidth, setShellWidth] = useState(0)
  const [mainHeight, setMainHeight] = useState(0)

  const shellDesiredLayoutRef = useRef<[number, number, number]>([0, 100, 0])
  const shellAppliedLayoutRef = useRef<[number, number, number] | null>(null)
  const mainDesiredLayoutRef = useRef<[number, number]>([100, 0])
  const mainAppliedLayoutRef = useRef<[number, number] | null>(null)

  useEffect(() => {
    const container = shellContainerRef.current
    if (!container) return

    const updateWidth = (next: number) => {
      setShellWidth((prev) => (Math.abs(prev - next) < 1 ? prev : next))
    }

    updateWidth(container.clientWidth)
    const observer = new ResizeObserver((entries) => {
      updateWidth(entries[0]?.contentRect.width ?? container.clientWidth)
    })

    observer.observe(container)
    return () => {
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    const container = mainContainerRef.current
    if (!container) return

    const updateHeight = (next: number) => {
      setMainHeight((prev) => (Math.abs(prev - next) < 1 ? prev : next))
    }

    updateHeight(container.clientHeight)
    const observer = new ResizeObserver((entries) => {
      updateHeight(entries[0]?.contentRect.height ?? container.clientHeight)
    })

    observer.observe(container)
    return () => {
      observer.disconnect()
    }
  }, [])

  const buildShellLayout = useCallback((): [number, number, number] => {
    const requestedLeft = sidebarOpen
      ? clamp(sidebarWidth, sidebarMinWidth, sidebarMaxWidth)
      : 0
    const requestedRight = auxOpen
      ? clamp(auxWidth, auxMinWidth, auxMaxWidth)
      : 0

    const totalWidth =
      shellWidth > 0 ? shellWidth : requestedLeft + requestedRight + 960

    let left = requestedLeft
    let right = requestedRight

    const maxSideTotal = Math.max(0, totalWidth - MIN_CENTER_WIDTH_PX)
    const sideTotal = left + right
    if (sideTotal > maxSideTotal && sideTotal > 0) {
      const scale = maxSideTotal / sideTotal
      left *= scale
      right *= scale
    }

    const center = Math.max(1, totalWidth - left - right)
    const total = left + center + right

    return [(left / total) * 100, (center / total) * 100, (right / total) * 100]
  }, [
    auxMaxWidth,
    auxMinWidth,
    auxOpen,
    auxWidth,
    shellWidth,
    sidebarMaxWidth,
    sidebarMinWidth,
    sidebarOpen,
    sidebarWidth,
  ])

  const buildMainLayout = useCallback((): [number, number] => {
    if (!terminalOpen) {
      return [100, 0]
    }

    const requestedTerminalHeight = clamp(
      terminalHeight,
      terminalMinHeight,
      terminalMaxHeight
    )
    const totalHeight =
      mainHeight > 0 ? mainHeight : requestedTerminalHeight + 640

    const maxTerminalHeight = Math.max(0, totalHeight - MIN_WORKSPACE_HEIGHT_PX)
    const terminal = Math.min(requestedTerminalHeight, maxTerminalHeight)
    const workspace = Math.max(1, totalHeight - terminal)
    const total = workspace + terminal

    return [(workspace / total) * 100, (terminal / total) * 100]
  }, [
    mainHeight,
    terminalHeight,
    terminalMaxHeight,
    terminalMinHeight,
    terminalOpen,
  ])

  const applyShellLayout = useCallback((layout: [number, number, number]) => {
    shellDesiredLayoutRef.current = layout
    if (
      shellAppliedLayoutRef.current &&
      isSameLayout(shellAppliedLayoutRef.current, layout)
    ) {
      return
    }

    const shellGroup = shellGroupRef.current
    if (!shellGroup) return

    try {
      shellGroup.setLayout(layout)
      shellAppliedLayoutRef.current = layout
    } catch {
      /* retry via onLayout */
    }
  }, [])

  const applyMainLayout = useCallback((layout: [number, number]) => {
    mainDesiredLayoutRef.current = layout
    if (
      mainAppliedLayoutRef.current &&
      isSameLayout(mainAppliedLayoutRef.current, layout)
    ) {
      return
    }

    const mainGroup = mainGroupRef.current
    if (!mainGroup) return

    try {
      mainGroup.setLayout(layout)
      mainAppliedLayoutRef.current = layout
    } catch {
      /* retry via onLayout */
    }
  }, [])

  useEffect(() => {
    applyShellLayout(buildShellLayout())
  }, [applyShellLayout, buildShellLayout])

  useEffect(() => {
    applyMainLayout(buildMainLayout())
  }, [applyMainLayout, buildMainLayout])

  const handleShellLayout = useCallback(
    (layout: number[]) => {
      if (layout.length !== 3) return

      const normalizedLayout: [number, number, number] = [
        layout[0],
        layout[1],
        layout[2],
      ]
      shellAppliedLayoutRef.current = normalizedLayout

      const desired = shellDesiredLayoutRef.current
      const shouldEnforceDesiredLayout =
        (!sidebarOpen && normalizedLayout[0] > LAYOUT_EPSILON) ||
        (!auxOpen && normalizedLayout[2] > LAYOUT_EPSILON)

      if (
        shouldEnforceDesiredLayout &&
        !isSameLayout(normalizedLayout, desired)
      ) {
        applyShellLayout(desired)
        return
      }

      if (shellWidth <= 0) return

      if (sidebarOpen) {
        const nextSidebarWidth = (normalizedLayout[0] / 100) * shellWidth
        const withinSidebarRange =
          nextSidebarWidth >= sidebarMinWidth - 1 &&
          nextSidebarWidth <= sidebarMaxWidth + 1
        if (
          withinSidebarRange &&
          Math.abs(nextSidebarWidth - sidebarWidth) >= 1
        ) {
          setSidebarWidth(nextSidebarWidth)
        }
      }

      if (auxOpen) {
        const nextAuxWidth = (normalizedLayout[2] / 100) * shellWidth
        const withinAuxRange =
          nextAuxWidth >= auxMinWidth - 1 && nextAuxWidth <= auxMaxWidth + 1
        if (withinAuxRange && Math.abs(nextAuxWidth - auxWidth) >= 1) {
          setAuxWidth(nextAuxWidth)
        }
      }
    },
    [
      applyShellLayout,
      auxMaxWidth,
      auxMinWidth,
      auxOpen,
      auxWidth,
      setAuxWidth,
      setSidebarWidth,
      shellWidth,
      sidebarMaxWidth,
      sidebarMinWidth,
      sidebarOpen,
      sidebarWidth,
    ]
  )

  const handleMainLayout = useCallback(
    (layout: number[]) => {
      if (layout.length !== 2) return

      const normalizedLayout: [number, number] = [layout[0], layout[1]]
      mainAppliedLayoutRef.current = normalizedLayout

      const desired = mainDesiredLayoutRef.current
      if (
        !terminalOpen &&
        normalizedLayout[1] > LAYOUT_EPSILON &&
        !isSameLayout(normalizedLayout, desired)
      ) {
        applyMainLayout(desired)
        return
      }

      if (!terminalOpen || mainHeight <= 0) return

      const nextTerminalHeight = (normalizedLayout[1] / 100) * mainHeight
      const withinTerminalRange =
        nextTerminalHeight >= terminalMinHeight - 1 &&
        nextTerminalHeight <= terminalMaxHeight + 1
      if (
        withinTerminalRange &&
        Math.abs(nextTerminalHeight - terminalHeight) >= 1
      ) {
        setTerminalHeight(nextTerminalHeight)
      }
    },
    [
      applyMainLayout,
      mainHeight,
      setTerminalHeight,
      terminalHeight,
      terminalMaxHeight,
      terminalMinHeight,
      terminalOpen,
    ]
  )

  const safeShellWidth = shellWidth > 0 ? shellWidth : 1440
  const sidebarSizeRange = resolvePanelSizeRange(
    sidebarMinWidth,
    sidebarMaxWidth,
    safeShellWidth
  )
  const auxSizeRange = resolvePanelSizeRange(
    auxMinWidth,
    auxMaxWidth,
    safeShellWidth
  )

  const safeMainHeight = mainHeight > 0 ? mainHeight : 900
  const terminalSizeRange = resolvePanelSizeRange(
    terminalMinHeight,
    terminalMaxHeight,
    safeMainHeight
  )

  return (
    <div
      ref={shellContainerRef}
      className="flex flex-1 min-h-0 overflow-hidden"
    >
      <ResizablePanelGroup
        id={FOLDER_SHELL_GROUP_ID}
        ref={shellGroupRef}
        direction="horizontal"
        onLayout={handleShellLayout}
        className={shellSlideAnimating ? "panel-slide-animating" : undefined}
      >
        <ResizablePanel
          id={FOLDER_SHELL_LEFT_PANEL_ID}
          order={1}
          defaultSize={18}
          minSize={sidebarOpen ? sidebarSizeRange.minSize : 0}
          maxSize={sidebarOpen ? sidebarSizeRange.maxSize : 0}
        >
          {/* `bg-sidebar` on the wrapper (not just the Sidebar surface) so the
              collapse never flashes white: Sidebar `return null`s the instant
              it closes, but the panel keeps a shrinking width for the 240ms
              slide — an un-backed wrapper would show the root `bg-background`
              (white) through that gap. */}
          <div className="h-full min-h-0 overflow-hidden ws-surface-sidebar">
            <Sidebar />
          </div>
        </ResizablePanel>

        <ResizableHandle
          withHandle
          disabled={!sidebarOpen}
          className={
            sidebarOpen ? "" : "pointer-events-none w-0 opacity-0 after:w-0"
          }
        />

        <ResizablePanel
          id={FOLDER_SHELL_MAIN_PANEL_ID}
          order={2}
          defaultSize={64}
          minSize={10}
        >
          <main
            ref={mainContainerRef}
            className="flex h-full min-h-0 flex-col overflow-hidden"
          >
            <ResizablePanelGroup
              id={FOLDER_MAIN_GROUP_ID}
              ref={mainGroupRef}
              direction="vertical"
              onLayout={handleMainLayout}
              className={
                terminalAnimating ? "panel-slide-animating" : undefined
              }
            >
              <ResizablePanel
                id={FOLDER_MAIN_WORKSPACE_PANEL_ID}
                order={1}
                defaultSize={72}
                minSize={15}
              >
                <WorkspaceContent>{children}</WorkspaceContent>
              </ResizablePanel>

              {/* Closed, the handle gives up its BOX, not just its paint — and
                  the override has to carry the same
                  `data-[panel-group-direction=vertical]` prefix the base size
                  does. A bare `h-0` is (0,1,0) against that rule's (0,2,0)
                  attribute selector and tailwind-merge keeps both (different
                  modifier sets), so it loses in silence: the closed terminal
                  kept a 1px invisible strip of the app background between the
                  workspace and the status bar, which reads as a gap under a
                  browser page or an HTML preview (the only panes that paint to
                  their own edge). The horizontal handles' `w-0` needs no
                  prefix — their base `w-px` is unprefixed, so twMerge drops
                  it. */}
              <ResizableHandle
                withHandle
                disabled={!terminalOpen}
                className={
                  terminalOpen
                    ? ""
                    : "pointer-events-none opacity-0 data-[panel-group-direction=vertical]:h-0 data-[panel-group-direction=vertical]:after:h-0"
                }
              />

              <ResizablePanel
                id={FOLDER_MAIN_TERMINAL_PANEL_ID}
                order={2}
                defaultSize={28}
                minSize={terminalOpen ? terminalSizeRange.minSize : 0}
                maxSize={terminalOpen ? terminalSizeRange.maxSize : 0}
              >
                <div className="h-full min-h-0 overflow-hidden">
                  <TerminalPanel />
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </main>
        </ResizablePanel>

        <ResizableHandle
          withHandle
          disabled={!auxOpen}
          className={
            auxOpen ? "" : "pointer-events-none w-0 opacity-0 after:w-0"
          }
        />

        <ResizablePanel
          id={FOLDER_SHELL_RIGHT_PANEL_ID}
          order={3}
          defaultSize={18}
          minSize={auxOpen ? auxSizeRange.minSize : 0}
          maxSize={auxOpen ? auxSizeRange.maxSize : 0}
        >
          {/* Transparent canvas so the right column reads like the middle
              conversation area (its own frosted chrome — the aux toolbar — sits
              on top): with a background image on, the file tree shows the image
              through instead of a second frosted layer over the toolbar. The
              paired `bg-background` is the off-state (image disabled): equivalent
              to the old opaque wrapper, so the 240ms collapse slide still never
              flashes white while AuxPanel `return null`s. */}
          <div className="h-full min-h-0 overflow-hidden bg-background ws-transparent-bg">
            <AuxPanel />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

function FolderLayoutShell({ children }: { children: React.ReactNode }) {
  const isMobile = useIsMobile()
  const { isWindows, isLinux } = usePlatform()
  const winLinuxControls = isDesktop() && (isWindows || isLinux)
  const {
    workspaceBgEnabled,
    workspaceBgImageUrl,
    workspaceBgMaskOpacity,
    workspaceBgImageBlur,
    workspaceBgFillMode,
  } = useWorkspaceBackground()
  const showBackground = workspaceBgEnabled && workspaceBgImageUrl !== null
  const fillStyle = FILL_MODE_STYLE[workspaceBgFillMode]

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
      {/* 用户背景图片：铺在整个工作区底层。根 div 是 fixed，已建立层叠上下文，故
          -z-10 绘于自身 bg-background 之上、所有流内容之下。遮罩是朝 --background 的
          面纱（明暗自适配），保证内容可读；结构性面板的半透明由 globals.css 的
          [data-workspace-bg] 规则处理，不在此。 */}
      {showBackground && (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-center"
            style={{
              backgroundImage: `url("${workspaceBgImageUrl}")`,
              backgroundSize: fillStyle.size,
              backgroundRepeat: fillStyle.repeat,
              filter: workspaceBgImageBlur
                ? `blur(${workspaceBgImageBlur}px)`
                : undefined,
            }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10"
            style={{
              backgroundColor: `color-mix(in oklch, var(--background) ${Math.round(
                workspaceBgMaskOpacity * 100
              )}%, transparent)`,
            }}
          />
        </>
      )}
      {/* Global shortcuts + the search / remote-directory dialogs (formerly
          owned by the full-width FolderTitleBar). Mounted on both platforms. */}
      <WorkspaceChromeController />
      {isMobile ? (
        <>
          {/* Mobile keeps the visible full-width bar; desktop moved its buttons
              into fixed corner overlays (LeftEdgeChrome / RightEdgeChrome). */}
          <FolderTitleBar />
          <MobileFolderWorkspaceShell>{children}</MobileFolderWorkspaceShell>
        </>
      ) : (
        <FolderWorkspaceShell>{children}</FolderWorkspaceShell>
      )}
      <StatusBar />
      {/* Desktop window chrome, pinned to the window corners so it never moves —
          or re-mounts — when the side panels open/close (that re-parenting is
          what made the old in-header clusters flicker). Left = sidebar toggle +
          search; right = terminal/aux/settings, sitting to the LEFT of the
          Windows/Linux caption buttons; then the caption buttons themselves
          (self-null on macOS/web). Each edge column reserves the matching width
          beneath these (see leftChromeReserve / rightChromeReserve). */}
      {!isMobile && (
        <>
          <div className="absolute left-0 top-0 z-50 h-10">
            <LeftEdgeChrome />
          </div>
          <div
            className="absolute top-0 z-50 h-10"
            style={{ right: winLinuxControls ? WINDOW_CAPTION_WIDTH : 0 }}
          >
            <RightEdgeChrome />
          </div>
          <div className="absolute right-0 top-0 z-50 h-10">
            <WindowControls />
          </div>
        </>
      )}
      <AppToaster
        position="bottom-right"
        duration={TOAST_DURATION_MS}
        closeButton
      />
    </div>
  )
}

// Single chokepoint that keeps the workbench route honest: opening or switching
// to a conversation from ANY entry point (sidebar, ⌘T, search, deep links, pet
// focus, branch switch, run history …) activates a tab, so leaving a non-default
// route whenever activeTabId changes covers every opener — present and future —
// without patching each call site. Re-selecting the ALREADY-active tab does not
// change activeTabId, so the interactive conversation pickers (sidebar list,
// search dialog, run history) also call openConversations() directly.
function WorkbenchRouteConversationSync() {
  const activeTabId = useTabStore((s) => s.activeTabId)
  const { consumeRemoteActivation } = useTabActions()
  const { openConversations } = useWorkbenchRoute()
  const prevRef = useRef(activeTabId)
  useEffect(() => {
    if (prevRef.current === activeTabId) return
    prevRef.current = activeTabId
    // A remote tab snapshot that mirrors another client's focus also changes
    // activeTabId. That's not a local conversation activation, so don't hijack
    // this window into the conversations route — doing so would unmount whatever
    // non-conversation view it's on (e.g. the Automations editor + unsaved
    // edits). Local activations leave the flag false and switch as before.
    if (consumeRemoteActivation()) return
    openConversations()
  }, [activeTabId, openConversations, consumeRemoteActivation])
  return null
}

function WorkspaceLayoutInner({ children }: { children: React.ReactNode }) {
  return (
    <AppWorkspaceProvider>
      <AlertProvider>
        <GitCredentialProvider>
          <TaskProvider>
            <AcpConnectionsProvider>
              <DelegationProvider>
                <ConversationStatusEventBridge />
                <ConversationRuntimeProvider>
                  <WorkspaceProvider>
                    <TabProvider>
                      <WorkspaceDocumentTitle />
                      <TabKeysSync />
                      <BrowserEventsBridge />
                      {/* Beside the events bridge and not inside it: that one
                          stops where no built-in browser exists, and a local
                          server is worth hearing about in web mode too (the
                          port bridge can show it). */}
                      <BrowserServiceBridge />
                      {/* Mounted beside the bridge, not inside a tab: the tab
                          an agent asks to run code on is usually not the one
                          the person is looking at. */}
                      <BrowserEvalConfirm />
                      {/* Here and not in the browser tab it is opened from:
                          only the tab on screen is mounted, and a tab opening
                          on its own would take the marks with it. */}
                      <BrowserScreenshotMarkupHost />
                      <BrowserTabsPersistence />
                      <BrowserTabsSuspender />
                      <HeavyPluginsWarmup />
                      <DeepLinkBootstrap />
                      <PetFocusBridge />
                      {/* Always mounted: external-change conflicts must be
                            resolvable even with the aux file tree closed. */}
                      <ExternalConflictDialog />
                      <SidebarProvider>
                        <AuxPanelProvider>
                          <TerminalProvider>
                            <SearchDialogProvider>
                              <AutomationsViewProvider>
                                <TasksViewProvider>
                                  <WorkbenchRouteProvider>
                                    <WorkbenchRouteConversationSync />
                                    {/* Inside WorkbenchRouteProvider: the
                                          listener calls openConversations() to
                                          surface a launcher-opened folder. */}
                                    <WorkspaceOpenFolderListener />
                                    <FolderLayoutShell>
                                      {children}
                                    </FolderLayoutShell>
                                  </WorkbenchRouteProvider>
                                </TasksViewProvider>
                              </AutomationsViewProvider>
                            </SearchDialogProvider>
                          </TerminalProvider>
                        </AuxPanelProvider>
                      </SidebarProvider>
                    </TabProvider>
                  </WorkspaceProvider>
                </ConversationRuntimeProvider>
              </DelegationProvider>
            </AcpConnectionsProvider>
          </TaskProvider>
        </GitCredentialProvider>
      </AlertProvider>
    </AppWorkspaceProvider>
  )
}

export default function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <Suspense>
      <RemoteConnectionGate>
        <UpdateProvider>
          <WorkspaceLayoutInner>{children}</WorkspaceLayoutInner>
        </UpdateProvider>
      </RemoteConnectionGate>
    </Suspense>
  )
}
