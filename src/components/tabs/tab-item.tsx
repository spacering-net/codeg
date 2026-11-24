"use client"

import { memo, useCallback, useEffect, useMemo, useRef } from "react"
import { Reorder } from "motion/react"
import type { PanInfo } from "motion/react"
import { X } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn, handleMiddleClickClose } from "@/lib/utils"
import {
  acquireDragSelectionGuard,
  releaseDragSelectionGuard,
} from "@/lib/drag-selection-guard"
import type { ConversationStatus } from "@/lib/types"
import { ConversationStatusDot } from "@/components/conversations/conversation-status-dot"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { useLongPressDrag } from "@/hooks/use-long-press-drag"
import type { TabItem as TabItemData } from "@/contexts/tab-context"
import type { SplitDirection } from "@/lib/tab-group-layout"

/** A group this tab could move to (every group EXCEPT the tab's own), labeled
 *  by its traversal-order number and its selected tab's title. */
export interface TabMoveTarget {
  groupId: string
  index: number
  title: string | null
}

interface TabItemProps {
  tab: TabItemData
  isActive: boolean
  isTileMode: boolean
  /** Browser-style shrink: fill/shrink to share the row width instead of a
   *  fixed intrinsic size (title-bar embedded strips). Off = mobile scroll row. */
  embedded?: boolean
  /** Whether this tab immediately precedes/follows the active tab. With a
   *  workspace background image the active tab's transparent reverse-corner foot
   *  flares 0.5rem over this neighbour; the strip drives this so the neighbour can
   *  inset its baseline to meet the foot instead of poking a stub under it. */
  adjacentActive?: "before" | "after"
  folderName: string | null
  folderBranch: string | null
  /** More than one split group exists — shows the group-management items. */
  isSplit: boolean
  /** This tab's group has ≥ 2 tabs, so "Split and Move" leaves a non-empty
   *  group behind (moving the only tab would just shift the group). */
  canSplitMove: boolean
  /** This tab may change groups at all. False for DRAFTS: an unsent draft is the
   *  group's own scratch slot (its composer text, folder and agent live with the
   *  group), and every group can spawn one from its own strip. Only the move
   *  affordances are hidden — the group-management items stay. */
  canMoveToGroup: boolean
  moveTargets: TabMoveTarget[]
  /** Cross-group drag (split-group strips only): pointer tracking during the
   *  drag and the drop commit. Undefined = single-group strip, no cross-group
   *  semantics. */
  onTabDrag?: (
    tab: TabItemData,
    event: MouseEvent | TouchEvent | PointerEvent,
    info: PanInfo
  ) => void
  onTabDragEnd?: (
    tab: TabItemData,
    event: MouseEvent | TouchEvent | PointerEvent,
    info: PanInfo
  ) => void
  onSwitch: (tabId: string) => void
  onClose: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseAll: () => void
  onPin: (tabId: string) => void
  onToggleTile: () => void
  onSplit: (tabId: string, direction: SplitDirection, move: boolean) => void
  onMoveToGroup: (tabId: string, targetGroupId: string) => void
  onToggleSplitOrientation: () => void
  onUnsplit: () => void
  onUnsplitAll: () => void
  isCoarsePointer: boolean
  isTouchSorting: boolean
  onTouchSortingStart: (tabId: string) => void
  onTouchSortingEnd: () => void
}

