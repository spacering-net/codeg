"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react"
import { Reorder } from "motion/react"
import type { PanInfo } from "motion/react"
import { ArrowDownWideNarrow, SquarePen } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useTabActions, useTabStore } from "@/contexts/tab-context"
import type { TabItem as TabItemData } from "@/contexts/tab-context"
import { groupOfTab } from "@/stores/tab-store"
import {
  firstLeafId,
  leafIds,
  type SplitDirection,
} from "@/lib/tab-group-layout"
import {
  clientPointFromDrag,
  dropIndexFromMidpoints,
} from "@/lib/tab-drag-drop"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useIsCoarsePointer } from "@/hooks/use-is-coarse-pointer"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  STATUS_BAND_COLOR,
  TAB_ARRANGE_MODES,
  arrangeTabs,
  folderAccentColor,
  type TabArrangeMode,
  type TabRun,
  type TabStatusBand,
} from "@/lib/tab-arrangement"
import { folderTitleTintVars } from "@/lib/theme-presets"
import { useTabArrangeStore } from "@/stores/tab-arrangement-store"
import { useTabAttention } from "@/hooks/use-tab-attention"
import { TabItem, type TabMoveTarget } from "./tab-item"

/** i18n keys (Folder.tabs) for the arrange menu and the status band labels.
 *  `as const` keeps them literal: next-intl's `t` is typed against the
 *  message catalogue and rejects a plain `string` key. */
const ARRANGE_MODE_LABEL = {
  manual: { label: "arrangeManual", hint: "arrangeManualHint" },
  folder: { label: "arrangeByFolder", hint: "arrangeByFolderHint" },
  status: { label: "arrangeByStatus", hint: "arrangeByStatusHint" },
} as const satisfies Record<TabArrangeMode, { label: string; hint: string }>
const STATUS_BAND_LABEL = {
  needs_you: "bandNeedsYou",
  awaiting_reply: "bandAwaitingReply",
  running: "bandRunning",
  other: "bandOther",
} as const satisfies Record<TabStatusBand, string>

const NO_TAB_IDS: readonly string[] = []

/** One slot of the strip as displayed: a tab, or (grouped / sorted) the label
 *  ahead of a run. */
type StripEntry =
  | { kind: "label"; runKey: string; count: number }
  | { kind: "tab"; tab: TabItemData }

interface TabBarProps {
  /** Split-group strip: render only this group's tabs, highlight the GROUP's
   *  selected tab, and target new tabs/reorders at the group. Omitted = the
   *  single title-bar strip shown while unsplit. */
  groupId?: string
}

