"use client"

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Reorder } from "motion/react"
import {
  Bot,
  FileText,
  GitCompare,
  Maximize2,
  Minimize2,
  Plus,
  ServerCog,
  X,
  Globe,
} from "lucide-react"
import { useTranslations } from "next-intl"
import {
  useWorkspaceActions,
  useWorkspaceFileTabs,
  useWorkspaceView,
} from "@/contexts/workspace-context"
import { AGENT_MARK } from "@/components/browser/browser-agent-access"
import { browserListServices } from "@/lib/browser/browser-api"
import { useBrowserTabState } from "@/lib/browser/browser-tab-store"
import {
  BLANK_PAGE_URL,
  displayHostPort,
  isBlankPageUrl,
} from "@/lib/browser/browser-url"
import type { DetectedService } from "@/lib/browser/types"
import { useBrowserCapabilities } from "@/lib/browser/use-browser-capabilities"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import { useIsCoarsePointer } from "@/hooks/use-is-coarse-pointer"
import { useLongPressDrag } from "@/hooks/use-long-press-drag"
import { normalizeAbsPath } from "@/lib/file-open-target"
import { extractHtmlTitle } from "@/lib/html-preview-inline"
import { isHtmlPreviewable } from "@/lib/language-detect"
import { openFileDialog } from "@/lib/platform"
import { isDesktop, isRemoteDesktopMode } from "@/lib/transport"
import { cn, handleMiddleClickClose } from "@/lib/utils"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/**
 * The strip's own icon buttons ("+" and maximize/restore), copied from the
 * conversation strip's new-conversation button (`tabs/tab-bar.tsx`) so the two
 * strips read as one piece of chrome: a circular ghost button evenly inset
 * from the strip's edges, with the adaptive `bg-foreground/10` hover tint and
 * `backdrop-blur-sm` so the fill reads as frosted glass over a workspace
 * background image rather than a muddy patch.
 *
 * `self-start` — NOT `self-center` — is what centers these. The trailing box
 * they sit in is shortened by the group's `pt-1.5`, so `self-center` centers
 * an `h-7` button in 34px and lands it 3px BELOW the strip midline (the tab
 * labels' line); seating it against the top instead yields an equal 6px above
 * and below, putting its centre back on that midline.
 */
const STRIP_ICON_BTN =
  "flex h-7 w-7 shrink-0 items-center justify-center self-start rounded-full text-muted-foreground backdrop-blur-sm transition-colors hover:bg-foreground/10 hover:text-foreground"

