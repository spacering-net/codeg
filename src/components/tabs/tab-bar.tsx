"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Reorder } from "motion/react"
import type { PanInfo } from "motion/react"
import { Maximize2, Minimize2, SquarePen } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useTabActions, useTabStore } from "@/contexts/tab-context"
import type { TabItem as TabItemData } from "@/contexts/tab-context"
import {
  useWorkspaceActions,
  useWorkspaceView,
} from "@/contexts/workspace-context"
import { useIsMobile } from "@/hooks/use-mobile"
import { useFolderTabsStore } from "@/stores/folder-tabs-store"
import {
  groupOfTab,
  useVisibleConversationLayout,
  useVisibleConversationTabs,
} from "@/stores/tab-store"
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
import { STRIP_ICON_BTN } from "./strip-icon-button"
import { TabItem, type TabMoveTarget } from "./tab-item"

interface TabBarProps {
  /** Split-group strip: render only this group's tabs, highlight the GROUP's
   *  selected tab, and target new tabs/reorders at the group. Omitted = the
   *  single title-bar strip shown while unsplit. */
  groupId?: string
  /** Carry the conversation column's maximize/restore button. The column has
   *  one, so exactly one strip does: the unsplit strip, or while split the
   *  top-right group's — the strip in the unsplit one's place. */
  maximizeControl?: boolean
}

