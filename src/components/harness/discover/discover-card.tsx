"use client"

import { memo } from "react"
import {
  ArrowUpCircle,
  BookOpenText,
  Bot,
  Cable,
  CircleCheck,
  MessageSquareText,
  Package,
  PlugZap,
  Puzzle,
  Star,
  type LucideIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"

import {
  formatCompact,
  itemSummary,
  itemTitle,
  knownKind,
  knownRisk,
  showsRuntime,
} from "@/lib/harness/display"
import type {
  HarnessInstalledMark,
  HarnessItemSummary,
  HarnessKnownKind,
} from "@/lib/harness/types"
import { cn } from "@/lib/utils"
import { useDiscoverLabels } from "./use-discover-labels"

/** A kind's glyph — the Skills and MCP ones are the section nav's. */
const KIND_ICONS: Record<HarnessKnownKind | "unknown", LucideIcon> = {
  skill: BookOpenText,
  mcp: PlugZap,
  prompt: MessageSquareText,
  assistant: Bot,
  connector: Cable,
  plugin: Puzzle,
  unknown: Package,
}

/** A kind's glyph; a box for a kind this build does not know. */
export function KindIcon({
  kind,
  className,
}: {
  kind: string
  className?: string
}) {
  const Icon = KIND_ICONS[knownKind(kind) ?? "unknown"]
  return <Icon aria-hidden="true" className={className} />
}

/** The small marks along a card's foot and a detail's head. */
export function DiscoverMark({
  tone = "neutral",
  size = "md",
  className,
  children,
}: {
  tone?: "neutral" | "warning" | "danger" | "success" | "info"
  /** `sm` in a list's rows, where a mark sits beside a line of small text. */
  size?: "sm" | "md"
  className?: string
  children: React.ReactNode
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full shrink-0 items-center gap-1 rounded-full border whitespace-nowrap [&>svg]:shrink-0",
        size === "md"
          ? "h-6 px-2.5 text-xs [&>svg]:size-3.5"
          : "h-5 px-2 text-2xs [&>svg]:size-3",
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

/** A kind's glyph in its tile, at the head of a card and of a detail. */
export function KindTile({
  kind,
  className,
  iconClassName,
}: {
  kind: string
  className?: string
  iconClassName?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/60 text-foreground/80",
        className
      )}
    >
      <KindIcon kind={kind} className={cn("size-[1.125rem]", iconClassName)} />
    </span>
  )
}

/** A card's chips: the kind, filled; where it runs, outlined. */
function Chip({
  filled = false,
  children,
}: {
  filled?: boolean
  children: React.ReactNode
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 max-w-full min-w-0 shrink-0 items-center rounded-full px-2.5 text-xs whitespace-nowrap",
        filled
          ? "bg-muted text-foreground/80"
          : "border border-border text-muted-foreground"
      )}
    >
      <bdi className="min-w-0 truncate">{children}</bdi>
    </span>
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
  /** A card of the grid, or a row of the list. */
  layout?: "grid" | "list"
}

/**
 * One item of the results, as a card of the grid or a row of the list.
 *
 * The title is its one control: a button whose hit area is stretched over
 * the whole card, so the card opens wherever it is pressed while a screen
 * reader hears a list of titles, each followed by what the card says about
 * it. Every row has the same height on every card — a title and its
 * publisher on a line each, a summary on two, the chips on one — so nothing
 * moves when a longer summary arrives, which is what lets the list be put
 * back at the exact offset it was left at.
 *
 * Everything written here is the catalog's text, shown as text.
 */
export const DiscoverCard = memo(function DiscoverCard({
  item,
  installed,
  onOpen,
  layout = "grid",
}: DiscoverCardProps) {
  const t = useTranslations("Harness.discover.card")
  const labels = useDiscoverLabels()
  const title = itemTitle(item, labels.lang)
  const summary = itemSummary(item, labels.lang)
  const stars = item.repoStars ?? 0

  const titleButton = (
    <button
      type="button"
      data-harness-item={item.ref}
      // The title is in the item's language, not necessarily the
      // interface's: it takes its direction from its own text, so a long
      // English title is cut at its end in an Arabic interface too.
      dir="auto"
      onClick={() => onOpen(item)}
      className={cn(
        "block w-full truncate text-start outline-none after:absolute after:inset-0",
        layout === "grid" ? "after:rounded-2xl" : "after:rounded-xl"
      )}
    >
      {title}
    </button>
  )
  const starCount = stars > 0 && (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
      <Star aria-hidden="true" className="size-3.5" />
      <span className="sr-only">{t("stars")}</span>
      {formatCompact(stars, labels.locale)}
    </span>
  )
  const chips = (
    <>
      <Chip filled>{labels.kind(item.kind)}</Chip>
      {showsRuntime(item) && <Chip>{labels.runtime(item.runtime)}</Chip>}
      <RiskMark risk={item.risk} />
      {item.status === "listed" && <DiscoverMark>{t("listed")}</DiscoverMark>}
      <InstalledMarks installed={installed} />
    </>
  )
  const hover =
    "transition-[background-color,border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50"

  if (layout === "list") {
    return (
      <li
        className={cn(
          "relative flex min-w-0 items-center gap-3 rounded-xl border bg-card p-4 hover:border-foreground/15 hover:shadow-sm",
          hover
        )}
      >
        <KindTile
          kind={item.kind}
          className="size-8 rounded-lg"
          iconClassName="size-4"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <h3 className="min-w-0 shrink text-sm font-semibold">
              {titleButton}
            </h3>
            <bdi className="min-w-0 shrink-[2] truncate text-xs text-muted-foreground">
              {item.publisher.name}
            </bdi>
          </div>
          <p
            dir="auto"
            className="mt-0.5 truncate text-[0.8125rem] text-muted-foreground"
          >
            {summary}
          </p>
        </div>
        <div className="hidden max-w-[40%] shrink-0 items-center gap-1.5 overflow-hidden @2xl/discover:flex">
          {chips}
        </div>
        <div className="flex w-16 shrink-0 justify-end">{starCount}</div>
      </li>
    )
  }

  return (
    <li
      className={cn(
        "relative flex min-w-0 flex-col rounded-xl border bg-card p-4 hover:border-foreground/15 hover:shadow-sm",
        hover
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <KindTile kind={item.kind} />
        <div className="min-w-0 flex-1">
          <h3 className="min-w-0 text-[0.9375rem] leading-6 font-semibold">
            {titleButton}
          </h3>
          <bdi className="block min-w-0 truncate text-[0.8125rem] leading-5 text-muted-foreground">
            {item.publisher.name}
          </bdi>
        </div>
        <span className="mt-1 shrink-0">{starCount}</span>
      </div>
      <p
        dir="auto"
        className="mt-3 line-clamp-2 min-h-10 text-[0.8125rem] leading-5 text-muted-foreground"
      >
        {summary}
      </p>
      <div className="mt-3 flex h-6 min-w-0 items-center gap-1.5 overflow-hidden">
        {chips}
      </div>
    </li>
  )
})
