"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react"
import { Loader2, SearchX } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useHarnessSlot, useHarnessView } from "@/contexts/harness-view-context"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  applyDiscoverFilters,
  DISCOVER_CONFIG,
  DISCOVER_FILTERS,
  DISCOVER_LIST,
  DISCOVER_LIST_SCROLL,
  DISCOVER_RETURN_FOCUS,
  ensureDiscoverConfig,
  ensureDiscoverList,
  loadMoreDiscover,
  openDiscoverItem,
  reloadDiscoverList,
  type DiscoverListState,
} from "@/lib/harness/discover-state"
import type {
  HarnessInstalledMark,
  HarnessItemSummary,
} from "@/lib/harness/types"
import { cn } from "@/lib/utils"
import { DiscoverCard } from "./discover-card"
import { DiscoverFailure } from "./discover-failure"
import { DiscoverToolbar } from "./discover-toolbar"

/** How far before the end of the list the next page is asked for: about two
 *  rows of cards, so it is usually there by the time the end is reached. */
const LOAD_MORE_MARGIN = "320px"

const GRID_CLASS =
  "grid grid-cols-1 gap-2 @xl/discover:grid-cols-2 @4xl/discover:grid-cols-3 @7xl/discover:grid-cols-4"

function CardSkeletons() {
  return (
    <ul aria-hidden="true" className={GRID_CLASS}>
      {Array.from({ length: 9 }, (_, index) => (
        <li
          key={index}
          className="flex flex-col gap-2 rounded-lg border bg-card p-3"
        >
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-4 w-20" />
        </li>
      ))}
    </ul>
  )
}

/** What a screen reader is told about the list as it changes: the list
 *  itself is silent, and "nothing happened" and "still loading" sound alike. */
function useListAnnouncement(list: DiscoverListState): string {
  const t = useTranslations("Harness.discover.list")
  if (list.phase === "loading") return t("loading")
  if (list.phase !== "ready") return ""
  if (list.more.phase === "loading") return t("loadingMore")
  if (list.items.length === 0) return list.next === null ? t("empty") : ""
  if (list.lastAdded > 0) return t("moreLoaded", { count: list.lastAdded })
  if (list.approxTotal !== null && list.approxTotal >= list.items.length) {
    return t("total", { count: list.approxTotal })
  }
  return t("total", { count: list.items.length })
}

interface DiscoverBrowseProps {
  /**
   * What the workspace's host has installed, by item id (ids survive a
   * rename; addresses do not). Supplied by the install steps; without it no
   * card carries a mark.
   */
  installed?: ReadonlyMap<string, HarnessInstalledMark>
}

/**
 * The catalog's list: the controls, the cards, and the next page arriving as
 * the end comes into view.
 *
 * Everything shown is read from slots, so mounting is all it takes to be back
 * where the list was left — the same results, scrolled to the same offset,
 * and after a detail was closed, the focus on the card it was opened from.
 */
