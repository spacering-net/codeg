"use client"

import { useCallback, useEffect, useMemo, useRef, type Ref } from "react"
import {
  ArrowDownWideNarrow,
  LayoutGrid,
  List,
  RotateCw,
  Search,
  TriangleAlert,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { ToggleGroup } from "radix-ui"

import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import { useImeGuard } from "@/hooks/use-ime-guard"
import {
  applyDiscoverFilters,
  DISCOVER_FILTERS,
  DISCOVER_KIND_FILTERS,
  DISCOVER_LAYOUT,
  ensureDiscoverList,
  setDiscoverLayout,
  setDiscoverText,
  type DiscoverKindFilter,
  type DiscoverKindTotals,
  type DiscoverLayout,
} from "@/lib/harness/discover-state"
import {
  HARNESS_SORTS,
  type HarnessConfig,
  type HarnessSort,
} from "@/lib/harness/types"
import { cn } from "@/lib/utils"
import { useDiscoverLabels } from "./use-discover-labels"

/** How long the search box is left alone before its text is applied. */
export const SEARCH_DEBOUNCE_MS = 300

/** The "no filter" choice of a select. Radix has no empty value, and no tag
 *  or runtime id can contain a space. */
const ANY = "any value"

const KIND_SEGMENT_CLASS = cn(
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[0.8125rem] font-medium whitespace-nowrap",
  "@2xl/discover:px-3.5",
  "text-muted-foreground outline-none transition-colors hover:text-foreground",
  // Inset: the track scrolls sideways when the labels outgrow it, and a
  // scroller clips a ring drawn outside the segment.
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
  "data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
)

/** A filter of the results bar: as quiet as the words it shows, until it is
 *  pointed at. */
const FILTER_CLASS = cn(
  "h-8 min-w-0 gap-1 border-transparent bg-transparent px-2.5 font-medium shadow-none dark:bg-transparent",
  "hover:bg-foreground/5 dark:hover:bg-foreground/5 data-[state=open]:bg-foreground/5",
  "max-w-44 max-md:h-9"
)

function isKindFilter(value: string): value is DiscoverKindFilter {
  return (DISCOVER_KIND_FILTERS as readonly string[]).includes(value)
}

function isSort(value: string): value is HarnessSort {
  return (HARNESS_SORTS as readonly string[]).includes(value)
}

function isLayout(value: string): value is DiscoverLayout {
  return value === "grid" || value === "list"
}

/**
 * How the controls apply what they hold — shared by all of them, since they
 * are drawn in different places (the search box and the kinds in the
 * heading, the filters over the results) but must apply in the order the
 * user did things.
 *
 * The search box queries as you type — {@link SEARCH_DEBOUNCE_MS} after the
 * last change, and never in the middle of an IME composition: the letters
 * typed on the way to a Chinese or Japanese word are not a query. Every other
 * control applies the moment it changes, together with whatever the search
 * box holds: a query still waiting out its pause must not land later and undo
 * what was done after it.
 */
export interface DiscoverApply {
  /** The search box's text, now. */
  now: () => void
  /** The search box's text, after the pause. */
  soon: () => void
  /** Drop a pending search (an IME composition began). */
  cancel: () => void
  /** Any other control's change, at once. */
  filter: (patch: Parameters<typeof applyDiscoverFilters>[1]) => void
}

export function useDiscoverApply(): DiscoverApply {
  const { slots } = useHarnessView()
  const timerRef = useRef<number | null>(null)

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // Leaving the page with a query still pending drops the timer, not the
  // text: it is in its slot, and the list applies it on the way back in.
  useEffect(() => cancel, [cancel])

  return useMemo(
    () => ({
      cancel,
      now: () => {
        cancel()
        ensureDiscoverList(slots)
      },
      soon: () => {
        cancel()
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null
          ensureDiscoverList(slots)
        }, SEARCH_DEBOUNCE_MS)
      },
      filter: (patch) => {
        cancel()
        applyDiscoverFilters(slots, patch)
      },
    }),
    [cancel, slots]
  )
}

/** The search box, as the heading of the page draws it: wide and tall, with
 *  the key that brings the focus to it. */