export const TabItem = memo(function TabItem({
  tab,
  isActive,
  isTileMode,
  embedded = false,
  adjacentActive,
  folderName,
  folderBranch,
  isSplit,
  canSplitMove,
  canMoveToGroup,
  moveTargets,
  onTabDrag,
  onTabDragEnd,
  onSwitch,
  onClose,
  onCloseOthers,
  onCloseAll,
  onPin,
  onToggleTile,
  onSplit,
  onMoveToGroup,
  onToggleSplitOrientation,
  onUnsplit,
  onUnsplitAll,
  isCoarsePointer,
  isTouchSorting,
  onTouchSortingStart,
  onTouchSortingEnd,
}: TabItemProps) {
  const t = useTranslations("Folder.tabs")
  const itemRef = useRef<HTMLDivElement>(null)

  const resolvedFolderName = folderName ?? String(tab.folderId)
  const tooltip = folderBranch
    ? `${resolvedFolderName} · ${folderBranch}  —  ${tab.title}`
    : `${resolvedFolderName}  —  ${tab.title}`

  const clearResidualStyles = useCallback(() => {
    const el = itemRef.current
    if (!el) return
    el.style.transform = ""
    el.style.zIndex = ""
    el.style.position = ""
    el.style.userSelect = ""
  }, [])

  const handleLongPressStart = useCallback(
    () => onTouchSortingStart(tab.id),
    [onTouchSortingStart, tab.id]
  )

  const { dragControls, gestureHandlers } = useLongPressDrag({
    enabled: isCoarsePointer,
    onStart: handleLongPressStart,
    onEnd: onTouchSortingEnd,
    onDragSettle: clearResidualStyles,
  })
  // gestureHandlers carries its own onDragStart/onDragEnd (long-press cleanup +
  // post-drag click suppression). Everything below must COMPOSE with them, not
  // clobber them via spread order.
  const {
    onDragStart: longPressDragStart,
    onDragEnd: longPressDragEnd,
    ...restGestureHandlers
  } = gestureHandlers

  // Every tab drag suppresses text selection document-wide — within-group
  // sorting included, and on the unsplit strip too. Released on drag end and on
  // unmount, so a tab closed (or reparented) mid-drag can't strand the guard.
  const guardHeldRef = useRef(false)
  const acquireGuard = useCallback(() => {
    if (guardHeldRef.current) return
    guardHeldRef.current = true
    acquireDragSelectionGuard()
  }, [])
  const releaseGuard = useCallback(() => {
    if (!guardHeldRef.current) return
    guardHeldRef.current = false
    releaseDragSelectionGuard()
  }, [])
  useEffect(() => releaseGuard, [releaseGuard])

  const handleDragStart = useCallback(() => {
    acquireGuard()
    longPressDragStart()
  }, [acquireGuard, longPressDragStart])

  const handleDragMove = useCallback(
    (event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      onTabDrag?.(tab, event, info)
    },
    [onTabDrag, tab]
  )

  const handleDragEnd = useCallback(
    (event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      releaseGuard()
      longPressDragEnd()
      onTabDragEnd?.(tab, event, info)
    },
    [releaseGuard, longPressDragEnd, onTabDragEnd, tab]
  )

  const handleClick = useCallback(() => {
    onSwitch(tab.id)
  }, [onSwitch, tab.id])

  const handleDoubleClick = useCallback(() => {
    if (!tab.isPinned) {
      onPin(tab.id)
    }
  }, [onPin, tab.id, tab.isPinned])

  const handleClose = useCallback(() => {
    onClose(tab.id)
  }, [onClose, tab.id])

  const handleCloseOthers = useCallback(() => {
    onCloseOthers(tab.id)
  }, [onCloseOthers, tab.id])

  const handleSplitRight = useCallback(
    () => onSplit(tab.id, "right", false),
    [onSplit, tab.id]
  )
  const handleSplitDown = useCallback(
    () => onSplit(tab.id, "down", false),
    [onSplit, tab.id]
  )
  const handleSplitMoveRight = useCallback(
    () => onSplit(tab.id, "right", true),
    [onSplit, tab.id]
  )
  const handleSplitMoveDown = useCallback(
    () => onSplit(tab.id, "down", true),
    [onSplit, tab.id]
  )
  const handleMoveToOpposite = useCallback(() => {
    const target = moveTargets[0]
    if (target) onMoveToGroup(tab.id, target.groupId)
  }, [moveTargets, onMoveToGroup, tab.id])

  const whileDrag = useMemo(() => ({ scale: 1.03 }), [])

  return (
    <Reorder.Item
      ref={itemRef}
      as="div"
      value={tab}
      data-tab-id={tab.id}
      drag="x"
      dragControls={dragControls}
      dragListener={!isCoarsePointer}
      whileDrag={whileDrag}
      {...restGestureHandlers}
      onDragStart={handleDragStart}
      onDrag={onTabDrag ? handleDragMove : undefined}
      onDragEnd={handleDragEnd}
      onLayoutAnimationComplete={clearResidualStyles}
      data-tab-item
      data-active={embedded && isActive ? "true" : undefined}
      data-adjacent-active={embedded ? adjacentActive : undefined}
      className={cn(
        "cursor-grab active:cursor-grabbing",
        // Embedded (browser-style): every tab is EQUAL width (`basis-48` = 12rem,
        // `grow-0` so they don't stretch to fill), so a long title and a short one
        // read uniform instead of one wide / one narrow. They still `shrink`
        // together (down to `min-w-0`, the label fades) once the row fills; above
        // that the fixed basis keeps them equal. The new-conversation button hugs
        // the last tab and the leftover row stays a window-drag region.
        // `browser-tab-item` draws the left-edge hairline separator (globals.css)
        // as a 1px divider at each shared edge; tabs sit flush (no gutter) so the
        // line is the only separation, and the inner row owns its own
        // `overflow-hidden`. The active tab is raised (`z-10`) so its reverse-corner
        // seat is never covered by a hovered neighbour's flare. Standalone: rounded
        // pill, intrinsic size + horizontal scroll (mobile).
        embedded
          ? "browser-tab-item min-w-0 grow-0 shrink basis-48 data-[active=true]:z-10"
          : "rounded-full shrink-0",
        !isCoarsePointer &&
          (embedded
            ? "active:z-50"
            : "active:opacity-90 active:shadow-md active:z-50"),
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
            aria-selected={isActive}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            onMouseDown={(event) => handleMiddleClickClose(event, handleClose)}
            className={cn(
              "group/tab relative flex items-center h-full gap-1.5 text-xs",
              "cursor-pointer select-none transition-colors",
              embedded
                ? [
                    // Browser-style tab: seats against the shaded strip with a
                    // white (bg-background) active fill and a rounded top, reaching
                    // the strip's bottom so it merges into the detail header below.
                    // With a workspace background image on, the whole strip + all
                    // tabs go transparent (reveal the image); a hairline bottom
                    // border (ws-strip-line) runs under every non-active region
                    // while the active tab omits it and instead is outlined by a
                    // top+side "archway" (the browser-tab-item `::after`, globals.css)
                    // whose reverse-corner feet (browser-tab-seat) drop back onto
                    // that line — so the active tab is a gap the border detours
                    // around, not a filled box.
                    // `overflow-hidden` clips the shrunken
                    // row so a tight tab can't paint/click over its neighbor.
                    // `pb-1.5` balances the group's `pt-1.5` gap so the content
                    // (dot/title/close) centers on the h-10 strip's midline, not
                    // 3px low in the shorter tab box (the fill still reaches the
                    // strip bottom — padding only insets the content).
                    // `browser-tab-content` is the hover anchor for the label's
                    // state-driven fade (globals.css `.browser-tab-content:hover`
                    // widens the mask so the close button never covers the title).
                    "browser-tab-content w-full min-w-0 overflow-hidden rounded-t-lg px-2 pb-1.5",
                    isActive
                      ? "bg-background ws-transparent-bg text-foreground"
                      : "isolate browser-tab-hover text-muted-foreground hover:text-foreground ws-strip-line",
                  ]
                : [
                    "shrink-0 rounded-full px-3 hover:bg-primary/8",
                    isActive
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground",
                  ]
            )}
          >
            <ConversationStatusDot
              status={tab.status as ConversationStatus | undefined}
            />
            <span
              className={cn(
                // Embedded: grow + shrink as the tab tightens, but instead of an
                // ellipsis the overflowing title fades out on the right
                // (browser-tab-label mask) — dissolving toward the close button so
                // the whole width is used. Standalone: ellipsis cap in the scroll row.
                embedded
                  ? "min-w-0 flex-1 overflow-hidden whitespace-nowrap browser-tab-label"
                  : "truncate max-w-[8.75rem]",
                !tab.isPinned && "[font-style:oblique]"
              )}
              title={tooltip}
            >
              {tab.title}
            </span>
            <button
              type="button"
              className={cn(
                "rounded-md hover:bg-foreground/10",
                // Embedded: an absolute overlay pinned to the right edge, so it
                // claims no row space — the label runs the full width and fades
                // under it (browser-tab-label), instead of the label stopping
                // short of an always-reserved in-flow button. Centered via
                // `top-0 bottom-1.5 my-auto` (no transform → crisp on WebKit; the
                // `bottom-1.5` mirrors the content's `pb-1.5` so it lines up with
                // the title). Pointer events are gated off while hidden so it can't
                // eat clicks. Standalone: an in-flow chip in the scroll row.
                embedded
                  ? "absolute right-2 top-0 bottom-1.5 my-auto flex h-4 w-4 items-center justify-center"
                  : "shrink-0 p-0.5",
                isActive
                  ? "opacity-100"
                  : embedded
                    ? "opacity-0 pointer-events-none group-hover/tab:opacity-100 group-hover/tab:pointer-events-auto"
                    : "opacity-0 group-hover/tab:opacity-100"
              )}
              onClick={(event) => {
                event.stopPropagation()
                handleClose()
              }}
              aria-label={t("closeConversationTab")}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={handleClose}>{t("close")}</ContextMenuItem>
          <ContextMenuItem onSelect={handleCloseOthers}>
            {t("closeOthers")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {/* IDEA-style split-group vocabulary. Plain "Split" seeds the new
              group with a fresh draft (a conversation can't be open in two
              groups at once), "Split and Move" relocates this tab. */}
          <ContextMenuItem onSelect={handleSplitRight}>
            {t("splitRight")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={handleSplitDown}>
            {t("splitDown")}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!canSplitMove}
            onSelect={handleSplitMoveRight}
          >
            {t("splitAndMoveRight")}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!canSplitMove}
            onSelect={handleSplitMoveDown}
          >
            {t("splitAndMoveDown")}
          </ContextMenuItem>
          {isSplit && (
            <>
              {/* Move affordances only — `moveTargets` still drives the
                  "Unsplit All" gate below, so a draft keeps every
                  group-management item. */}
              {canMoveToGroup &&
                (moveTargets.length === 1 ? (
                  <ContextMenuItem onSelect={handleMoveToOpposite}>
                    {t("moveToOppositeGroup")}
                  </ContextMenuItem>
                ) : (
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      {t("moveToGroup")}
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      {moveTargets.map((target) => (
                        <ContextMenuItem
                          key={target.groupId}
                          onSelect={() => onMoveToGroup(tab.id, target.groupId)}
                        >
                          <span className="shrink-0">
                            {t("groupLabel", { index: target.index })}
                          </span>
                          {target.title && (
                            <span className="max-w-40 truncate text-muted-foreground">
                              {target.title}
                            </span>
                          )}
                        </ContextMenuItem>
                      ))}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                ))}
              <ContextMenuItem onSelect={onToggleSplitOrientation}>
                {t("changeSplitterOrientation")}
              </ContextMenuItem>
              <ContextMenuItem onSelect={onUnsplit}>
                {t("unsplit")}
              </ContextMenuItem>
              {moveTargets.length >= 2 && (
                <ContextMenuItem onSelect={onUnsplitAll}>
                  {t("unsplitAll")}
                </ContextMenuItem>
              )}
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onToggleTile}>
            {isTileMode ? t("untileDisplay") : t("tileDisplay")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onCloseAll}>
            {t("closeAll")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </Reorder.Item>
  )
})