// Rendered inside the desktop conversation-column title strip while unsplit,
// or once per group shell (with `groupId`) while split. The old standalone
// mobile variant is gone — mobile shows the conversation detail header instead
// and navigates tabs from the sidebar.
export function TabBar({ groupId }: TabBarProps) {
  const t = useTranslations("Folder.conversationCard")
  const tTabs = useTranslations("Folder.tabs")
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const groupOf = useTabStore((s) => s.groupOf)
  const groupLayout = useTabStore((s) => s.groupLayout)
  const groupSelection = useTabStore((s) => s.groupSelection)
  const tileByGroup = useTabStore((s) => s.tileByGroup)
  const {
    switchTab,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    pinTab,
    toggleGroupTile,
    splitTab,
    moveTabToGroup,
    toggleGroupOrientation,
    dissolveGroup,
    unsplitAll,
    reorderTabs,
    reorderGroupTabs,
    updateTabDrag,
    endTabDrag,
    openNewConversationTab,
    openChatModeTab,
  } = useTabActions()
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const branches = useAppWorkspaceStore((s) => s.branches)
  const { activeFolder } = useActiveFolder()
  const { openConversations } = useWorkbenchRoute()

  // The group this strip represents (unsplit strip = the single first leaf),
  // its tabs, and its displayed "active" tab: the GROUP's selected tab — for
  // the focused group (and the unsplit strip) that IS the global active tab.
  const stripGroupId = groupId ?? firstLeafId(groupLayout)
  const groupTabs = useMemo(
    () =>
      groupId == null
        ? tabs
        : tabs.filter(
            (tab) => groupOfTab(groupOf, groupLayout, tab.id) === groupId
          ),
    [tabs, groupId, groupOf, groupLayout]
  )
  const displayActiveId =
    groupId == null ? activeTabId : (groupSelection[groupId] ?? null)

  // Display arrangement (manual / grouped by folder / sorted by status). Pure
  // presentation over `groupTabs`: the manual order underneath is untouched and
  // comes back as-is on `manual`. Every strip (split groups included) follows
  // the one per-device choice.
  const arrangeMode = useTabArrangeStore((s) => s.mode)
  const setArrangeMode = useTabArrangeStore((s) => s.setMode)
  useEffect(() => {
    useTabArrangeStore.getState().hydrate()
  }, [])
  const isManualOrder = arrangeMode === "manual"
  // Which tabs wait on the user (permission / question / plan approval), read
  // from their live connections. Only the status sort uses it, so the other
  // layouts don't subscribe to any connection.
  const attentionTabIds = useMemo(
    () =>
      arrangeMode === "status" ? groupTabs.map((tab) => tab.id) : NO_TAB_IDS,
    [arrangeMode, groupTabs]
  )
  const attentionByTabId = useTabAttention(attentionTabIds)
  const arranged = useMemo(
    () => arrangeTabs(groupTabs, arrangeMode, attentionByTabId),
    [groupTabs, arrangeMode, attentionByTabId]
  )
  const displayTabs = arranged.ordered
  const isTileMode = !!tileByGroup[stripGroupId]
  const handleToggleTile = useCallback(
    () => toggleGroupTile(stripGroupId),
    [toggleGroupTile, stripGroupId]
  )

  // Split-group context-menu wiring, shared by every tab in this strip.
  const orderedLeaves = useMemo(() => leafIds(groupLayout), [groupLayout])
  const isSplit = orderedLeaves.length > 1
  const canSplitMove = groupTabs.length >= 2
  const moveTargets = useMemo<TabMoveTarget[]>(() => {
    if (!isSplit) return []
    return orderedLeaves
      .map((leafId, index) => ({
        groupId: leafId,
        index: index + 1,
        title:
          tabs.find((tab) => tab.id === groupSelection[leafId])?.title ?? null,
      }))
      .filter((target) => target.groupId !== stripGroupId)
  }, [isSplit, orderedLeaves, tabs, groupSelection, stripGroupId])
  const handleSplit = useCallback(
    (tabId: string, direction: SplitDirection, move: boolean) =>
      splitTab(tabId, direction, { move }),
    [splitTab]
  )
  const handleToggleSplitOrientation = useCallback(
    () => toggleGroupOrientation(stripGroupId),
    [toggleGroupOrientation, stripGroupId]
  )
  const handleUnsplit = useCallback(
    () => dissolveGroup(stripGroupId),
    [dissolveGroup, stripGroupId]
  )

  // ── Cross-group drag & drop (split-group strips only) ────────────────────
  // The dragged tab itself is axis-locked to its own strip (Reorder drag="x" +
  // overflow clipping), so crossing groups is pointer-based: hit-test the
  // element under the cursor for another group's strip or shell, highlight it,
  // and commit the move on release. Same-group hits resolve to null — a drop
  // there is just the ordinary within-strip reorder.
  const isDropTarget = useTabStore(
    (s) => groupId != null && s.tabDrag?.overGroupId === groupId
  )
  const resolveDropTarget = useCallback(
    (
      clientX: number,
      clientY: number
    ): { gid: string; el: Element; strip: boolean } | null => {
      if (groupId == null) return null
      const el = document.elementFromPoint(clientX, clientY)
      if (!el) return null
      const strip = el.closest("[data-conv-group-strip]")
      if (strip) {
        const gid = strip.getAttribute("data-conv-group-strip")
        return gid && gid !== groupId ? { gid, el: strip, strip: true } : null
      }
      const shell = el.closest("[data-conv-group-shell]")
      if (shell) {
        const gid = shell.getAttribute("data-conv-group-shell")
        return gid && gid !== groupId ? { gid, el: shell, strip: false } : null
      }
      return null
    },
    [groupId]
  )
  const handleTabDrag = useCallback(
    (
      tab: TabItemData,
      event: MouseEvent | TouchEvent | PointerEvent,
      info: PanInfo
    ) => {
      const { x, y } = clientPointFromDrag(event, info)
      const target = resolveDropTarget(x, y)
      updateTabDrag({
        tabId: tab.id,
        title: tab.title,
        x,
        y,
        overGroupId: target?.gid ?? null,
      })
    },
    [resolveDropTarget, updateTabDrag]
  )
  const handleTabDragEnd = useCallback(
    (
      tab: TabItemData,
      event: MouseEvent | TouchEvent | PointerEvent,
      info: PanInfo
    ) => {
      const { x, y } = clientPointFromDrag(event, info)
      const target = resolveDropTarget(x, y)
      endTabDrag()
      if (!target) return
      // Strip drop: land at the cursor position (midpoint count). Shell-body
      // drop: append (the store clamps the oversized index to the tail).
      const index = target.strip
        ? dropIndexFromMidpoints(
            x,
            Array.from(target.el.querySelectorAll("[data-tab-id]")).map(
              (tabEl) => {
                const rect = tabEl.getBoundingClientRect()
                return rect.left + rect.width / 2
              }
            )
          )
        : Number.MAX_SAFE_INTEGER
      moveTabToGroup(tab.id, target.gid, { index })
    },
    [resolveDropTarget, endTabDrag, moveTabToGroup]
  )
  // Dragging only makes sense in manual order: grouped / sorted layouts are
  // derived, so a drop would have no coherent order to write back.
  const crossDragEnabled = groupId != null && isSplit && isManualOrder

  // New-conversation affordance at the end of the tab strip. Mirrors the
  // sidebar's "New chat": return to the conversation workspace, then open a
  // draft — or a folderless chat when no context resolves, so the button is
  // never a dead end. Group strips seed from the GROUP's own selection (its
  // folder / chat mode) rather than the globally-active folder: each group is
  // its own workspace slice, and the focused group may be a different one.
  const handleNewConversation = useCallback(() => {
    openConversations()
    const groupOptions = groupId != null ? { targetGroup: groupId } : undefined
    if (groupId != null) {
      const selTab =
        groupTabs.find((tab) => tab.id === displayActiveId) ?? groupTabs[0]
      const selFolder = selTab
        ? allFolders.find((f) => f.id === selTab.folderId)
        : undefined
      if (selTab?.isChat === true || selFolder?.kind === "chat") {
        openChatModeTab(groupOptions)
        return
      }
      if (selTab && selFolder) {
        openNewConversationTab(
          selFolder.id,
          selTab.workingDir ?? selFolder.path,
          groupOptions
        )
        return
      }
      // Group context unresolvable (folder deleted) — fall through to the
      // active-folder default.
    }
    if (!activeFolder) {
      openChatModeTab(groupOptions)
      return
    }
    openNewConversationTab(activeFolder.id, activeFolder.path, groupOptions)
  }, [
    activeFolder,
    allFolders,
    displayActiveId,
    groupId,
    groupTabs,
    openChatModeTab,
    openConversations,
    openNewConversationTab,
  ])

  const folderIndex = useMemo(() => {
    const map = new Map<
      number,
      { name: string; alias: string | null; color: string; isChat: boolean }
    >()
    for (const f of allFolders) {
      map.set(f.id, {
        name: f.name,
        alias: f.alias,
        color: f.color,
        isChat: f.kind === "chat",
      })
    }
    return map
  }, [allFolders])

  // Label + stable tint per group run (folder color, or the status band's), and
  // each tab's run. Stable objects: TabItem is memoized on `accentStyle`.
  const runVisuals = useMemo(() => {
    const byRun = new Map<
      string,
      { label: string; style: CSSProperties | undefined }
    >()
    const runOfTab = new Map<string, string>()
    for (const run of arranged.runs ?? []) {
      byRun.set(run.key, runVisual(run))
      for (const tab of run.tabs) runOfTab.set(tab.id, run.key)
    }
    return { byRun, runOfTab }

    function runVisual(run: TabRun<TabItemData>) {
      if (run.kind === "status") {
        const color = STATUS_BAND_COLOR[run.band]
        return {
          label: tTabs(STATUS_BAND_LABEL[run.band]),
          style: color ? folderTitleTintVars(color) : undefined,
        }
      }
      const folder = folderIndex.get(run.folderId)
      return {
        label: folder?.isChat
          ? tTabs("chatGroup")
          : folder?.alias || folder?.name || String(run.folderId),
        style: folderTitleTintVars(
          folderAccentColor(run.folderId, folder?.color)
        ),
      }
    }
  }, [arranged.runs, folderIndex, tTabs])

  const scrollRef = useRef<HTMLDivElement>(null)
  const isCoarsePointer = useIsCoarsePointer()
  const [touchSortingTabId, setTouchSortingTabId] = useState<string | null>(
    null
  )

  // The strip as displayed: tabs, with a group label ahead of each run while
  // grouped / sorted. Adjacency to the active tab is computed over THIS
  // sequence, so a label flanking the active tab gets the same baseline inset a
  // neighbouring tab would (`data-adjacent-active`, globals.css).
  const entries = useMemo<StripEntry[]>(
    () =>
      arranged.runs
        ? arranged.runs.flatMap((run): StripEntry[] => [
            { kind: "label", runKey: run.key, count: run.tabs.length },
            ...run.tabs.map((tab) => ({ kind: "tab" as const, tab })),
          ])
        : arranged.ordered.map((tab) => ({ kind: "tab" as const, tab })),
    [arranged]
  )
  const activePos = entries.findIndex(
    (e) => e.kind === "tab" && e.tab.id === displayActiveId
  )
  // Keep the active tab in view. A derived layout can move it without changing
  // its id (switching the arrangement, or the tab changing status band), so the
  // reveal also re-runs on the mode and, outside manual order, on the active
  // tab's displayed slot. In manual order the active tab only moves under the
  // user's own drag, which must not scroll the strip mid-gesture. A layout
  // effect, so it measures the new layout before motion's layout animation
  // (scheduled after this commit) shifts moved tabs back to their old spots.
  const activeSlot = isManualOrder ? -1 : activePos
  useLayoutEffect(() => {
    if (!displayActiveId || !scrollRef.current) return
    const el = scrollRef.current.querySelector(
      `[data-tab-id="${displayActiveId}"]`
    )
    el?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [displayActiveId, arrangeMode, activeSlot])

  const handleReorder = useCallback(
    (nextTabs: TabItemData[]) => {
      if (!isManualOrder) return
      if (isCoarsePointer && !touchSortingTabId) return
      if (groupId == null) {
        reorderTabs(nextTabs)
      } else {
        reorderGroupTabs(groupId, nextTabs)
      }
    },
    [
      groupId,
      isCoarsePointer,
      isManualOrder,
      reorderGroupTabs,
      reorderTabs,
      touchSortingTabId,
    ]
  )

  const handleTouchSortingEnd = useCallback(
    () => setTouchSortingTabId(null),
    []
  )

  if (groupTabs.length === 0) return null

  const adjacencyAt = (pos: number): "before" | "after" | undefined =>
    activePos < 0
      ? undefined
      : pos === activePos - 1
        ? "before"
        : pos === activePos + 1
          ? "after"
          : undefined
  // When the LAST entry is the active tab, the trailing new-conversation
  // wrapper is its right neighbour — it needs the same baseline inset a tab
  // neighbour gets, so the active tab's right reverse-corner foot doesn't leave
  // a stray line poking out from under it (globals.css).
  const lastTabActive = activePos >= 0 && activePos === entries.length - 1

  return (
    <Reorder.Group
      as="div"
      ref={scrollRef}
      role="tablist"
      axis="x"
      values={displayTabs as TabItemData[]}
      onReorder={handleReorder}
      // Cross-group drop target: group strips advertise their group id for the
      // drag hit-test and tint while a foreign tab hovers.
      data-conv-group-strip={groupId ?? undefined}
      // Fills the title-bar strip and shrinks browser-style to share the row (see
      // TabItem): flush (`gap-0`) so hairline separators read as dividers, no
      // scrollbar (`overflow-hidden` still scrolls programmatically), and no
      // bottom border so the active (white) tab merges into the detail header
      // below. It hosts the trailing new-conversation button + drag spacer as its
      // own last children so the tabs, button, and spacer size in ONE flex line:
      // the tabs keep their equal `basis-48` width until the row fills, then
      // shrink together, and the button always hugs the last tab. `pl-2` only
      // (NOT `px-2`): the first tab keeps its left gutter for the first-child
      // seam-patch, but there's NO right padding so the trailing wrapper's
      // `ws-strip-line` reaches the group's right edge and the bottom hairline
      // stays continuous into the right reserve.
      className={cn(
        "pt-1.5 flex h-full min-w-0 flex-1 items-stretch gap-0 overflow-hidden pl-2",
        isDropTarget && "bg-primary/8"
      )}
    >
      {entries.map((entry, pos) => {
        if (entry.kind === "label") {
          const visual = runVisuals.byRun.get(entry.runKey)
          return (
            <div
              key={`group-label-${entry.runKey}`}
              data-tab-group-label={entry.runKey}
              data-adjacent-active={adjacencyAt(pos)}
              // Sits in the tabs' flex line and carries the strip's bottom
              // hairline like they do; `relative` anchors the inset-baseline
              // pseudo-element used next to the active tab.
              className="relative flex h-full shrink-0 items-center pl-1.5 pr-1 pb-1.5 ws-strip-line"
            >
              <span
                className={cn(
                  "flex max-w-[9rem] items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.6875rem] leading-none font-medium",
                  visual?.style
                    ? "folder-title-tint bg-current/10"
                    : "bg-muted text-muted-foreground"
                )}
                style={visual?.style}
                title={`${visual?.label ?? ""} · ${entry.count}`}
              >
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-current"
                />
                <span className="truncate">{visual?.label}</span>
                <span className="tabular-nums opacity-60">{entry.count}</span>
              </span>
            </div>
          )
        }
        const tab = entry.tab
        const folderInfo = folderIndex.get(tab.folderId)
        // Drafts are group-bound: no cross-group drag, no move / split-and-move
        // menu items. Within-group sorting (the Reorder.Group itself) is
        // untouched. See `moveTabToGroup` for why.
        const isDraft = tab.conversationId == null
        // Neighbours of the active tab inset their workspace-bg baseline so the
        // active tab's transparent reverse-corner foot (which flares over them)
        // doesn't leave a stray line under it (globals.css `data-adjacent-active`).
        const adjacentActive = adjacencyAt(pos)
        const runKey = runVisuals.runOfTab.get(tab.id)
        return (
          <TabItem
            key={tab.id}
            tab={tab}
            isActive={tab.id === displayActiveId}
            isTileMode={isTileMode}
            embedded
            adjacentActive={adjacentActive}
            folderName={folderInfo?.name ?? null}
            folderBranch={branches.get(tab.folderId) ?? null}
            isSplit={isSplit}
            canSplitMove={canSplitMove && !isDraft}
            canMoveToGroup={!isDraft}
            moveTargets={moveTargets}
            onTabDrag={crossDragEnabled && !isDraft ? handleTabDrag : undefined}
            onTabDragEnd={
              crossDragEnabled && !isDraft ? handleTabDragEnd : undefined
            }
            onSwitch={switchTab}
            onClose={closeTab}
            onCloseOthers={closeOtherTabs}
            onCloseAll={closeAllTabs}
            onPin={pinTab}
            onToggleTile={handleToggleTile}
            onSplit={handleSplit}
            onMoveToGroup={moveTabToGroup}
            onToggleSplitOrientation={handleToggleSplitOrientation}
            onUnsplit={handleUnsplit}
            onUnsplitAll={unsplitAll}
            isCoarsePointer={isCoarsePointer}
            isTouchSorting={touchSortingTabId === tab.id}
            onTouchSortingStart={setTouchSortingTabId}
            onTouchSortingEnd={handleTouchSortingEnd}
            reorderable={isManualOrder}
            accentStyle={
              runKey ? runVisuals.byRun.get(runKey)?.style : undefined
            }
          />
        )
      })}
      {/* The new-conversation button + drag spacer are the Reorder.Group's own
          trailing children, so they share the tabs' flex line — the button hugs
          the last tab and the spacer fills the leftover row as a window-drag
          region. They are not Reorder.Items, so dragging a tab only ever permutes
          the tabs. Wrapped in one `flex-1` `ws-strip-line` box so the
          workspace-bg bottom hairline runs unbroken under both — the short
          `self-start h-7` button can't carry the line itself. NO `min-w-0`: its
          min-content (the shrink-0 button + the spacer's `min-w-10`) is its floor,
          so under many-tab overflow the tabs shrink to reserve it instead of it
          collapsing to 0 and clipping the button. */}
      <div
        // `relative` anchors two decorative pseudo-elements: the
        // `data-adjacent-active` inset baseline (globals.css `.ws-strip-line`
        // `::after`) used when the last tab is active, and the `tab-strip-tail`
        // `::before` vertical separator shown between the last NON-active tab and
        // the new-conversation button. Inter-tab separators sit on each tab's
        // LEFT edge (`.browser-tab-item::before`), so the last tab's RIGHT edge —
        // where this flush-pinned button begins — otherwise has none. Only the
        // conversation strip carries `tab-strip-tail`: the file strip pins an
        // add-tab button in the same place but stays divider-free, so its "+"
        // reads as belonging to the empty run of strip rather than to the tabs.
        data-adjacent-active={lastTabActive ? "after" : undefined}
        className="tab-strip-tail relative flex h-full flex-1 items-stretch ws-strip-line"
      >
        <button
          type="button"
          onClick={handleNewConversation}
          // Ghost-style CIRCULAR icon button, evenly inset from the strip's three
          // visible edges so its round hover fill never touches the last tab.
          // `self-start` seats it against the group's `pt-1.5` top rather than
          // centering in the pt-shortened trailing box: with `h-7` on the `h-10`
          // strip that yields an equal 6px top and 6px bottom gap, so its center
          // still lands on the strip midline (matching the tab content). `ml-1.5`
          // adds a matching 6px LEFT gap from the last tab's edge. The hover uses
          // the chrome-standard adaptive tint (`bg-foreground/10`, matching the
          // bottom branch/command blocks) plus `backdrop-blur-sm`: over the fully
          // transparent strip (workspace bg image on) the fill reads as frosted
          // glass rather than a muddy patch, and the tint is clearly visible in
          // both light and dark themes (unlike the old near-white `bg-accent/40`).
          className="ml-1.5 mr-0.5 flex h-7 w-7 shrink-0 items-center justify-center self-start rounded-full text-muted-foreground backdrop-blur-sm transition-colors hover:bg-foreground/10 hover:text-foreground"
          aria-label={t("newConversation")}
          title={t("newConversation")}
        >
          <SquarePen className="h-3.5 w-3.5" />
        </button>
        {/* Arrange the strip: manual order, grouped by work folder (colored),
            or sorted by status (waiting on you first). Same ghost-circle style
            as the new-conversation button; tinted while a derived layout is
            on so the non-draggable state never looks like a bug. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-tab-arrange-trigger
              className={cn(
                "mr-0.5 flex h-7 w-7 shrink-0 items-center justify-center self-start rounded-full backdrop-blur-sm transition-colors hover:bg-foreground/10 hover:text-foreground",
                isManualOrder ? "text-muted-foreground" : "text-primary"
              )}
              aria-label={tTabs("arrangeTabs")}
              title={tTabs("arrangeTabs")}
            >
              <ArrowDownWideNarrow className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>{tTabs("arrangeTabs")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={arrangeMode}
              onValueChange={(value) => setArrangeMode(value as TabArrangeMode)}
            >
              {TAB_ARRANGE_MODES.map((mode) => (
                <DropdownMenuRadioItem key={mode} value={mode}>
                  <span className="flex flex-col gap-0.5">
                    <span>{tTabs(ARRANGE_MODE_LABEL[mode].label)}</span>
                    <span className="text-xs text-muted-foreground">
                      {tTabs(ARRANGE_MODE_LABEL[mode].hint)}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Drag spacer, floored at `min-w-10` (40px) instead of `min-w-0`: even
            when many tabs overflow and squeeze this region, a grabbable
            window-drag gap always remains to the RIGHT of the new-conversation
            button, so the button never reaches the strip's right edge and the
            packed strip stays draggable. Group strips keep the drag region too:
            while split there is NO dedicated title-bar row above the shells
            (the workspace layout drops it), so each strip's tail is that
            group's slice of the window-drag surface — for the top row it IS
            the title bar, and lower rows offer the same grab area, mirroring
            the unsplit strip. */}
        <div data-tauri-drag-region className="h-full min-w-10 flex-1" />
      </div>
    </Reorder.Group>
  )
}