export function DiscoverSearchBox({
  apply,
  inputRef,
}: {
  apply: DiscoverApply
  inputRef?: Ref<HTMLInputElement>
}) {
  const t = useTranslations("Harness.discover")
  const { slots } = useHarnessView()
  const [filters] = useHarnessSlot(DISCOVER_FILTERS)
  const ime = useImeGuard()
  // Tracked here as well as in the guard: the guard answers for a keydown,
  // and a change event has to be asked the same question.
  const composingRef = useRef(false)

  return (
    <div className="relative min-w-0">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <input
        ref={inputRef}
        type="text"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value={filters.text}
        aria-label={t("search.label")}
        aria-keyshortcuts="/"
        placeholder={t("search.placeholder")}
        className={cn(
          "peer h-10 w-full min-w-0 rounded-full border border-input bg-background ps-10 pe-11 text-sm shadow-xs outline-none transition-[color,box-shadow,border-color] ws-msg-chip",
          "placeholder:text-muted-foreground",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        )}
        onChange={(event) => {
          setDiscoverText(slots, event.target.value)
          const composing =
            composingRef.current ||
            (event.nativeEvent as Partial<InputEvent>).isComposing === true
          if (!composing) apply.soon()
        }}
        onCompositionStart={(event) => {
          composingRef.current = true
          ime.props.onCompositionStart(event)
          apply.cancel()
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false
          ime.props.onCompositionEnd()
          // The composed word is in the box now, whether or not this
          // engine follows up with a change event of its own.
          setDiscoverText(slots, event.currentTarget.value)
          apply.soon()
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !ime.isComposing(event)) apply.now()
        }}
      />
      {filters.text !== "" ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("search.clear")}
          title={t("search.clear")}
          className="absolute end-1 top-1/2 -translate-y-1/2 rounded-full text-muted-foreground"
          onClick={() => apply.filter({ text: "" })}
        >
          <X aria-hidden="true" />
        </Button>
      ) : (
        <kbd
          aria-hidden="true"
          title={t("search.shortcut")}
          className="pointer-events-none absolute end-3 top-1/2 inline-flex h-5 min-w-5 -translate-y-1/2 items-center justify-center rounded-md border bg-muted/50 px-1.5 font-mono text-xs text-muted-foreground peer-focus-visible:hidden max-md:hidden"
        >
          /
        </kbd>
      )}
    </div>
  )
}

/** The kinds, each with how much the catalog holds of it while nothing
 *  narrows the list — a count for a search would have to be asked for per
 *  kind, on every keystroke. */
export function DiscoverKindSwitch({
  apply,
  totals,
}: {
  apply: DiscoverApply
  totals: DiscoverKindTotals | null
}) {
  const t = useTranslations("Harness.discover")
  const labels = useDiscoverLabels()
  const [filters] = useHarnessSlot(DISCOVER_FILTERS)
  const narrowed =
    filters.text.trim() !== "" ||
    filters.tag !== null ||
    filters.runtime !== null
  const format = new Intl.NumberFormat(labels.locale)

  return (
    <ToggleGroup.Root
      type="single"
      value={filters.kind}
      // Radix clears a single-choice group when its pressed item is pressed
      // again; a list always has a kind, so that is ignored.
      onValueChange={(value) => {
        if (isKindFilter(value)) apply.filter({ kind: value })
      }}
      aria-label={t("kinds.label")}
      className="no-scrollbar mx-auto flex h-9 max-w-full min-w-0 items-center gap-0.5 overflow-x-auto rounded-full bg-muted/70 p-0.5 ws-msg-chip"
    >
      {DISCOVER_KIND_FILTERS.map((kind) => {
        const total = narrowed ? undefined : totals?.[kind]
        return (
          <ToggleGroup.Item
            key={kind}
            value={kind}
            className={KIND_SEGMENT_CLASS}
          >
            {t(`kinds.${kind}`)}
            {total !== undefined && (
              <span className="text-xs font-normal text-muted-foreground tabular-nums">
                {format.format(total)}
              </span>
            )}
          </ToggleGroup.Item>
        )
      })}
    </ToggleGroup.Root>
  )
}

interface DiscoverFiltersProps {
  apply: DiscoverApply
  /** The catalog's configuration, once loaded: the tags and runtimes on
   *  offer. Until then those two filters are not shown. */
  config: HarnessConfig | null
  /** It could not be loaded: the filters say so in their place, with a way
   *  to ask again. The rest of the page works without them. */
  onRetryConfig?: () => void
}