// Rendered inside the desktop conversation-column title strip while unsplit,
// or once per group shell (with `groupId`) while split. The old standalone
// mobile variant is gone — mobile shows the conversation detail header instead
// and navigates tabs from the sidebar.
export function TabBar({ groupId, maximizeControl = false }: TabBarProps) {
  const t = useTranslations("Folder.conversationCard")
  const { mode, conversationMaximized } = useWorkspaceView()
  const { toggleConversationMaximized } = useWorkspaceActions()
  const isMobile = useIsMobile()
  // Maximizing means covering the file column, so it is offered only while
  // there is one (fusion) — the file strip's own button follows the same rule.
  // Mobile shows one pane at a time and has nothing to cover.
  const showMaximize = maximizeControl && mode === "fusion" && !isMobile
  const tabsFollowFolder = useFolderTabsStore((s) => s.enabled)
  const tabs = useVisibleConversationTabs()
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
  const stripGroupId =
    groupId ??
    (tabs[0]
      ? groupOfTab(groupOf, groupLayout, tabs[0].id)
      : firstLeafId(groupLayout))
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
  const isTileMode = !!tileByGroup[stripGroupId]
  const handleToggleTile = useCallback(
    () => toggleGroupTile(stripGroupId),
    [toggleGroupTile, stripGroupId]
  )

  // Split-group context-menu wiring, shared by every tab in this strip: the
  // groups on screen are the split targets. While tabs follow the folder that
  // is the folder's own layout, which the visible one narrows to its tabs
  // before the tab set is known.
  const visibleLayout = useVisibleConversationLayout()
  const orderedLeaves = useMemo(() => leafIds(visibleLayout), [visibleLayout])
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
  const crossDragEnabled = groupId != null && isSplit

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
    const map = new Map<number, { name: string }>()
    for (const f of allFolders) map.set(f.id, { name: f.name })
    return map
  }, [allFolders])

  const scrollRef = useRef<HTMLDivElement>(null)
  const isCoarsePointer = useIsCoarsePointer()
  const [touchSortingTabId, setTouchSortingTabId] = useState<string | null>(
    null
  )

  useEffect(() => {
    if (!displayActiveId || !scrollRef.current) return
    const el = scrollRef.current.querySelector(
      `[data-tab-id="${displayActiveId}"]`
    )
    el?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [displayActiveId])

  const handleReorder = useCallback(
    (nextTabs: TabItemData[]) => {
      if (isCoarsePointer && !touchSortingTabId) return
      if (groupId == null) {
        reorderTabs(nextTabs)
      } else {
        reorderGroupTabs(groupId, nextTabs)
      }
    },
    [groupId, isCoarsePointer, reorderGroupTabs, reorderTabs, touchSortingTabId]
  )

  const handleTouchSortingEnd = useCallback(
    () => setTouchSortingTabId(null),
    []
  )

  // While tabs follow the folder, the unsplit strip stays up for a folder with
  // nothing open: its "+" is how that folder gets its first conversation.
  if (groupTabs.length === 0 && (groupId != null || !tabsFollowFolder)) {
    return null
  }

  const activeIndex = groupTabs.findIndex((tab) => tab.id === displayActiveId)
  // When the LAST tab is active, the trailing new-conversation wrapper is its
  // right neighbour — it needs the same baseline inset a tab neighbour gets
  // (`data-adjacent-active`), so the active tab's right reverse-corner foot
  // doesn't leave a stray line poking out from under it (globals.css).
  const lastTabActive = activeIndex >= 0 && activeIndex === groupTabs.length - 1

  return (
    <Reorder.Group
      as="div"
      ref={scrollRef}
      role="tablist"
      axis="x"
      values={groupTabs}
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
      {groupTabs.map((tab, index) => {
        const folderInfo = folderIndex.get(tab.folderId)
        // Drafts are group-bound: no cross-group drag, no move / split-and-move
        // menu items. Within-group sorting (the Reorder.Group itself) is
        // untouched. See `moveTabToGroup` for why.
        const isDraft = tab.conversationId == null
        // Neighbours of the active tab inset their workspace-bg baseline so the
        // active tab's transparent reverse-corner foot (which flares over them)
        // doesn't leave a stray line under it (globals.css `data-adjacent-active`).
        const adjacentActive =
          activeIndex < 0
            ? undefined
            : index === activeIndex - 1
              ? "before"
              : index === activeIndex + 1
                ? "after"
                : undefined
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
          />
        )
      })}
      {/* The new-conversation button + drag spacer (+ the maximize/restore
          button, flush right, while a file column sits beside this one) are the
          Reorder.Group's own trailing children, so they share the tabs' flex
          line — the new-conversation button hugs the last tab and the spacer
          fills the leftover row as a window-drag region. They are not
          Reorder.Items, so dragging a tab only ever permutes the tabs. Wrapped
          in one `flex-1` `ws-strip-line` box so the workspace-bg bottom hairline
          runs unbroken under all of them — the short `self-start h-7` buttons
          can't carry the line themselves. NO `min-w-0`: its min-content (the
          shrink-0 buttons + the spacer's `min-w-10`) is its floor, so under
          many-tab overflow the tabs shrink to reserve it instead of it
          collapsing to 0 and clipping the buttons. */}
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
          // Ghost-style CIRCULAR icon button (STRIP_ICON_BTN: the shape, the
          // midline seating and the frosted adaptive hover), evenly inset from
          // the strip's three visible edges so its round hover fill never
          // touches the last tab: seated against the group's `pt-1.5` top it
          // has 6px above and below, and `ml-1.5` adds a matching 6px LEFT gap
          // from the last tab's edge.
          className={cn(STRIP_ICON_BTN, "ml-1.5 mr-0.5")}
          aria-label={t("newConversation")}
          title={t("newConversation")}
        >
          <SquarePen className="h-3.5 w-3.5" />
        </button>
        {/* Drag spacer, floored at `min-w-10` (40px) instead of `min-w-0`: even
            when many tabs overflow and squeeze this region, a grabbable
            window-drag gap always remains to the RIGHT of the new-conversation
            button, so the button never reaches the strip's right edge (or the
            maximize button) and the packed strip stays draggable. Group strips
            keep the drag region too: while split there is NO dedicated
            title-bar row above the shells (the workspace layout drops it), so
            each strip's tail is that group's slice of the window-drag surface —
            for the top row it IS the title bar, and lower rows offer the same
            grab area, mirroring the unsplit strip. */}
        <div data-tauri-drag-region className="h-full min-w-10 flex-1" />
        {/* Maximize/restore, flush right like the file strip's own: the
            conversation column over the whole middle area with the file column
            hidden under it, and back. `mr-1.5` gives it the 6px inset from the
            strip's right edge it has above and below. */}
        {showMaximize && groupTabs.length > 0 && (
          <button
            type="button"
            onClick={toggleConversationMaximized}
            className={cn(
              STRIP_ICON_BTN,
              "mr-1.5",
              conversationMaximized && "text-primary"
            )}
            aria-label={conversationMaximized ? t("restore") : t("maximize")}
            aria-pressed={conversationMaximized}
            title={conversationMaximized ? t("restore") : t("maximize")}
          >
            {conversationMaximized ? (
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