export function DiscoverBrowse({ installed }: DiscoverBrowseProps) {
  const t = useTranslations("Harness.discover")
  const { slots } = useHarnessView()
  const [filters] = useHarnessSlot(DISCOVER_FILTERS)
  const [list] = useHarnessSlot(DISCOVER_LIST)
  const [config] = useHarnessSlot(DISCOVER_CONFIG)
  const isMobile = useIsMobile()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const announcement = useListAnnouncement(list)

  useEffect(() => {
    ensureDiscoverConfig(slots)
    // Also applies a search that was typed just before the page was left,
    // and asks again for a list that had failed.
    ensureDiscoverList(slots, { retry: true })
  }, [slots])

  // Back where it was. In a layout effect, so the first frame is already at
  // the remembered offset; the cards are all there, since they come from the
  // slot, not from a request.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller) scroller.scrollTop = slots.get(DISCOVER_LIST_SCROLL)
    const returnTo = slots.get(DISCOVER_RETURN_FOCUS)
    if (returnTo === null) return
    slots.set(DISCOVER_RETURN_FOCUS, null)
    const card = Array.from(
      scroller?.querySelectorAll<HTMLElement>("[data-harness-item]") ?? []
    ).find((element) => element.dataset.harnessItem === returnTo)
    // The item may not be in the list at all (it was opened from a link):
    // the list's own pane is then where to carry on from. Not the search
    // box — on a phone, focusing that brings the keyboard up over the list.
    ;(card ?? scroller)?.focus({ preventScroll: true })
  }, [slots])

  // A new first page starts from the top; the same list coming back does not.
  const shownRequest = useRef(list.request)
  useLayoutEffect(() => {
    if (shownRequest.current === list.request) return
    shownRequest.current = list.request
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0
  }, [list.request])

  const hasMore = list.phase === "ready" && list.next !== null
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!hasMore || !sentinel || typeof IntersectionObserver === "undefined") {
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        // A page that failed waits for its Retry: scrolling up and down past
        // the end must not ask a catalog that just said "slow down" again.
        if (
          entries.some((entry) => entry.isIntersecting) &&
          slots.get(DISCOVER_LIST).more.phase !== "error"
        ) {
          void loadMoreDiscover(slots)
        }
      },
      { root: scrollerRef.current, rootMargin: LOAD_MORE_MARGIN }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
    // Re-armed after every page — by its cursor, not by how many cards it
    // added: a page too short to push the end out of view, or one that added
    // none at all (only kinds that are not shown), would otherwise never be
    // followed by the next one.
  }, [hasMore, slots, list.next])

  const open = useCallback(
    (item: HarnessItemSummary) => {
      void openDiscoverItem(slots, item.ref, item)
    },
    [slots]
  )

  const filtered = filters.tag !== null || filters.runtime !== null
  const toolbar = (
    <DiscoverToolbar
      config={config.value}
      onRetryConfig={
        config.phase === "error" && !config.value
          ? () => ensureDiscoverConfig(slots)
          : undefined
      }
    />
  )

  // What stands in for the list is centred in the pane — where it has the
  // pane to itself. On a phone the controls share the scroller with it, and
  // "the full height" would push it below the fold.
  const fillClass = isMobile ? undefined : "h-full"

  let body: ReactNode
  if (list.phase === "error" && list.error) {
    body = (
      <DiscoverFailure
        failure={list.error}
        className={fillClass}
        onRetry={() => {
          ensureDiscoverConfig(slots)
          reloadDiscoverList(slots)
        }}
      />
    )
  } else if (list.items.length === 0 && list.phase !== "ready") {
    body = <CardSkeletons />
  } else if (list.items.length === 0 && !hasMore) {
    body = (
      <div
        className={cn(
          "flex min-h-48 items-center justify-center p-6",
          fillClass
        )}
      >
        <div className="flex max-w-md flex-col items-center gap-2 text-center">
          <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <SearchX aria-hidden="true" className="size-5" />
          </span>
          <p className="text-sm font-medium">{t("list.empty")}</p>
          <p className="text-xs text-muted-foreground">{t("list.emptyHint")}</p>
          {filtered && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-1 max-md:h-10"
              onClick={() =>
                applyDiscoverFilters(slots, { tag: null, runtime: null })
              }
            >
              {t("filters.clear")}
            </Button>
          )}
        </div>
      </div>
    )
  } else {
    body = (
      <>
        {list.approxTotal !== null && list.approxTotal > 0 && (
          <p className="pb-2 text-xs text-muted-foreground">
            {t("list.total", { count: list.approxTotal })}
          </p>
        )}
        <ul
          aria-label={t("list.label")}
          aria-busy={list.phase === "loading"}
          className={cn(
            GRID_CLASS,
            // The previous answer, while the next one is on its way.
            list.phase === "loading" && "opacity-60 transition-opacity"
          )}
        >
          {list.items.map((item) => (
            <DiscoverCard
              key={item.id}
              item={item}
              installed={installed?.get(item.id)}
              onOpen={open}
            />
          ))}
        </ul>
        <div className="flex min-h-12 items-center justify-center pt-3 text-xs text-muted-foreground">
          {list.more.phase === "error" && list.more.error ? (
            <DiscoverFailure
              variant="inline"
              failure={list.more.error}
              onRetry={() => void loadMoreDiscover(slots)}
            />
          ) : list.more.phase === "loading" ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              {t("list.loadingMore")}
            </span>
          ) : hasMore ? (
            // The next page arrives by itself as this comes into view; the
            // button is for when it does not — and for a keyboard.
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="max-md:h-10"
              onClick={() => void loadMoreDiscover(slots)}
            >
              {t("list.loadMore")}
            </Button>
          ) : list.phase === "ready" ? (
            <span>{t("list.end")}</span>
          ) : null}
        </div>
      </>
    )
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* Beside a wide list the controls stay put; on a phone they would take
          a third of the screen, so there they scroll away with the list. */}
      {!isMobile && <div className="shrink-0 px-4 pt-3">{toolbar}</div>}
      <div
        ref={scrollerRef}
        onScroll={(event) =>
          slots.set(DISCOVER_LIST_SCROLL, event.currentTarget.scrollTop)
        }
        // Focusable from code only: where the focus lands after a detail
        // whose item is not in the list.
        tabIndex={-1}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-3 outline-none md:px-4"
      >
        {isMobile && <div className="pb-3">{toolbar}</div>}
        {body}
        {/* What the observer watches. Present whenever a further page
            exists, including under an empty first page. */}
        {hasMore && (
          <div ref={sentinelRef} aria-hidden="true" className="h-px" />
        )}
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  )
}