/** The tag and runtime filters and the sort, at the head of the results. */
export function DiscoverFilters({
  apply,
  config,
  onRetryConfig,
}: DiscoverFiltersProps) {
  const t = useTranslations("Harness.discover")
  const labels = useDiscoverLabels()
  const [filters] = useHarnessSlot(DISCOVER_FILTERS)

  const searching = filters.text.trim() !== ""
  const tags = config?.tags ?? []
  const runtimes = config?.runtimes ?? []
  // A filter chosen before the configuration changed still has to be shown,
  // and be removable, even if the catalog no longer lists it.
  const tagIds = tags.map((tag) => tag.id)
  if (filters.tag && !tagIds.includes(filters.tag)) tagIds.push(filters.tag)
  const runtimeIds = runtimes.map((runtime) => runtime.id)
  if (filters.runtime && !runtimeIds.includes(filters.runtime)) {
    runtimeIds.push(filters.runtime)
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-0.5">
      {onRetryConfig && (
        <span
          role="status"
          data-discover-filters-failed=""
          className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <TriangleAlert
            aria-hidden="true"
            className="size-3.5 shrink-0 text-tone-warning"
          />
          <span className="min-w-0">{t("filters.failed")}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onRetryConfig}
            className="-my-1 max-md:h-9"
          >
            <RotateCw aria-hidden="true" />
            {t("filters.retry")}
          </Button>
        </span>
      )}
      {tagIds.length > 0 && (
        <Select
          value={filters.tag ?? ANY}
          onValueChange={(value) =>
            apply.filter({ tag: value === ANY ? null : value })
          }
        >
          <SelectTrigger
            size="sm"
            aria-label={t("filters.tag")}
            className={FILTER_CLASS}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            <SelectItem value={ANY}>{t("filters.allTags")}</SelectItem>
            {tagIds.map((id) => (
              <SelectItem key={id} value={id}>
                {labels.tag(id, config)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {runtimeIds.length > 0 && (
        <Select
          value={filters.runtime ?? ANY}
          onValueChange={(value) =>
            apply.filter({ runtime: value === ANY ? null : value })
          }
        >
          <SelectTrigger
            size="sm"
            aria-label={t("filters.runtime")}
            className={FILTER_CLASS}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            <SelectItem value={ANY}>{t("filters.anyRuntime")}</SelectItem>
            {runtimeIds.map((id) => (
              <SelectItem key={id} value={id}>
                {labels.runtime(id)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Select
        // Matches come best first: while there is text, that is the order,
        // and the three sorts have nothing to act on.
        value={searching ? ANY : filters.sort}
        disabled={searching}
        onValueChange={(value) => {
          if (isSort(value)) apply.filter({ sort: value })
        }}
      >
        <SelectTrigger
          size="sm"
          aria-label={t("sort.label")}
          className={cn(FILTER_CLASS, "[&>svg:last-child]:hidden")}
        >
          <ArrowDownWideNarrow
            aria-hidden="true"
            className="text-muted-foreground"
          />
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="end">
          {searching && (
            <SelectItem value={ANY}>{t("sort.relevance")}</SelectItem>
          )}
          {HARNESS_SORTS.map((sort) => (
            <SelectItem key={sort} value={sort}>
              {t(`sort.${sort}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/** Cards in a grid, or rows in a list. */
export function DiscoverLayoutSwitch() {
  const t = useTranslations("Harness.discover.layout")
  const { slots } = useHarnessView()
  const [layout] = useHarnessSlot(DISCOVER_LAYOUT)
  const items = [
    { value: "grid", Icon: LayoutGrid },
    { value: "list", Icon: List },
  ] as const
  return (
    <ToggleGroup.Root
      type="single"
      value={layout}
      onValueChange={(value) => {
        if (isLayout(value)) setDiscoverLayout(slots, value)
      }}
      aria-label={t("label")}
      className="flex h-8 shrink-0 items-center gap-0.5 rounded-full bg-muted/70 p-0.5 ws-msg-chip max-md:h-9"
    >
      {items.map(({ value, Icon }) => (
        <ToggleGroup.Item
          key={value}
          value={value}
          aria-label={t(value)}
          title={t(value)}
          className={cn(
            "inline-flex h-full w-8 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:text-foreground",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            "data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
          )}
        >
          <Icon aria-hidden="true" className="size-4" />
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}
