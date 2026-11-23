"use client"

import { useEffect, useId, useLayoutEffect, useRef } from "react"
import { ChevronRight, ExternalLink, Star } from "lucide-react"
import { useTranslations } from "next-intl"

import { BrowserLink } from "@/components/ui/browser-link"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useHarnessView } from "@/contexts/harness-view-context"
import {
  DISCOVER_DETAIL_SCROLL,
  DISCOVER_RETURN_FOCUS,
  retryDiscoverItem,
  retryDiscoverPart,
  type DiscoverDetailState,
} from "@/lib/harness/discover-state"
import {
  formatCompact,
  formatDate,
  harnessItemUrl,
  itemSummary,
  itemTitle,
  pickLocalized,
  showsRuntime,
} from "@/lib/harness/display"
import { isItemRef } from "@/lib/harness/item-ref"
import { useHarnessStatus } from "@/lib/harness/status"
import type {
  HarnessInstalledMark,
  HarnessItemSummary,
} from "@/lib/harness/types"
import { cn } from "@/lib/utils"
import { HarnessScroller } from "../harness-scroller"
import { discoverKindView, type DiscoverKindView } from "./detail-kinds"
import {
  FactsPanel,
  FactsSkeleton,
  ListedNotice,
  RiskBanner,
} from "./detail-sections"
import {
  DiscoverMark,
  InstalledMarks,
  KindTile,
  RiskMark,
} from "./discover-card"
import { DiscoverFailure } from "./discover-failure"
import { PublisherAvatar } from "./publisher-avatar"
import { useDiscoverLabels } from "./use-discover-labels"

/** A step of the breadcrumb that leads back. */
const CRUMB_CLASS =
  "shrink-0 rounded-md px-1 py-0.5 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"

/** The side card's actions: one under the other, as wide as the card. The
 *  kinds' own buttons are drawn for a row (`detail-kinds.tsx`); here they
 *  are made to fill it. */
const ACTIONS_CLASS = cn(
  "flex min-w-0 flex-col gap-2 p-3.5",
  "[&>[data-slot=button]]:h-9 [&>[data-slot=button]]:w-full [&>[data-slot=button]]:rounded-full [&>[data-slot=button]]:text-sm"
)

/** How many rows the facts card will have, from what the list knew: the
 *  version when there is one, the revision, the license (unless the kind
 *  says whose it is), the source, a repository for what comes from GitHub,
 *  and the kind's own rows. */
function factRowsGuess(
  item: HarnessItemSummary,
  view: DiscoverKindView
): number {
  return (
    (item.latest.version ? 1 : 0) +
    1 +
    (view.factsSayRights ? 0 : 1) +
    1 +
    (item.source === "github" ? 1 : 0) +
    (view.loadingFacts?.(item) ?? 0)
  )
}

function Dot() {
  return (
    <span aria-hidden="true" className="opacity-50">
      ·
    </span>
  )
}

interface DiscoverDetailProps {
  detail: DiscoverDetailState
  /** Back: to the detail this one was opened from, or to the list. */
  onBack: () => void
  /** Straight back to the list, however deep in details this one is. */
  onBackToList?: () => void
  /** The detail Back returns to, when this one was opened from another (an
   *  assistant's skill); `null` when Back returns to the list. */
  backTo?: DiscoverDetailState | null
  /**
   * What the workspace's host has of this item. Supplied by the install
   * steps; until then the detail shows no "installed" mark and its kind has
   * no actions to offer.
   */
  installed?: HarnessInstalledMark | null
}

/**
 * One item, in the place of the list.
 *
 * The frame is the same for every kind: a breadcrumb back to the list, the
 * heading — what it is called, who publishes it, what it does — and beside
 * it a column with what the checks made of it, what can be done with it
 * (the kind's actions, the item's page on the website) and its particulars.
 * Under the heading goes whatever its kind supplies (`detail-kinds.tsx`).
 *
 * The heading is drawn from what the list already knew while the item itself
 * is on its way, and takes the focus when the detail opens, so a keyboard or
 * a screen reader lands on the item and not on the page's top.
 */
