"use client"

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import {
  Check,
  ChevronRight,
  Folder,
  FolderGit2,
  FolderOpen,
  GitBranch,
  LocateFixed,
  Search,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { Virtualizer, type VirtualizerHandle } from "virtua"
import { useImeGuard } from "@/hooks/use-ime-guard"
import { useZoomLevel } from "@/hooks/use-appearance"
import { isImeCompositionKey } from "@/lib/ime-composition"
import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { branchRowPaddingLeft } from "@/components/layout/branch-tree-collapsible"
import {
  buildBranchRows,
  isNavigableRow,
  type BranchOperationMeta,
  type BranchRow,
} from "@/lib/branch-selector-rows"
import {
  buildBranchTree,
  buildRemoteBranchSections,
  collectGroupKeys,
  containsBranch,
  expandedKeysForBranch,
  localBranchItems,
  type BranchTreeNode,
  type RemoteBranchSection,
} from "@/lib/branch-tree"
import type { GitBranchList } from "@/lib/types"

/**
 * Group keys on the path to `target`, searched local-first then per remote —
 * i.e. the prefix groups that must be open for that branch's row to be visible.
 * `[]` when the branch is top-level or absent. Kept a plain function (not an
 * inline `useMemo` body) so its early returns don't defeat the React Compiler's
 * memoization.
 */
function seedKeysForTarget(
  target: string | null,
  localNodes: BranchTreeNode[],
  remoteSections: RemoteBranchSection[]
): string[] {
  if (!target) return []
  if (containsBranch(localNodes, target)) {
    return expandedKeysForBranch(localNodes, target)
  }
  for (const section of remoteSections) {
    if (containsBranch(section.nodes, target)) {
      return expandedKeysForBranch(section.nodes, target)
    }
  }
  return []
}

// The pinned "follow the checked-out branch" row. Modelled as the list's single
// operation so it rides `buildBranchRows`' existing machinery for free: it sorts
// above the branch tree, gets a separator after it, and drops out of search when
// the query doesn't match its label.
const HEAD_OP_ID = "head"

// Seeds the scroll window before the real content height is measured (see
// `measuredHeight`); virtua measures the actual rows itself either way. The cap
// matches cmdk's `max-h-[18.75rem]` so swapping the list in doesn't resize the
// popover.
//
// In rem, not px, because that cap is the CSS one's twin and rows are sized by
// their own text: the zoom level scales both, and a px constant here would let
// the two drift apart the moment the user leaves 100% (list capped at 300px
// inside a popover cmdk would have let grow to 450px).
const ROW_ESTIMATE_REM = 2
const MAX_LIST_HEIGHT_REM = 18.75

interface GitLogBranchFilterListProps {
  branchList: GitBranchList
  /** The checked-out branch — tags its row and seeds the expanded path. */
  currentBranch: string | null
  /** The ref currently filtering the log, or null for the all-branches view. */
  selectedBranch: string | null
  /** The HEAD row is the active filter (the caller owns that sentinel). */
  headSelected: boolean
  onSelectBranch: (fullName: string) => void
  onSelectHead: () => void
}

/**
 * The commits tab's branch FILTER picker: the same local/remote branch tree as
 * the composer's branch chip, but virtualized and read-only — picking a leaf
 * narrows the log instead of opening a per-branch action bubble.
 *
 * Deliberately NOT cmdk: this renders one flat, virtualized row list (a plain
 * search box driving a virtua `Virtualizer` scrolled by an OverlayScrollbars
 * `ScrollArea`, mirroring `BranchSelectorList` / `ModelOptionList`). cmdk mounts
 * every item to filter them, which is exactly the cost this list exists to
 * avoid on a repo with hundreds of remote refs — and stacking virtua inside cmdk
 * has already been tried and reverted elsewhere in this app.
 */
export function GitLogBranchFilterList({
  branchList,
  currentBranch,
  selectedBranch,
  headSelected,
  onSelectBranch,
  onSelectHead,
}: GitLogBranchFilterListProps) {
  const ime = useImeGuard()
  const t = useTranslations("Folder.gitLogTab.branchSelector")
  const { zoomLevel } = useZoomLevel()

  const [query, setQuery] = useState("")
  // Prefix groups default to COLLAPSED except along the path to the branch being
  // filtered by; `overrides` records the user's explicit toggles (true =
  // force-open, false = force-collapse). The popover unmounts on close, so both
  // this and the query reset on each open.
  const [overrides, setOverrides] = useState<Map<string, boolean>>(
    () => new Map()
  )
  const [activeIndex, setActiveIndex] = useState(0)
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const listboxRef = useRef<HTMLDivElement>(null)
  const virtualizerRef = useRef<VirtualizerHandle>(null)
  const viewportRef = useRef<HTMLElement | null>(null)
  const [viewportEl, setViewportEl] = useState<HTMLElement | null>(null)
  const handleViewportRef = useCallback((element: HTMLElement | null) => {
    viewportRef.current = element
    setViewportEl(element)
  }, [])

  const baseId = useId()
  const listId = `${baseId}-list`
  const optionId = useCallback(
    (index: number) => `${baseId}-opt-${index}`,
    [baseId]
  )

  const localNodes = useMemo(
    () => buildBranchTree(localBranchItems(branchList.local), "local"),
    [branchList.local]
  )
  const remoteSections = useMemo(
    () => buildRemoteBranchSections(branchList.remote),
    [branchList.remote]
  )
  const worktreeBranchSet = useMemo(
    () => new Set(branchList.worktree_branches),
    [branchList.worktree_branches]
  )

  // Type-ahead: keep typing filtering even when focus has drifted off the search
  // box (Radix focus management, or WebKit parking focus on a row after a
  // click). No-ops while the input itself is focused, so its controlled onChange
  // stays the single writer, and never hijacks another editable field.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const input = inputRef.current
      const active = document.activeElement
      if (!input || active === input) return
      if (
        active instanceof HTMLElement &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable)
      )
        return
      if (isImeCompositionKey(event)) return
      const isPrintable =
        event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      if (isPrintable) {
        event.preventDefault()
        input.focus()
        setQuery((q) => q + event.key)
        setActiveIndex(0)
      } else if (event.key === "Backspace") {
        event.preventDefault()
        input.focus()
        setQuery((q) => q.slice(0, -1))
        setActiveIndex(0)
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])

  // Track the list's true rendered height so the scroll window is exactly as
  // tall as its rows (capped), instead of trusting a per-row estimate that
  // under-/over-shoots and leaves a stray scrollbar or dead space.
  useEffect(() => {
    const el = listboxRef.current
    if (!viewportEl || !el) return
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.borderBoxSize?.[0]
      const next = Math.ceil(
        box ? box.blockSize : el.getBoundingClientRect().height
      )
      setMeasuredHeight((prev) =>
        prev != null && Math.abs(prev - next) < 1 ? prev : next
      )
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [viewportEl])

  // Group keys on the path to the branch this list is filtering by (falling back
  // to the checked-out one), so opening the popover reveals the active selection
  // instead of burying it in a folded prefix group. Under the HEAD filter the
  // selection is a sentinel, not a ref in the tree — seed with what it resolves
  // to. Multi-remote wrapper groups are keyed outside the tree and default open,
  // so only in-tree prefix keys matter here.
  const seedExpandedKeys = useMemo(
    () =>
      seedKeysForTarget(
        headSelected ? currentBranch : (selectedBranch ?? currentBranch),
        localNodes,
        remoteSections
      ),
    [headSelected, currentBranch, selectedBranch, localNodes, remoteSections]
  )

  const defaultCollapsedGroups = useMemo(() => {
    const set = new Set([
      ...collectGroupKeys(localNodes),
      ...remoteSections.flatMap((section) => collectGroupKeys(section.nodes)),
    ])
    for (const key of seedExpandedKeys) set.delete(key)
    return set
  }, [localNodes, remoteSections, seedExpandedKeys])

  const effectiveCollapsed = useMemo(() => {
    const set = new Set(defaultCollapsedGroups)
    for (const [key, expanded] of overrides) {
      if (expanded) set.delete(key)
      else set.add(key)
    }
    return set
  }, [defaultCollapsedGroups, overrides])

  const toggleCollapse = useCallback(
    (key: string) => {
      setOverrides((prev) => {
        const prevOverride = prev.get(key)
        const currentlyCollapsed =
          prevOverride !== undefined
            ? !prevOverride
            : defaultCollapsedGroups.has(key)
        const next = new Map(prev)
        next.set(key, currentlyCollapsed)
        return next
      })
    },
    [defaultCollapsedGroups]
  )

  const operations = useMemo<BranchOperationMeta[]>(
    () => [{ id: HEAD_OP_ID, label: t("head") }],
    [t]
  )

  const rows = useMemo(
    () =>
      buildBranchRows({
        operations,
        // `null`, not `[]`: this list has no worktree section AT ALL. That one
        // exists to switch the workspace into another worktree's directory,
        // which filtering the log never does, and those branches are already in
        // the local tree below. `[]` would mean "has the section, currently
        // empty" and would render a header + empty row here.
        worktreeNodes: null,
        localNodes,
        remoteSections,
        localCount: branchList.local.length,
        remoteCount: branchList.remote.length,
        branch: currentBranch,
        worktreeBranchSet,
        collapsed: effectiveCollapsed,
        query,
      }),
    [
      operations,
      localNodes,
      remoteSections,
      branchList.local.length,
      branchList.remote.length,
      currentBranch,
      worktreeBranchSet,
      effectiveCollapsed,
      query,
    ]
  )

  const navigableRowIndices = useMemo(
    () => rows.flatMap((row, index) => (isNavigableRow(row) ? [index] : [])),
    [rows]
  )
  const navigableCount = navigableRowIndices.length
  const navigableIndexByRow = useMemo(() => {
    const map = new Map<number, number>()
    navigableRowIndices.forEach((rowIndex, navIndex) =>
      map.set(rowIndex, navIndex)
    )
    return map
  }, [navigableRowIndices])

  const activeIndexClamped =
    navigableCount === 0 ? 0 : Math.min(activeIndex, navigableCount - 1)

  const moveActiveTo = useCallback(
    (next: number) => {
      if (navigableCount === 0) return
      const clamped = Math.max(0, Math.min(navigableCount - 1, next))
      setActiveIndex(clamped)
      virtualizerRef.current?.scrollToIndex(navigableRowIndices[clamped], {
        align: "nearest",
      })
    },
    [navigableCount, navigableRowIndices]
  )

  function activateRow(row: BranchRow) {
    switch (row.kind) {
      case "operation":
        onSelectHead()
        break
      case "section":
      case "group":
        toggleCollapse(row.key)
        break
      case "leaf":
        onSelectBranch(row.fullName)
        break
      default:
        break
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    // Don't steal Enter/arrows while an IME composition is in flight (CJK).
    if (ime.isComposing(event)) return

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault()
        moveActiveTo(activeIndexClamped + 1)
        break
      case "ArrowUp":
        event.preventDefault()
        moveActiveTo(activeIndexClamped - 1)
        break
      case "Home":
        event.preventDefault()
        moveActiveTo(0)
        break
      case "End":
        event.preventDefault()
        moveActiveTo(navigableCount - 1)
        break
      case "Enter": {
        const rowIndex = navigableRowIndices[activeIndexClamped]
        const row = rowIndex != null ? rows[rowIndex] : undefined
        if (row) {
          event.preventDefault()
          activateRow(row)
        }
        break
      }
      default:
        break
    }
  }

  // Root font size the zoom level resolves to (AppearanceProvider writes
  // `16 * zoom / 100` px onto <html>), which is what a rem is worth right now.
  const remPx = (16 * zoomLevel) / 100
  const listHeight = Math.min(
    MAX_LIST_HEIGHT_REM * remPx,
    measuredHeight ?? Math.max(rows.length, 1) * ROW_ESTIMATE_REM * remPx
  )
  const activeFlatIndex = navigableRowIndices[activeIndexClamped]

  const renderRow = (row: BranchRow, flatIndex: number) => {
    if (row.kind === "separator") {
      return (
        <div
          key={row.key}
          role="presentation"
          className="mx-2 my-1 h-px bg-border"
        />
      )
    }
    if (row.kind === "empty") {
      return (
        <div
          key={row.key}
          role="presentation"
          className="py-1.5 pr-3 text-sm text-muted-foreground/70"
          style={{ paddingLeft: branchRowPaddingLeft("dropdown", 1) }}
        >
          {t("noBranches")}
        </div>
      )
    }

    const navIndex = navigableIndexByRow.get(flatIndex) ?? 0
    const active = navIndex === activeIndexClamped
    const rowClass = cn(
      "flex w-full select-none items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm outline-none transition-colors",
      active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
    )

    // The HEAD row. It filters by the literal `HEAD` rev, so it follows every
    // checkout rather than pinning a name — hence the branch it currently
    // resolves to is spelled out beside it.
    if (row.kind === "operation") {
      return (
        <button
          key={row.key}
          type="button"
          role="option"
          id={optionId(navIndex)}
          aria-selected={active}
          title={t("headHint")}
          onMouseMove={() => setActiveIndex(navIndex)}
          onClick={() => activateRow(row)}
          className={rowClass}
          style={{ paddingLeft: branchRowPaddingLeft("dropdown", 0) }}
        >
          <LocateFixed className="size-3.5 shrink-0 opacity-70" />
          <span className="shrink-0">{row.label}</span>
          {currentBranch && (
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {currentBranch}
            </span>
          )}
          {headSelected && <Check className="size-3.5 shrink-0" />}
        </button>
      )
    }

    if (row.kind === "section" || row.kind === "group") {
      const depth = row.kind === "section" ? 0 : row.depth
      // Only the two branch scopes reach this list — it passes no worktree
      // leaves, so `buildBranchRows` never emits that section here.
      const label =
        row.kind === "section"
          ? row.scope === "remote"
            ? t("remoteBranches")
            : t("localBranches")
          : row.label
      return (
        <button
          key={row.key}
          type="button"
          role="option"
          id={optionId(navIndex)}
          aria-selected={active}
          onMouseMove={() => setActiveIndex(navIndex)}
          onClick={() => activateRow(row)}
          className={rowClass}
          style={{ paddingLeft: branchRowPaddingLeft("dropdown", depth) }}
        >
          {row.kind === "section" ? (
            <ChevronRight
              className={cn(
                "size-3.5 shrink-0 opacity-70 transition-transform",
                row.expanded && "rotate-90"
              )}
            />
          ) : row.expanded ? (
            <FolderOpen className="size-3.5 shrink-0 opacity-70" />
          ) : (
            <Folder className="size-3.5 shrink-0 opacity-70" />
          )}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <span className="shrink-0 pl-2 text-xs text-muted-foreground/70">
            {row.count}
          </span>
        </button>
      )
    }

    // leaf. Unlike the composer's branch chip, the checked-out branch is a
    // perfectly good thing to filter by, so it stays enabled — it just carries
    // the "current" tag.
    const LeafIcon = row.isWorktree ? FolderGit2 : GitBranch
    const isSelected = row.fullName === selectedBranch
    return (
      <button
        key={row.key}
        type="button"
        role="option"
        id={optionId(navIndex)}
        aria-selected={active}
        title={row.fullName}
        onMouseMove={() => setActiveIndex(navIndex)}
        onClick={() => activateRow(row)}
        className={rowClass}
        style={{ paddingLeft: branchRowPaddingLeft("dropdown", row.depth) }}
      >
        <LeafIcon className="size-3.5 shrink-0 opacity-70" />
        <span className="min-w-0 flex-1 truncate">{row.label}</span>
        {row.isCurrent && (
          <span className="shrink-0 pl-2 text-3xs text-muted-foreground">
            {t("current")}
          </span>
        )}
        {isSelected && <Check className="size-3.5 shrink-0" />}
      </button>
    )
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[inherit]">
      {/* pl-4 (16px) + size-3.5 icon + gap-2 puts the icon and input text at the
          same x as the rows below (listbox p-1 + 0.75rem row padding).
          `shrink-0`: when the popover is capped to the room it has, the rows
          below give way — the search box never does. */}
      <div className="flex shrink-0 items-center gap-2 border-b py-2 pl-4 pr-2.5">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={
            navigableCount > 0 ? optionId(activeIndexClamped) : undefined
          }
          aria-label={t("searchBranch")}
          placeholder={t("searchBranch")}
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveIndex(0)
          }}
          {...ime.props}
          onKeyDown={handleKeyDown}
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>

      {rows.length === 0 ? (
        <div className="px-3 py-6 text-center text-sm text-muted-foreground">
          {t("noBranches")}
        </div>
      ) : (
        // `height` is the *wanted* height; the column below it distributes the
        // height it actually gets. `min-h-0` lets this box shrink past that
        // wanted height when the popover is capped to the available room, and
        // the ScrollArea takes the shrunken height through `flex-1` rather than
        // a percentage (`h-full` would resolve against the unshrunken value).
        <div className="flex min-h-0 flex-col" style={{ height: listHeight }}>
          <ScrollArea
            onViewportRef={handleViewportRef}
            className="min-h-0 flex-1"
          >
            <div
              ref={listboxRef}
              role="listbox"
              id={listId}
              aria-label={t("label")}
              className="p-1"
            >
              {viewportEl ? (
                <Virtualizer
                  ref={virtualizerRef}
                  scrollRef={viewportRef}
                  keepMounted={
                    activeFlatIndex != null ? [activeFlatIndex] : undefined
                  }
                >
                  {rows.map((row, flatIndex) => renderRow(row, flatIndex))}
                </Virtualizer>
              ) : null}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  )
}
