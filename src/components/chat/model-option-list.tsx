"use client"

import { useCallback, useId, useMemo, useRef, useState } from "react"
import { Check, Search } from "lucide-react"
import { Virtualizer, type VirtualizerHandle } from "virtua"
import { useImeGuard } from "@/hooks/use-ime-guard"
import { useZoomLevel } from "@/hooks/use-appearance"
import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { DropdownRadioItemContent } from "@/components/chat/dropdown-radio-item-content"
import {
  filterModelGroups,
  flattenModelGroups,
  type ModelOptionGroup,
} from "@/lib/model-config-groups"

interface ModelOptionListProps {
  groups: ModelOptionGroup[]
  currentValue: string
  /** The value the agent recommends, badged wherever it appears. Independent of
   *  `currentValue` — the two may or may not be the same row. Needs
   *  `recommendedLabel` to show anything. */
  recommendedValue?: string | null
  /** Localized chip text for that row (like the search/empty labels below, the
   *  translation is the caller's). */
  recommendedLabel?: string
  onSelect: (value: string) => void
  searchPlaceholder: string
  searchAriaLabel: string
  listAriaLabel: string
  emptyLabel: string
  /** Focus the search box on mount (the wide popover opens straight into it). */
  autoFocus?: boolean
}

// Coarse per-row viewport estimate (headers are shorter, two-line options
// taller) — only sizes the scroll window; virtua measures real rows itself.
// Both mirror CSS that is sized in rem (row padding + text), so they are kept in
// rem and multiplied by the live root font size (`remPx` below). Pinned at their
// 100% pixel values the scroll window would stay 320px tall while the rows inside
// it grew with the zoom — at 250% the panel would show three models instead of
// seven and stop growing with the window.
const ROW_ESTIMATE_REM = 2.75 // 44px @100%
const MAX_LIST_HEIGHT_REM = 20 // 320px @100%

