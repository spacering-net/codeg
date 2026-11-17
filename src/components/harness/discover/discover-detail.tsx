"use client"

import { useEffect, useId, useLayoutEffect, useRef } from "react"
import { ArrowLeft, ExternalLink, Star } from "lucide-react"
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
} from "@/lib/harness/display"
import { isItemRef } from "@/lib/harness/item-ref"
import { useHarnessStatus } from "@/lib/harness/status"
import type { HarnessInstalledMark } from "@/lib/harness/types"
import { cn } from "@/lib/utils"
import { MachineText } from "../machine-text"
import { discoverKindView } from "./detail-kinds"
import { FactsPanel, ListedNotice } from "./detail-sections"
import { DiscoverMark, InstalledMarks, RiskMark } from "./discover-card"
import { DiscoverFailure } from "./discover-failure"
import { PublisherAvatar } from "./publisher-avatar"
import { useDiscoverLabels } from "./use-discover-labels"

interface DiscoverDetailProps {
  detail: DiscoverDetailState
  /** Back: to the detail this one was opened from, or to the list. */
  onBack: () => void
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
 * The frame is the same for every kind: a bar with the way back and the link
 * to the item's page on the website, then the heading — what it is called,
 * what it does, who publishes it — its particulars, and under those whatever
 * its kind supplies (`detail-kinds.tsx`).
 *
 * The heading is drawn from what the list already knew while the item itself
 * is on its way, and takes the focus when the detail opens, so a keyboard or
 * a screen reader lands on the item and not on the page's top.
 */
export function DiscoverDetail({
  detail,
  onBack,
  backTo = null,
  installed = null,
}: DiscoverDetailProps) {
  const t = useTranslations("Harness.discover")
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

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-2 py-1.5 ws-chrome-border max-md:gap-1 md:px-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          aria-label={
            backTitle !== null
              ? t.markup("detail.backTo", {
                  name: backTitle,
                  title: (chunks) => chunks,
                })
              : undefined
          }
          // A long title to go back to gives way, rather than pushing the
          // link to the website off the bar. "Back to the list" is short
          // and cannot be cut: there the link's own words give way instead.
          className={cn("min-w-0 max-md:h-10", backTitle !== null && "shrink")}
        >
          <ArrowLeft aria-hidden="true" className="rtl:rotate-180" />
          {backTitle !== null ? (
            <>
              <span className="min-w-0 truncate max-md:hidden">
                {t.rich("detail.backTo", {
                  name: backTitle,
                  title: (chunks) => <bdi>{chunks}</bdi>,
                })}
              </span>
              {/* On a phone there is room for the title alone, and the
                  arrow says the rest. */}
              <bdi className="min-w-0 truncate md:hidden">{backTitle}</bdi>
            </>
          ) : (
            t("detail.back")
          )}
        </Button>
        {websiteUrl && (
          <Button
            asChild
            variant="ghost"
            size="sm"
            className={cn(
              "ms-auto min-w-0 max-md:h-10",
              backTitle === null && "shrink"
            )}
          >
            <BrowserLink href={websiteUrl}>
              <span className="truncate">{t("detail.viewOnWebsite")}</span>
              <ExternalLink aria-hidden="true" />
            </BrowserLink>
          </Button>
        )}
      </div>

      <div
        ref={scrollerRef}
        onScroll={(event) =>
          slots.set(DISCOVER_DETAIL_SCROLL, event.currentTarget.scrollTop)
        }
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
      >
        <article
          aria-labelledby={headingId}
          aria-busy={detail.phase === "loading"}
          className="mx-auto w-full max-w-6xl min-w-0 px-3 py-4 md:px-5"
        >
          <header className="min-w-0 space-y-2">
            {known && (
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <DiscoverMark>{labels.kind(known.kind)}</DiscoverMark>
                <RiskMark risk={known.risk} />
                {known.status === "listed" ? (
                  <DiscoverMark>{t("card.listed")}</DiscoverMark>
                ) : known.status !== "public" ? (
                  <DiscoverMark>{t("detail.statusUnknown")}</DiscoverMark>
                ) : null}
                <InstalledMarks installed={installed} />
              </div>
            )}
            <h2
              id={headingId}
              ref={headingRef}
              tabIndex={-1}
              // The item's own language, or — before anything is known of
              // it — its address: either way not the interface's direction.
              dir="auto"
              className="text-lg leading-snug font-semibold break-words outline-none"
            >
              {title}
            </h2>
            {item && view?.Lead && <view.Lead item={item} />}
            {summary && (
              <p
                dir="auto"
                className="text-sm leading-relaxed text-muted-foreground"
              >
                {summary}
              </p>
            )}
            {known && (
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <PublisherAvatar
                    handle={known.publisher.handle}
                    avatar={known.publisher.avatar}
                  />
                  <bdi className="min-w-0 truncate text-foreground">
                    {known.publisher.name}
                  </bdi>
                </span>
                <bdi dir="ltr" className="min-w-0 font-mono">
                  <MachineText>{known.ref}</MachineText>
                </bdi>
                {stars > 0 && (
                  <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
                    <Star aria-hidden="true" className="size-3" />
                    <span className="sr-only">{t("card.stars")}</span>
                    {formatCompact(stars, labels.locale)}
                  </span>
                )}
                {updated && (
                  <span className="shrink-0">
                    {t("detail.updatedOn", { date: updated })}
                  </span>
                )}
                {item && view?.Byline && <view.Byline item={item} />}
              </div>
            )}
            {item && view?.Actions && (
              <div className="flex min-w-0 flex-wrap items-center gap-2 pt-1">
                <view.Actions item={item} installed={installed} />
              </div>
            )}
          </header>

          {detail.phase === "error" && detail.error ? (
            <DiscoverFailure
              failure={detail.error}
              onRetry={() => retryDiscoverItem(slots)}
            />
          ) : !item || !view ? (
            <div
              aria-hidden="true"
              className="mt-6 space-y-3"
              data-testid="discover-detail-loading"
            >
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-2/3" />
            </div>
          ) : (
            // The particulars come first in the document, so on a narrow
            // pane they are read before a long description; beside a wide
            // one they are a column at its end.
            <div className="mt-5 grid min-w-0 gap-5 @4xl/discover:grid-cols-[minmax(0,1fr)_17rem] @4xl/discover:gap-6">
              <aside className="min-w-0 @4xl/discover:col-start-2 @4xl/discover:row-start-1">
                <FactsPanel
                  item={item}
                  head={view.Facts ? <view.Facts item={item} /> : null}
                  sayRights={view.factsSayRights === true}
                />
              </aside>
              <div className="min-w-0 space-y-6 @4xl/discover:col-start-1 @4xl/discover:row-start-1">
                <ListedNotice item={item} />
                <view.Body
                  item={item}
                  versions={detail.versions}
                  readme={detail.readme}
                  onRetryPart={(part) => retryDiscoverPart(slots, part)}
                />
              </div>
            </div>
          )}
        </article>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {detail.phase === "loading" ? t("detail.loading") : ""}
      </p>
    </div>
  )
}
