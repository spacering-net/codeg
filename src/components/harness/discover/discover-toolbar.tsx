"use client"

import { useCallback, useEffect, useRef } from "react"
import { RotateCw, Search, TriangleAlert, X } from "lucide-react"
import { useTranslations } from "next-intl"
import { ToggleGroup } from "radix-ui"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
  ensureDiscoverList,
  setDiscoverText,
  type DiscoverKindFilter,
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

const SEGMENT_CLASS = cn(
  // Five labels have to share a 20rem phone: the padding gives way first, and
  // comes back as soon as the pane has room for it.
  "h-8 flex-1 rounded-full px-1.5 text-[0.8125rem] font-medium whitespace-nowrap",
  "max-md:h-9 @sm/discover:px-3",
  "text-muted-foreground outline-none transition-colors hover:text-foreground",
  // Inset: the track scrolls sideways when the labels outgrow it, and a
  // scroller clips a ring drawn outside the segment.
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
  "data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm",
  "@2xl/discover:h-7 @2xl/discover:flex-none"
)

/** A filter's trigger. On a phone two share a row and the third takes the
 *  next one, so none is squeezed until its value is cut; with room they are
 *  as wide as what they say, in one row. */
const FILTER_CLASS =
  "min-w-[calc(50%-0.25rem)] flex-1 max-md:h-10 @md/discover:min-w-0 @2xl/discover:flex-none"

function isKindFilter(value: string): value is DiscoverKindFilter {
  return (DISCOVER_KIND_FILTERS as readonly string[]).includes(value)
}

function isSort(value: string): value is HarnessSort {
  return (HARNESS_SORTS as readonly string[]).includes(value)
}

interface DiscoverToolbarProps {
  /** The catalog's configuration, once loaded: the tags and runtimes on
   *  offer. Until then the two filters are not shown. */
  config: HarnessConfig | null
  /** It could not be loaded: the filters say so in their place, with a way
   *  to ask again. The rest of the page works without them. */
  onRetryConfig?: () => void
  className?: string
}

/**
 * What the list is asked for: the search box, the kind switch, the tag and
 * runtime filters and the sort.
 *
 * Everything but the search box applies the moment it changes. The search box
 * queries as you type — {@link SEARCH_DEBOUNCE_MS} after the last change, and
 * never in the middle of an IME composition: the letters typed on the way to
 * a Chinese or Japanese word are not a query.
 */
export function DiscoverToolbar({
  config,
  onRetryConfig,
  className,
}: DiscoverToolbarProps) {
  const t = useTranslations("Harness.discover")
  const labels = useDiscoverLabels()
  const { slots } = useHarnessView()
  const [filters] = useHarnessSlot(DISCOVER_FILTERS)
  const ime = useImeGuard()
  // Tracked here as well as in the guard: the guard answers for a keydown,
  // and a change event has to be asked the same question.
  const composingRef = useRef(false)
  const timerRef = useRef<number | null>(null)

  const cancelPending = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // Leaving the page with a query still pending drops the timer, not the
  // text: it is in its slot, and the list applies it on the way back in.
  useEffect(() => cancelPending, [cancelPending])

  const applyNow = useCallback(() => {
    cancelPending()
    ensureDiscoverList(slots)
  }, [cancelPending, slots])

  const applySoon = useCallback(() => {
    cancelPending()
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      ensureDiscoverList(slots)
    }, SEARCH_DEBOUNCE_MS)
  }, [cancelPending, slots])

  /** Any other control: applied at once, together with whatever the search
   *  box holds — a query still waiting out its pause must not land later and
   *  undo the order the user did things in. */
  const applyFilter = useCallback(
    (patch: Parameters<typeof applyDiscoverFilters>[1]) => {
      cancelPending()
      applyDiscoverFilters(slots, patch)
    },
    [cancelPending, slots]
  )

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
  const hasFilters = tagIds.length > 0 || runtimeIds.length > 0

  return (
    <div role="search" className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="relative min-w-0">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="text"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={filters.text}
          aria-label={t("search.label")}
          placeholder={t("search.placeholder")}
          className="h-10 ps-9 pe-10 md:h-9"
          onChange={(event) => {
            setDiscoverText(slots, event.target.value)
            const composing =
              composingRef.current ||
              (event.nativeEvent as Partial<InputEvent>).isComposing === true
            if (!composing) applySoon()
          }}
          onCompositionStart={(event) => {
            composingRef.current = true
            ime.props.onCompositionStart(event)
            cancelPending()
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false
            ime.props.onCompositionEnd()
            // The composed word is in the box now, whether or not this
            // engine follows up with a change event of its own.
            setDiscoverText(slots, event.currentTarget.value)
            applySoon()
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !ime.isComposing(event)) applyNow()
          }}
        />
        {filters.text !== "" && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("search.clear")}
            title={t("search.clear")}
            className="absolute end-1 top-1/2 -translate-y-1/2 text-muted-foreground md:size-7"
            onClick={() => applyFilter({ text: "" })}
          >
            <X aria-hidden="true" />
          </Button>
        )}
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <ToggleGroup.Root
          type="single"
          value={filters.kind}
          // Radix clears a single-choice group when its pressed item is
          // pressed again; a list always has a kind, so that is ignored.
          onValueChange={(value) => {
            if (isKindFilter(value)) applyFilter({ kind: value })
          }}
          aria-label={t("kinds.label")}
          className={cn(
            "no-scrollbar flex h-9 w-full min-w-0 items-center gap-0.5 overflow-x-auto rounded-full bg-muted/70 p-0.5 ws-msg-chip max-md:h-10",
            "@2xl/discover:h-8 @2xl/discover:w-fit"
          )}
        >
          {DISCOVER_KIND_FILTERS.map((kind) => (
            <ToggleGroup.Item key={kind} value={kind} className={SEGMENT_CLASS}>
              {t(`kinds.${kind}`)}
            </ToggleGroup.Item>
          ))}
        </ToggleGroup.Root>

        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 @2xl/discover:justify-end">
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
          {hasFilters && (
            <>
              {tagIds.length > 0 && (
                <Select
                  value={filters.tag ?? ANY}
                  onValueChange={(value) =>
                    applyFilter({ tag: value === ANY ? null : value })
                  }
                >
                  <SelectTrigger
                    size="sm"
                    aria-label={t("filters.tag")}
                    className={cn(FILTER_CLASS, "@2xl/discover:max-w-44")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
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
                    applyFilter({ runtime: value === ANY ? null : value })
                  }
                >
                  <SelectTrigger
                    size="sm"
                    aria-label={t("filters.runtime")}
                    className={cn(FILTER_CLASS, "@2xl/discover:max-w-44")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>
                      {t("filters.anyRuntime")}
                    </SelectItem>
                    {runtimeIds.map((id) => (
                      <SelectItem key={id} value={id}>
                        {labels.runtime(id)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </>
          )}
          <Select
            // Matches come best first: while there is text, that is the
            // order, and the three sorts have nothing to act on.
            value={searching ? ANY : filters.sort}
            disabled={searching}
            onValueChange={(value) => {
              if (isSort(value)) applyFilter({ sort: value })
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label={t("sort.label")}
              className={cn(FILTER_CLASS, "@2xl/discover:max-w-48")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
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
      </div>
    </div>
  )
}