export function DiscoverDetail({
  detail,
  onBack,
  onBackToList = onBack,
  backTo = null,
  installed = null,
}: DiscoverDetailProps) {
  const t = useTranslations("Harness.discover")
  const tHarness = useTranslations("Harness")
  const labels = useDiscoverLabels()
  const { slots } = useHarnessView()
  const status = useHarnessStatus()
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)

  const { item, preview } = detail
  const known = item ?? preview
  const title = known ? itemTitle(known, labels.lang) : detail.ref
  // A prompt's card stands in its start for a summary; here the whole text
  // is just below, and saying its start twice says nothing.
  const summary = !known
    ? undefined
    : known.kind === "prompt"
      ? pickLocalized(known.summary, labels.lang)
      : itemSummary(known, labels.lang)
  const backKnown = backTo ? (backTo.item ?? backTo.preview) : null
  const backTitle = backTo
    ? backKnown
      ? itemTitle(backKnown, labels.lang)
      : backTo.ref
    : null
  const stars = known?.repoStars ?? 0
  const updated = known
    ? formatDate(known.latest.publishedAt, labels.locale)
    : null
  const ref = item?.ref ?? detail.ref
  // Only for an address that can exist, and not for one the catalog has just
  // said it does not have.
  const websiteUrl =
    isItemRef(ref) && detail.error?.kind !== "notFound"
      ? harnessItemUrl(status.origin, ref, labels.lang)
      : null
  const view = item ? discoverKindView(item.kind) : null
  // While the item is on its way, its placeholders take the shape its kind
  // will have — as far as the list's card already tells it.
  const knownView = known ? discoverKindView(known.kind) : null
  const loadingActions = knownView
    ? (knownView.loadingActions?.(installed) ?? 0)
    : 1

  useEffect(() => {
    // Back from an item that was opened from here: its link takes the focus
    // again, as a card does on the way back to the list.
    const returnTo = slots.get(DISCOVER_RETURN_FOCUS)
    if (returnTo !== null) {
      slots.set(DISCOVER_RETURN_FOCUS, null)
      const link = Array.from(
        scrollerRef.current?.querySelectorAll<HTMLElement>(
          "[data-harness-item]"
        ) ?? []
      ).find((element) => element.dataset.harnessItem === returnTo)
      if (link) {
        link.focus({ preventScroll: true })
        return
      }
    }
    headingRef.current?.focus({ preventScroll: true })
  }, [slots, detail.ref])

  // As for the list: the offset it was left at, on the first frame.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller) scroller.scrollTop = slots.get(DISCOVER_DETAIL_SCROLL)
  }, [slots, detail.request])

  const kindLabel = known ? labels.kind(known.kind) : null

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <HarnessScroller
        ref={scrollerRef}
        onScroll={(event) =>
          slots.set(DISCOVER_DETAIL_SCROLL, event.currentTarget.scrollTop)
        }
        className="flex-1"
      >
        <article
          aria-labelledby={headingId}
          aria-busy={detail.phase === "loading"}
          className="mx-auto w-full max-w-6xl min-w-0 px-4 pb-10"
        >
          <nav
            aria-label={t("detail.breadcrumb")}
            // A band of its own: as far from the top as from the header.
            className="flex min-w-0 items-center gap-1 py-4 text-sm text-muted-foreground"
          >
            <button
              type="button"
              onClick={onBackToList}
              aria-label={backTitle === null ? t("detail.back") : undefined}
              className={CRUMB_CLASS}
            >
              {tHarness("sections.discover")}
            </button>
            {backTitle !== null && (
              <>
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 shrink-0 opacity-60 rtl:rotate-180"
                />
                <button
                  type="button"
                  onClick={onBack}
                  aria-label={t.markup("detail.backTo", {
                    name: backTitle,
                    title: (chunks) => chunks,
                  })}
                  className={cn(CRUMB_CLASS, "min-w-0 truncate")}
                >
                  <bdi>{backTitle}</bdi>
                </button>
              </>
            )}
            {kindLabel && (
              <>
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 shrink-0 opacity-60 rtl:rotate-180"
                />
                <span aria-current="page" className="shrink-0 px-1">
                  {kindLabel}
                </span>
              </>
            )}
          </nav>

          <div className="grid min-w-0 gap-6 @4xl/discover:grid-cols-[minmax(0,1fr)_20rem] @4xl/discover:gap-x-10">
            <header className="min-w-0 @4xl/discover:col-start-1 @4xl/discover:row-start-1">
              <div className="flex min-w-0 items-start gap-4">
                {known && (
                  <KindTile
                    kind={known.kind}
                    className="size-12 rounded-xl @2xl/discover:size-14 @2xl/discover:rounded-2xl"
                    iconClassName="size-6"
                  />
                )}
                <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                  <h2
                    id={headingId}
                    ref={headingRef}
                    tabIndex={-1}
                    // The item's own language, or — before anything is known
                    // of it — its address: either way not the interface's
                    // direction.
                    dir="auto"
                    className="text-xl leading-tight font-bold tracking-tight break-words outline-none @2xl/discover:text-2xl"
                  >
                    {title}
                  </h2>
                  {known && (
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-muted-foreground">
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <PublisherAvatar
                          handle={known.publisher.handle}
                          avatar={known.publisher.avatar}
                          className="size-5 rounded-full"
                        />
                        <bdi className="min-w-0 truncate font-medium text-foreground">
                          {known.publisher.name}
                        </bdi>
                      </span>
                      {stars > 0 && (
                        <>
                          <Dot />
                          <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
                            <Star aria-hidden="true" className="size-3.5" />
                            <span className="sr-only">{t("card.stars")}</span>
                            {formatCompact(stars, labels.locale)}
                          </span>
                        </>
                      )}
                      {updated && (
                        <>
                          <Dot />
                          <span className="shrink-0">
                            {t("detail.updatedOn", { date: updated })}
                          </span>
                        </>
                      )}
                      {item && view?.Byline && (
                        <>
                          <Dot />
                          <view.Byline item={item} />
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {known && (
                <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5 empty:hidden">
                  <RiskMark risk={known.risk} />
                  {known.status === "listed" ? (
                    <DiscoverMark>{t("card.listed")}</DiscoverMark>
                  ) : known.status !== "public" ? (
                    <DiscoverMark>{t("detail.statusUnknown")}</DiscoverMark>
                  ) : null}
                  <InstalledMarks installed={installed} />
                </div>
              )}
              {item && view?.Lead && (
                <div className="mt-4">
                  <view.Lead item={item} />
                </div>
              )}
              {summary && (
                <p
                  dir="auto"
                  className="mt-4 text-[0.9375rem] leading-relaxed text-foreground/80"
                >
                  {summary}
                </p>
              )}
              <div aria-hidden="true" className="mt-5 border-b" />
            </header>

            {/* Beside the body on a wide pane, staying in view down a long
                description; on a narrow one, between the heading and the
                body — what can be done comes before what there is to read. */}
            <aside className="min-w-0 space-y-3 @4xl/discover:sticky @4xl/discover:top-5 @4xl/discover:col-start-2 @4xl/discover:row-span-2 @4xl/discover:row-start-1 @4xl/discover:self-start">
              {(known || websiteUrl) && (
                <div className="overflow-hidden rounded-2xl border bg-card">
                  {known && <RiskBanner risk={known.risk} />}
                  <div className={ACTIONS_CLASS}>
                    {item && view?.Actions ? (
                      <view.Actions item={item} installed={installed} />
                    ) : detail.phase === "loading" ? (
                      Array.from({ length: loadingActions }, (_, index) => (
                        <Skeleton
                          key={index}
                          data-testid="discover-action-loading"
                          className="h-9 w-full rounded-full"
                        />
                      ))
                    ) : null}
                    {websiteUrl && (
                      <Button asChild variant="secondary">
                        <BrowserLink href={websiteUrl}>
                          <span className="truncate">
                            {t("detail.viewOnWebsite")}
                          </span>
                          <ExternalLink aria-hidden="true" />
                        </BrowserLink>
                      </Button>
                    )}
                  </div>
                </div>
              )}
              {item && view ? (
                <FactsPanel
                  item={item}
                  head={view.Facts ? <view.Facts item={item} /> : null}
                  sayRights={view.factsSayRights === true}
                />
              ) : detail.phase === "loading" ? (
                known && knownView ? (
                  <FactsSkeleton
                    rows={factRowsGuess(known, knownView)}
                    runtime={showsRuntime(known)}
                  />
                ) : (
                  <FactsSkeleton />
                )
              ) : null}
            </aside>

            <div className="min-w-0 @4xl/discover:col-start-1 @4xl/discover:row-start-2">
              {detail.phase === "error" && detail.error ? (
                <DiscoverFailure
                  failure={detail.error}
                  onRetry={() => retryDiscoverItem(slots)}
                />
              ) : !item || !view ? (
                <div
                  aria-hidden="true"
                  className="space-y-3"
                  data-testid="discover-detail-loading"
                >
                  <Skeleton className="h-5 w-1/4" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              ) : (
                <div className="min-w-0 space-y-8">
                  <ListedNotice item={item} />
                  <view.Body
                    item={item}
                    versions={detail.versions}
                    readme={detail.readme}
                    onRetryPart={(part) => retryDiscoverPart(slots, part)}
                  />
                </div>
              )}
            </div>
          </div>
        </article>
      </HarnessScroller>
      <p role="status" aria-live="polite" className="sr-only">
        {detail.phase === "loading" ? t("detail.loading") : ""}
      </p>
    </div>
  )
}