// Rendered only inside the desktop file-column title strip (embedded). The old
// standalone mobile variant is gone — mobile shows the FileWorkspaceHeader
// (folder › file breadcrumb) instead and opens files from the file tree.
export function FileWorkspaceTabBar() {
  const t = useTranslations("Folder.fileWorkspace")
  const { mode, filesMaximized } = useWorkspaceView()
  const { fileTabs, activeFileTabId, previewFileTabIds } =
    useWorkspaceFileTabs()
  const {
    switchFileTab,
    closeFileTab,
    closeOtherFileTabs,
    closeAllFileTabs,
    reorderFileTabs,
    toggleFilesMaximized,
  } = useWorkspaceActions()
  const scrollRef = useRef<HTMLDivElement>(null)
  const isCoarsePointer = useIsCoarsePointer()
  const [touchSortingTabId, setTouchSortingTabId] = useState<string | null>(
    null
  )

  useEffect(() => {
    if (!activeFileTabId || !scrollRef.current) return
    const el = scrollRef.current.querySelector(
      `[data-file-tab-id="${activeFileTabId}"]`
    )
    el?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [activeFileTabId])

  const handleReorder = useCallback(
    (nextTabs: FileWorkspaceTab[]) => {
      if (isCoarsePointer && !touchSortingTabId) return
      reorderFileTabs(nextTabs)
    },
    [isCoarsePointer, reorderFileTabs, touchSortingTabId]
  )

  const handleTouchSortingEnd = useCallback(
    () => setTouchSortingTabId(null),
    []
  )

  const activeFileIndex = fileTabs.findIndex(
    (tab) => tab.id === activeFileTabId
  )
  const lastTabActive =
    activeFileIndex >= 0 && activeFileIndex === fileTabs.length - 1

  if (fileTabs.length === 0) return null

  return (
    <Reorder.Group
      as="div"
      ref={scrollRef}
      role="tablist"
      axis="x"
      values={fileTabs}
      onReorder={handleReorder}
      // Tabs shrink browser-style and sit flush (`gap-0`) so their hairline
      // separators read as dividers (see FileWorkspaceTabItem); no scrollbar
      // (`overflow-hidden` still scrolls programmatically) and no bottom padding
      // so they reach the strip's bottom and the active (white) tab merges into
      // the file detail header below. Like the conversation strip (tab-bar.tsx)
      // it hosts the trailing drag spacer + maximize button as its own last
      // children, so tabs and trailing area size in ONE flex line.
      //
      // `flex-1` + `pl-2` (NOT an auto width, NOT `px-2`) are load-bearing: an
      // auto-width flex container is sized from its max-content, and WebKit
      // derives a fixed-basis item's max-content contribution from the item's
      // CONTENT rather than its `basis-48`. A long tab title (diff tabs, e.g.
      // "差异 · some-long-name.tsx") therefore stretched the group tens of px
      // wider than its tabs, and that leftover strip — owned by the group, which
      // carries no `ws-strip-line` — punched a hole in the strip's bottom
      // hairline right of the tab. Sizing by flex instead of by content, with the
      // trailing wrapper owning every leftover pixel, keeps the line unbroken in
      // both engines. `pl-2` keeps the first tab's left gutter (for the
      // first-child seam patch) while leaving NO right padding, so the wrapper's
      // `ws-strip-line` reaches the group's right edge.
      className="pt-1.5 pl-2 flex h-full min-w-0 flex-1 items-stretch gap-0 overflow-hidden"
    >
      {fileTabs.map((tab, index) => (
        <FileWorkspaceTabItem
          key={tab.id}
          tab={tab}
          active={tab.id === activeFileTabId}
          adjacentActive={
            activeFileIndex < 0
              ? undefined
              : index === activeFileIndex - 1
                ? "before"
                : index === activeFileIndex + 1
                  ? "after"
                  : undefined
          }
          embedded
          previewing={previewFileTabIds.has(tab.id)}
          closeLabel={t("closeFileTab")}
          closeText={t("close")}
          closeOthersText={t("closeOthers")}
          closeAllText={t("closeAll")}
          isCoarsePointer={isCoarsePointer}
          isTouchSorting={touchSortingTabId === tab.id}
          onSwitch={switchFileTab}
          onClose={closeFileTab}
          onCloseOthers={closeOtherFileTabs}
          onCloseAll={closeAllFileTabs}
          onTouchSortingStart={setTouchSortingTabId}
          onTouchSortingEnd={handleTouchSortingEnd}
        />
      ))}
      {/* Trailing area: a drag spacer fills the leftover row (window-drag region)
          and, in fusion, a maximize/restore button sits flush right (it used to
          live in the file detail header). They are the group's own trailing
          children but NOT Reorder.Items, so dragging a tab only ever permutes the
          tabs. Wrapped in one `flex-1` box so the workspace-bg bottom hairline
          (ws-strip-line) runs unbroken under both. NO `min-w-0`: the wrapper's
          min-content (the spacer's `min-w-10` + the shrink-0 button) is its floor,
          so under many-tab overflow the tabs shrink to reserve them instead of the
          wrapper collapsing to 0. `relative` + `data-adjacent-active` anchor the
          inset baseline (globals.css `.ws-strip-line::after`) used when the LAST
          tab is active: its transparent reverse-corner foot flares 0.5rem over
          this wrapper, and a full-width border-bottom would show through under
          that foot. */}
      <div
        data-adjacent-active={lastTabActive ? "after" : undefined}
        className="relative flex h-full flex-1 items-stretch ws-strip-line"
      >
        {/* "+" sits flush against the last tab (before the drag spacer), the
            way the conversation strip's new-tab button follows its tabs. */}
        <FileTabAddMenu />
        {/* Drag spacer, floored at `min-w-10` (40px): even when many tabs overflow
            and squeeze this region, a grabbable window-drag gap always remains
            between the last tab and the maximize button. */}
        <div data-tauri-drag-region className="h-full min-w-10 flex-1" />
        {mode === "fusion" && (
          <button
            type="button"
            onClick={toggleFilesMaximized}
            className={cn(
              STRIP_ICON_BTN,
              "mr-1.5",
              filesMaximized && "text-primary"
            )}
            aria-label={filesMaximized ? t("restore") : t("maximize")}
            aria-pressed={filesMaximized}
            title={filesMaximized ? t("restore") : t("maximize")}
          >
            {filesMaximized ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>
    </Reorder.Group>
  )
}

/**
 * The "+" at the end of the file tab strip: the tabs a person can add to this
 * strip by hand.
 *
 * All of them already exist elsewhere, but none is reachable *from here*. A
 * file otherwise arrives from the aux-panel file tree or a transcript badge —
 * both of which can be closed or absent — and a browser tab had no manual
 * entry point at all: every one of them arrived by following a link, so there
 * was no way to simply open a page. The blank page is exactly that (see
 * `BLANK_PAGE_URL`): an empty tab with a focused address bar.
 *
 * The local servers below them are the ones codeg has watched start in its
 * terminals (`browser::services`), listed fresh every time the menu opens:
 * the backend connects to each one while answering, so an address here is an
 * address that was answering a moment ago. This is the entry point for
 * everyone who left the notification off, and the way back to a page that was
 * offered and dismissed.
 *
 * Renders nothing when no row is possible rather than an empty menu — off the
 * desktop there is no built-in browser, and a native picker is no use to a
 * window driving a remote backend.
 */
function FileTabAddMenu() {
  const t = useTranslations("Folder.fileWorkspace")
  const { openFilePreview, openBrowserTab } = useWorkspaceActions()
  const capabilities = useBrowserCapabilities()
  const [services, setServices] = useState<readonly DetectedService[]>([])

  // A native dialog picks a path on THIS machine; a desktop window driving a
  // remote backend would hand the server a path it cannot read, and the web
  // fallback only ever learns a bare file name (same test as add-node-menu).
  const canOpenFile = isDesktop() && !isRemoteDesktopMode()
  // Web mode answers "unavailable" without a round trip, so this is false
  // there from the first render rather than after a flash.
  const canOpenBrowser = capabilities?.available ?? false

  const handleOpenFile = useCallback(async () => {
    const picked = await openFileDialog({ title: t("openFileTitle") }).catch(
      () => null
    )
    const path = Array.isArray(picked) ? picked[0] : picked
    // `openFilePreview` reports a failed read on the tab itself, so a
    // rejection here is only ever the dialog being dismissed.
    if (path) void openFilePreview(normalizeAbsPath(path))
  }, [openFilePreview, t])

  // Asked on every open, not held: a server that has stopped must not be
  // offered, and the backend's answer already excludes those. The previous
  // answer stays on screen until the new one lands (they are the same list
  // in the overwhelming majority of cases) and an error empties it rather
  // than showing addresses nobody vouched for.
  const handleOpenChange = useCallback(
    (open: boolean) => {
      // The servers this computer's terminals started. A window bound to a
      // remote codeg-server runs its terminals there, so none of these is
      // one of its own — and `localhost` in its list would be ambiguous.
      if (!open || !canOpenBrowser || isRemoteDesktopMode()) return
      void browserListServices()
        .then(setServices)
        .catch(() => setServices([]))
    },
    [canOpenBrowser]
  )

  if (!canOpenFile && !canOpenBrowser) return null

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          // `ml-1.5 mr-0.5` are the conversation new-tab button's own gaps: a
          // 6px gutter from the last tab's edge so the round hover fill never
          // touches it. `shrink-0` (in STRIP_ICON_BTN) keeps this button, with
          // the drag spacer's `min-w-10`, part of the trailing wrapper's
          // min-content floor, so overflowing tabs shrink to reserve it
          // instead of it being squeezed away.
          className={cn(STRIP_ICON_BTN, "ml-1.5 mr-0.5")}
          aria-label={t("newTab")}
          title={t("newTab")}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-44">
        {canOpenBrowser && (
          <DropdownMenuItem
            onSelect={() => {
              openBrowserTab(BLANK_PAGE_URL)
            }}
          >
            <Globe />
            {t("newBrowserTab")}
          </DropdownMenuItem>
        )}
        {canOpenFile && (
          <DropdownMenuItem onSelect={() => void handleOpenFile()}>
            <FileText />
            {t("openFile")}
          </DropdownMenuItem>
        )}
        {canOpenBrowser && services.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("localServices")}</DropdownMenuLabel>
            {services.map((service) => (
              <DropdownMenuItem
                key={service.origin}
                onSelect={() => {
                  openBrowserTab(service.url)
                }}
              >
                <ServerCog />
                <span className="min-w-0 flex-1 truncate">
                  {displayHostPort(service.url) ?? service.url}
                </span>
                {service.source === "agent" && (
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {t("localServiceFromAgent")}
                  </span>
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface FileWorkspaceTabItemProps {
  tab: FileWorkspaceTab
  active: boolean
  /** Whether this tab immediately precedes/follows the active tab — lets the
   *  neighbour inset its workspace-bg baseline so the active tab's transparent
   *  reverse-corner foot (which flares over it) leaves no stray line. */
  adjacentActive?: "before" | "after"
  embedded: boolean
  /** The tab is showing the rendered document rather than its source — what
   *  lets an HTML tab be named by the page instead of by the file. */
  previewing: boolean
  closeLabel: string
  closeText: string
  closeOthersText: string
  closeAllText: string
  isCoarsePointer: boolean
  isTouchSorting: boolean
  onSwitch: (tabId: string) => void
  onClose: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseAll: () => void
  onTouchSortingStart: (tabId: string) => void
  onTouchSortingEnd: () => void
}

const FileWorkspaceTabItem = memo(function FileWorkspaceTabItem({
  tab,
  active,
  adjacentActive,
  embedded,
  previewing,
  closeLabel,
  closeText,
  closeOthersText,
  closeAllText,
  isCoarsePointer,
  isTouchSorting,
  onSwitch,
  onClose,
  onCloseOthers,
  onCloseAll,
  onTouchSortingStart,
  onTouchSortingEnd,
}: FileWorkspaceTabItemProps) {
  const tAgent = useTranslations("Browser.agent")
  const tBrowserTab = useTranslations("Browser.tab")
  const isDiff = tab.kind === "diff" || tab.kind === "rich-diff"
  const isBrowser = tab.kind === "browser"
  const isDirty = tab.kind === "file" && Boolean(tab.isDirty)
  // A browser tab's title follows the page (document.title); the record only
  // knows the host it was opened with.
  const browserState = useBrowserTabState(isBrowser ? tab.id : null)
  // No live state = no page behind the tab yet: restored from a previous run
  // or unloaded in the background; it loads when switched to. Drawn faded,
  // the way browsers draw a discarded tab.
  const unloaded = isBrowser && !browserState
  const browserUrl = isBrowser
    ? browserState?.url || tab.browser.initialUrl
    : null
  // An empty tab names itself ("New tab") and has no address worth showing:
  // `about:blank` is the absence of a page, not one the user navigated to.
  const blankPage = browserUrl !== null && isBlankPageUrl(browserUrl)
  // What to call it, most specific first: the live page's own title, then the
  // record's. Except that a tab opened empty took `about:blank` for its
  // record title — a record is named once, and the address had no host to
  // offer for the blank page — so the moment it goes somewhere, that title
  // names the wrong page. The host stands in until the page says its own,
  // which also covers the stretch of every navigation where the backend has
  // cleared the live title and `title_changed` has not fired yet.
  const recordTitle = isBlankPageUrl(tab.title) ? null : tab.title
  // Host and port, the same answer the record is named with, so a page that
  // loses its title mid-navigation does not also change what it is called.
  const browserHost = browserUrl ? displayHostPort(browserUrl) : null
  // An HTML file being previewed is named the way a browser names a page: by
  // the document's own <title>, the file name behind it on hover. Read from
  // the tab's source rather than from the rendered document, so it is the same
  // answer for both renderers (inline iframe / document guest), it is there
  // before anything loads, and a background tab has it too. Empty (no <title>
  // element, or the tab is showing source) = the file name, as before.
  const htmlTitle = useMemo(
    () =>
      previewing && tab.kind === "file" && isHtmlPreviewable(tab.path)
        ? extractHtmlTitle(tab.content ?? "")
        : "",
    [previewing, tab.content, tab.kind, tab.path]
  )
  const displayTitle = isBrowser
    ? browserState?.title ||
      (blankPage
        ? tBrowserTab("untitled")
        : (recordTitle ?? browserHost ?? tab.title))
    : htmlTitle || tab.title
  const sharedWith = browserState?.agentGrant?.origin ?? null
  // A browser tab is the one kind whose label is always truncated (a page
  // title is a sentence, not a filename) AND whose address is not shown
  // anywhere in the strip, so hovering gives both — title first, then the
  // address it is on, one per line. A previewed HTML file is in the same
  // position and gets the same two lines, its path standing in for the address.
  const displayHint = isBrowser
    ? [
        displayTitle,
        blankPage ? null : browserUrl,
        sharedWith && tAgent("shared"),
      ]
        .filter(Boolean)
        .join("\n")
    : htmlTitle
      ? [htmlTitle, tab.description ?? tab.path].filter(Boolean).join("\n")
      : (tab.description ?? tab.title)

  const handleLongPressStart = useCallback(
    () => onTouchSortingStart(tab.id),
    [onTouchSortingStart, tab.id]
  )

  const { dragControls, gestureHandlers } = useLongPressDrag({
    enabled: isCoarsePointer,
    onStart: handleLongPressStart,
    onEnd: onTouchSortingEnd,
  })

  const handleSwitch = useCallback(() => {
    onSwitch(tab.id)
  }, [onSwitch, tab.id])

  const whileDrag = useMemo(() => ({ scale: 1.03 }), [])

  return (
    <Reorder.Item
      as="div"
      value={tab}
      data-file-tab-id={tab.id}
      drag="x"
      dragControls={dragControls}
      dragListener={!isCoarsePointer}
      whileDrag={whileDrag}
      {...gestureHandlers}
      data-tab-item
      data-active={embedded && active ? "true" : undefined}
      data-adjacent-active={embedded ? adjacentActive : undefined}
      className={cn(
        "cursor-grab active:cursor-grabbing",
        // Embedded (browser-style): every tab is EQUAL width (`basis-48` = 12rem,
        // `grow-0` so they don't stretch to fill) — a long filename and a short one
        // read uniform instead of one wide / one narrow. They still `shrink`
        // together (down to `min-w-0`, the label fades) once the row fills; above
        // that the fixed basis keeps them equal. Leftover row stays a window-drag
        // region. `browser-tab-item` draws the left-edge hairline separator
        // (globals.css) as a 1px divider at each shared edge — tabs sit flush (no
        // gutter) so the line is the only separation, and the inner row owns its
        // own `overflow-hidden`. The active tab is raised (`z-10`) so its
        // reverse-corner seat is never covered by a hovered neighbour's flare.
        // Standalone: rounded pill, intrinsic width (scroll).
        embedded
          ? "browser-tab-item min-w-0 grow-0 shrink basis-48 data-[active=true]:z-10"
          : "rounded-full shrink-0",
        isTouchSorting && "z-50 opacity-90 shadow-md ring-1 ring-primary/25"
      )}
    >
      {/* Reverse (concave) bottom corners — the browser-tab seat (globals.css).
          Absolute + decorative, so it never affects layout. Rendered for every
          embedded tab; CSS reveals it when the tab is active or hovered. */}
      {embedded && <span aria-hidden className="browser-tab-seat" />}
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={isTouchSorting}>
          <div
            role="tab"
            aria-selected={active}
            onClick={handleSwitch}
            onMouseDown={(event) =>
              handleMiddleClickClose(event, () => onClose(tab.id))
            }
            className={cn(
              "group/filetab relative flex items-center h-full gap-1.5 text-xs",
              "cursor-pointer select-none transition-colors",
              embedded
                ? [
                    // Browser-style tab: white (bg-background) active fill,
                    // rounded top, reaching the strip's bottom so it merges into
                    // the file detail header below. With a workspace background
                    // image on, the whole strip + all tabs go transparent (reveal
                    // the image); a hairline bottom border (ws-strip-line) runs
                    // under every non-active region while the active tab omits it
                    // and instead is outlined by a top+side "archway" (the
                    // browser-tab-item `::after`, globals.css) whose reverse-corner
                    // feet (browser-tab-seat) drop back onto that line — a gap the
                    // border detours around, not a filled
                    // box. `overflow-hidden` clips the
                    // shrunken row. `pb-1.5` balances the group's `pt-1.5` gap so
                    // the content centers on the h-10 strip midline, not 3px low
                    // in the shorter tab box (fill still reaches the bottom).
                    // `browser-tab-content` anchors the label's state-driven fade
                    // (globals.css `.browser-tab-content:hover` widens the mask so
                    // the close button never covers the title).
                    "browser-tab-content w-full min-w-0 overflow-hidden rounded-t-lg px-2 pb-1.5",
                    active
                      ? "bg-background ws-transparent-bg text-foreground"
                      : "isolate browser-tab-hover text-muted-foreground hover:text-foreground ws-strip-line",
                  ]
                : [
                    "shrink-0 rounded-full px-3 hover:bg-primary/8",
                    active
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground",
                  ]
            )}
            title={displayHint}
          >
            {isBrowser && sharedWith ? (
              // A shared tab says so from the strip, not only from inside
              // itself: the page an agent is reading is often not the one the
              // user is looking at. Replaces the globe rather than joining it
              // — "an agent can read this" is the fact worth a glyph here,
              // and the title and address already say it is a web page.
              <Bot
                className={cn("h-3.5 w-3.5 shrink-0", AGENT_MARK)}
                data-agent-shared={sharedWith}
              />
            ) : isBrowser ? (
              <Globe
                className={cn("h-3.5 w-3.5", unloaded && "opacity-50")}
                data-unloaded={unloaded ? "true" : undefined}
              />
            ) : isDiff ? (
              <GitCompare className="h-3.5 w-3.5" />
            ) : (
              <FileText className="h-3.5 w-3.5" />
            )}
            <span
              className={cn(
                // Embedded: grow + shrink as the tab tightens, but instead of an
                // ellipsis the overflowing title fades out on the right
                // (browser-tab-label mask), dissolving toward the close button so
                // the full width is used. Standalone: ellipsis cap in the scroll row.
                embedded
                  ? "min-w-0 flex-1 overflow-hidden whitespace-nowrap browser-tab-label"
                  : "truncate max-w-[11.25rem]",
                unloaded && "opacity-60"
              )}
            >
              {displayTitle}
              {isDirty ? " *" : ""}
            </span>
            <button
              type="button"
              className={cn(
                // Round, like the strip's own "+" and maximize buttons.
                "rounded-full hover:bg-foreground/10",
                // Embedded: an absolute overlay pinned to the right edge, so it
                // claims no row space — the label runs the full width and fades
                // under it (browser-tab-label) instead of stopping short of an
                // always-reserved in-flow button. Centered via `top-0 bottom-1.5
                // my-auto` (no transform → crisp on WebKit; `bottom-1.5` mirrors
                // the content's `pb-1.5`). Pointer events are gated off while
                // hidden so it can't eat clicks. Standalone: an in-flow chip.
                embedded
                  ? "absolute right-2 top-0 bottom-1.5 my-auto flex h-4 w-4 items-center justify-center"
                  : "shrink-0 p-0.5",
                active
                  ? "opacity-100"
                  : embedded
                    ? "opacity-0 pointer-events-none group-hover/filetab:opacity-100 group-hover/filetab:pointer-events-auto"
                    : "opacity-0 group-hover/filetab:opacity-100"
              )}
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.id)
              }}
              aria-label={closeLabel}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => onClose(tab.id)}>
            {closeText}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onCloseOthers(tab.id)}>
            {closeOthersText}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onCloseAll}>
            {closeAllText}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </Reorder.Item>
  )
})
