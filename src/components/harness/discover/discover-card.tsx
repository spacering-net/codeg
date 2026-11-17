"use client"

import { memo } from "react"
import { ArrowUpCircle, CircleCheck, Star } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  formatCompact,
  itemSummary,
  itemTitle,
  knownRisk,
  showsRuntime,
} from "@/lib/harness/display"
import type {
  HarnessInstalledMark,
  HarnessItemSummary,
} from "@/lib/harness/types"
import { cn } from "@/lib/utils"
import { PublisherAvatar } from "./publisher-avatar"
import { useDiscoverLabels } from "./use-discover-labels"

/** The small marks along a card's foot and a detail's head. */
export function DiscoverMark({
  tone = "neutral",
  className,
  children,
}: {
  tone?: "neutral" | "warning" | "danger" | "success" | "info"
  className?: string
  children: React.ReactNode
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-full shrink-0 items-center gap-1 rounded-full border px-1.5 text-2xs font-medium whitespace-nowrap [&>svg]:size-3 [&>svg]:shrink-0",
        tone === "neutral" && "border-border bg-muted/50 text-muted-foreground",
        tone === "warning" &&
          "border-tone-warning/30 bg-tone-warning/10 text-tone-warning",
        tone === "danger" &&
          "border-tone-danger/30 bg-tone-danger/10 text-tone-danger",
        tone === "success" &&
          "border-tone-success/30 bg-tone-success/10 text-tone-success",
        tone === "info" && "border-tone-info/30 bg-tone-info/10 text-tone-info",
        className
      )}
    >
      {children}
    </span>
  )
}

/**
 * An item's risk, where it is worth a mark. Low risk is the ordinary case and
 * says nothing; medium is marked, and so is anything that is not low — a high
 * risk or a level this build does not know must not pass for "fine".
 */
export function RiskMark({ risk }: { risk: string }) {
  const labels = useDiscoverLabels()
  const known = knownRisk(risk)
  if (known === "low") return null
  return (
    <DiscoverMark
      tone={
        known === "medium" ? "warning" : known === "high" ? "danger" : "neutral"
      }
    >
      {labels.risk(risk)}
    </DiscoverMark>
  )
}

/** "Installed" and "Update available", from what the host has of an item.
 *  Renders nothing without a mark — and none is supplied yet. */
export function InstalledMarks({
  installed,
}: {
  installed: HarnessInstalledMark | null | undefined
}) {
  const t = useTranslations("Harness.discover.card")
  if (!installed) return null
  return (
    <>
      <DiscoverMark tone="success">
        <CircleCheck aria-hidden="true" />
        {t("installed")}
      </DiscoverMark>
      {installed.updateAvailable && (
        <DiscoverMark tone="info">
          <ArrowUpCircle aria-hidden="true" />
          {t("updateAvailable")}
        </DiscoverMark>
      )}
    </>
  )
}

interface DiscoverCardProps {
  item: HarnessItemSummary
  /**
   * What the workspace's host has of this item — "installed", "update
   * available". Left out until the install steps can say; a card never
   * guesses.
   */
  installed?: HarnessInstalledMark | null
  onOpen: (item: HarnessItemSummary) => void
}

/**
 * One item of the list.
 *
 * The title is the card's one control: a button whose hit area is stretched
 * over the whole card, so the card opens wherever it is pressed while a
 * screen reader hears a list of titles, each followed by what the card says
 * about it. Every row has the same height on every card — a title on one
 * line, a summary on two, the marks on one — so nothing moves when a picture
 * or a longer summary arrives, which is what lets the list be put back at the
 * exact offset it was left at.
 *
 * Everything written here is the catalog's text, shown as text.
 */
export const DiscoverCard = memo(function DiscoverCard({
  item,
  installed,
  onOpen,
}: DiscoverCardProps) {
  const t = useTranslations("Harness.discover.card")
  const labels = useDiscoverLabels()
  const title = itemTitle(item, labels.lang)
  const summary = itemSummary(item, labels.lang)
  const stars = item.repoStars ?? 0

  return (
    <li className="relative flex min-w-0 flex-col gap-1.5 rounded-lg border bg-card p-3 transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 hover:bg-muted/40">
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <PublisherAvatar
          handle={item.publisher.handle}
          avatar={item.publisher.avatar}
        />
        <bdi className="min-w-0 truncate">{item.publisher.name}</bdi>
        {stars > 0 && (
          <span className="ms-auto inline-flex shrink-0 items-center gap-1 tabular-nums">
            <Star aria-hidden="true" className="size-3" />
            <span className="sr-only">{t("stars")}</span>
            {formatCompact(stars, labels.locale)}
          </span>
        )}
      </div>
      <h3 className="min-w-0 text-sm font-medium">
        <button
          type="button"
          data-harness-item={item.ref}
          // The title is in the item's language, not necessarily the
          // interface's: it takes its direction from its own text, so a
          // long English title is cut at its end in an Arabic interface too.
          dir="auto"
          onClick={() => onOpen(item)}
          className="block w-full truncate text-start outline-none after:absolute after:inset-0 after:rounded-lg"
        >
          {title}
        </button>
      </h3>
      <p
        dir="auto"
        className="line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground"
      >
        {summary}
      </p>
      <div className="mt-auto flex min-h-5 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
        <span className="shrink-0">{labels.kind(item.kind)}</span>
        {showsRuntime(item) && (
          <>
            <span aria-hidden="true">·</span>
            <bdi className="min-w-0 truncate">
              {labels.runtime(item.runtime)}
            </bdi>
          </>
        )}
        <RiskMark risk={item.risk} />
        {item.status === "listed" && <DiscoverMark>{t("listed")}</DiscoverMark>}
        <InstalledMarks installed={installed} />
      </div>
    </li>
  )
})