// Searchable, virtualized model list shared by both selector forms (the wide
// popover and the collapsed cog panel). Deliberately NOT a Radix menu and NOT
// cmdk: a Radix menu's roving focus over hundreds of items is the scroll jank we
// are fixing, and cmdk + virtua was the combination that previously broke item
// clicks. Instead: a plain search box drives a virtua `Virtualizer` (scrolled by
// an OverlayScrollbars `ScrollArea` — a real DOM scrollbar the popover contains,
// so grabbing it keeps Radix's pointer path clean; the focus bounce it still
// triggers on WebKit is handled by `useScrollbarSafeDismiss`) of plain option
// buttons, with arrow/Enter keyboard handled here and listbox a11y on the list.
export function ModelOptionList({
  groups,
  currentValue,
  recommendedValue = null,
  recommendedLabel,
  onSelect,
  searchPlaceholder,
  searchAriaLabel,
  listAriaLabel,
  emptyLabel,
  autoFocus = false,
}: ModelOptionListProps) {
  const ime = useImeGuard()
  const { zoomLevel } = useZoomLevel()
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const virtualizerRef = useRef<VirtualizerHandle>(null)
  // virtua scrolls the real OverlayScrollbars viewport (surfaced by ScrollArea's
  // `onViewportRef` once OS initializes). We keep both a ref (for the Virtualizer
  // `scrollRef` prop) and a state flag so the Virtualizer only mounts after that
  // viewport exists — reading it synchronously at mount is racy (OS defers init).
  const viewportRef = useRef<HTMLElement | null>(null)
  const [viewportEl, setViewportEl] = useState<HTMLElement | null>(null)
  const handleViewportRef = useCallback((element: HTMLElement | null) => {
    viewportRef.current = element
    setViewportEl(element)
  }, [])
  const baseId = useId()
  const listId = `${baseId}-list`
  const optionId = useCallback(
    (optionIndex: number) => `${baseId}-opt-${optionIndex}`,
    [baseId]
  )

  const rows = useMemo(
    () => flattenModelGroups(filterModelGroups(groups, query)),
    [groups, query]
  )
  // Flat row indices that are options (skipping headers) — the keyboard cursor
  // walks these, and they map an option position back to its flat row index.
  const optionRowIndices = useMemo(
    () => rows.flatMap((row, index) => (row.kind === "option" ? [index] : [])),
    [rows]
  )
  const optionCount = optionRowIndices.length
  // Reverse lookup (flat row index → keyboard option index) so each option row
  // can resolve its cursor position during render without a mutable counter.
  const optionIndexByRow = useMemo(() => {
    const map = new Map<number, number>()
    optionRowIndices.forEach((rowIndex, optionIndex) =>
      map.set(rowIndex, optionIndex)
    )
    return map
  }, [optionRowIndices])

  // Clamp on read so a shrinking filtered set (or a live groups update) can never
  // leave the cursor out of range — avoids a setState-in-effect just to re-clamp.
  const activeIndexClamped =
    optionCount === 0 ? 0 : Math.min(activeIndex, optionCount - 1)

  const moveActiveTo = useCallback(
    (next: number) => {
      if (optionCount === 0) return
      const clamped = Math.max(0, Math.min(optionCount - 1, next))
      setActiveIndex(clamped)
      virtualizerRef.current?.scrollToIndex(optionRowIndices[clamped], {
        align: "nearest",
      })
    },
    [optionCount, optionRowIndices]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // Don't steal Enter/arrows while an IME composition is in flight (CJK
      // input): Enter there confirms the candidate, it must not pick a model.
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
          moveActiveTo(optionCount - 1)
          break
        case "Enter": {
          const rowIndex = optionRowIndices[activeIndexClamped]
          const row = rowIndex != null ? rows[rowIndex] : undefined
          if (row && row.kind === "option") {
            event.preventDefault()
            onSelect(row.option.value)
          }
          break
        }
        default:
          break
      }
    },
    [
      activeIndexClamped,
      ime,
      moveActiveTo,
      onSelect,
      optionCount,
      optionRowIndices,
      rows,
    ]
  )

  // What a rem is worth right now: AppearanceProvider writes `16 * zoom / 100`
  // px onto <html>, so every rem-sized measurement here has to go through it.
  const remPx = (16 * zoomLevel) / 100
  const listHeight = Math.min(
    MAX_LIST_HEIGHT_REM * remPx,
    Math.max(rows.length, 1) * ROW_ESTIMATE_REM * remPx
  )

  // Always keep the active row mounted so `aria-activedescendant` resolves to a
  // real element even after wheel-scrolling / filtering unmounts it off-screen.
  const activeFlatIndex = optionRowIndices[activeIndexClamped]

  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      {/* `shrink-0`: when the popover is capped to the room it has, the rows
          below give way — the search box never does. */}
      <div className="flex shrink-0 items-center gap-2 border-b px-2.5 py-2">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input
          type="text"
          value={query}
          autoFocus={autoFocus}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={
            optionCount > 0 ? optionId(activeIndexClamped) : undefined
          }
          aria-label={searchAriaLabel}
          placeholder={searchPlaceholder}
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveIndex(0)
          }}
          {...ime.props}
          onKeyDown={handleKeyDown}
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>

      {optionCount === 0 ? (
        <div className="px-3 py-6 text-center text-sm text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        // A real DOM scrollbar (OverlayScrollbars `ScrollArea`) that lives INSIDE
        // the Radix popover, replacing virtua's native `VList` scrollbar. Because
        // the content `contains()` it, Radix never reads grabbing it as an
        // outside *pointer* interaction. (The remaining WebKit dismiss — the grab
        // blurring focus to an outside element — is handled separately by
        // `useScrollbarSafeDismiss` on the popover.) The `Virtualizer` scrolls the
        // OS viewport (bound via `scrollRef`) and mounts only once that viewport
        // exists (surfaced through `onViewportRef`).
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
              role="listbox"
              id={listId}
              aria-label={listAriaLabel}
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
                  {rows.map((row, flatIndex) => {
                    if (row.kind === "header") {
                      return (
                        <div
                          key={row.key}
                          role="presentation"
                          className="truncate px-2 pt-2 pb-0.5 text-xs font-medium text-muted-foreground"
                        >
                          {row.name}
                        </div>
                      )
                    }
                    const optionIndex = optionIndexByRow.get(flatIndex) ?? 0
                    const selected = row.option.value === currentValue
                    const active = optionIndex === activeIndexClamped
                    return (
                      <button
                        key={row.key}
                        type="button"
                        role="option"
                        id={optionId(optionIndex)}
                        aria-selected={selected}
                        title={row.option.name}
                        onMouseMove={() => setActiveIndex(optionIndex)}
                        onClick={() => onSelect(row.option.value)}
                        className={cn(
                          "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                          active && "bg-accent text-accent-foreground",
                          selected && !active && "bg-accent/60"
                        )}
                      >
                        <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">
                          {selected ? <Check className="size-4" /> : null}
                        </span>
                        <DropdownRadioItemContent
                          label={row.option.name}
                          description={row.option.description}
                          recommendedLabel={
                            row.option.value === recommendedValue
                              ? recommendedLabel
                              : null
                          }
                        />
                      </button>
                    )
                  })}
                </Virtualizer>
              ) : null}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  )
}
