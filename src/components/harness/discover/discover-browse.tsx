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
import {
  applyDiscoverFilters,
  DISCOVER_CONFIG,
  DISCOVER_FILTERS,
  DISCOVER_KIND_TOTALS,
  DISCOVER_LAYOUT,
  DISCOVER_LIST,
  DISCOVER_LIST_SCROLL,
  DISCOVER_RETURN_FOCUS,
  ensureDiscoverConfig,
  ensureDiscoverKindTotals,
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
import { HarnessScroller } from "../harness-scroller"
import { DiscoverCard } from "./discover-card"
import { DiscoverFailure } from "./discover-failure"
import {
  DiscoverFilters,
  DiscoverKindSwitch,
  DiscoverLayoutSwitch,
  DiscoverSearchBox,
  useDiscoverApply,
} from "./discover-toolbar"

/** How far before the end of the list the next page is asked for: about two
 *  rows of cards, so it is usually there by the time the end is reached. */
const LOAD_MORE_MARGIN = "320px"

const GRID_CLASS =
  "grid grid-cols-1 gap-4 @2xl/discover:grid-cols-2 @5xl/discover:grid-cols-3"

const LIST_CLASS = "flex flex-col gap-4"

function CardSkeletons() {
  return (
    <ul aria-hidden="true" className={GRID_CLASS}>
      {Array.from({ length: 6 }, (_, index) => (
        <li
          key={index}
          className="flex flex-col gap-3 rounded-xl border bg-card p-4"
        >
          <div className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-lg" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3.5 w-1/4" />
            </div>
          </div>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-6 w-28" />
        </li>
      ))}
    </ul>
  )
}

/** Where the focus goes for "/", from anywhere on the page that is not
 *  taking text itself. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
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
  const [totals] = useHarnessSlot(DISCOVER_KIND_TOTALS)
  const [layout] = useHarnessSlot(DISCOVER_LAYOUT)
  const apply = useDiscoverApply()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const announcement = useListAnnouncement(list)

  useEffect(() => {
    ensureDiscoverConfig(slots)
    ensureDiscoverKindTotals(slots)
    // Also applies a search that was typed just before the page was left,
    // and asks again for a list that had failed.
    ensureDiscoverList(slots, { retry: true })
  }, [slots])

  // "/" takes the focus to the search box from anywhere on the page that is
  // not taking text itself — the box may have scrolled away with the
  // heading.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "/" ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTyping(event.target)
      ) {
        return
      }
      // Only while nothing modal is open over the page.
      if (document.querySelector('[role="dialog"][data-state="open"]')) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])

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

  // A new first page starts from the head of the results — not from the top
  // of the page: the heading above them is not what changed. The same list
  // coming back does not move at all.
  const shownRequest = useRef(list.request)
  useLayoutEffect(() => {
    if (shownRequest.current === list.request) return
    shownRequest.current = list.request
    const scroller = scrollerRef.current
    const results = resultsRef.current
    if (!scroller) return
    const head = results ? results.offsetTop : 0
    if (scroller.scrollTop > head) scroller.scrollTop = head
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
  const catalogTotal = totals.value?.all
  const shownTotal =
    list.phase === "ready" || list.items.length > 0
      ? (list.approxTotal ?? (list.next === null ? list.items.length : null))
      : null

  let body: ReactNode
  if (list.phase === "error" && list.error) {
    body = (
      <DiscoverFailure
        failure={list.error}
        className="min-h-64"
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
      <div className="flex min-h-64 items-center justify-center p-6">
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
        <ul
          aria-label={t("list.label")}
          aria-busy={list.phase === "loading"}
          className={cn(
            layout === "list" ? LIST_CLASS : GRID_CLASS,
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
              layout={layout}
            />
          ))}
        </ul>
        <div className="flex min-h-14 items-center justify-center pt-4 text-xs text-muted-foreground">
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
      <HarnessScroller
        ref={scrollerRef}
        onScroll={(event) =>
          slots.set(DISCOVER_LIST_SCROLL, event.currentTarget.scrollTop)
        }
        // Focusable from code only: where the focus lands after a detail
        // whose item is not in the list.
        tabIndex={-1}
        className="flex-1"
      >
        <div className="mx-auto w-full max-w-6xl min-w-0 px-4 pb-4">
          <header className="flex min-w-0 flex-col items-center pt-6 pb-5 text-center @2xl/discover:pt-10 @2xl/discover:pb-6">
            <h2 className="text-2xl leading-tight font-bold tracking-tight text-balance @2xl/discover:text-3xl">
              {t.rich("hero.title", {
                accent: (chunks) => (
                  <span className="text-primary">{chunks}</span>
                ),
              })}
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-balance text-muted-foreground">
              {catalogTotal !== undefined
                ? t("hero.subtitle", { count: catalogTotal })
                : t("hero.subtitleNoCount")}
            </p>
          </header>
          <div role="search" className="min-w-0">
            <div className="mx-auto flex w-full max-w-2xl min-w-0 flex-col items-stretch gap-4">
              <DiscoverSearchBox apply={apply} inputRef={searchRef} />
              <DiscoverKindSwitch apply={apply} totals={totals.value} />
            </div>
            <div
              ref={resultsRef}
              className="mt-6 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b pb-3 @2xl/discover:mt-8"
            >
              <p className="min-w-0 text-sm text-muted-foreground">
                {shownTotal !== null &&
                  t.rich("list.count", {
                    count: shownTotal,
                    num: (chunks) => (
                      <strong className="font-semibold text-foreground tabular-nums">
                        {chunks}
                      </strong>
                    ),
                  })}
              </p>
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                <DiscoverFilters
                  apply={apply}
                  config={config.value}
                  onRetryConfig={
                    config.phase === "error" && !config.value
                      ? () => ensureDiscoverConfig(slots)
                      : undefined
                  }
                />
                <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
                <DiscoverLayoutSwitch />
              </div>
            </div>
          </div>
          <div className="pt-4">{body}</div>
          {/* What the observer watches. Present whenever a further page
              exists, including under an empty first page. */}
          {hasMore && (
            <div ref={sentinelRef} aria-hidden="true" className="h-px" />
          )}
        </div>
      </HarnessScroller>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  )
}
