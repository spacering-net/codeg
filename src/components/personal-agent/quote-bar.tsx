"use client"

/**
 * The quote at the top of a message: who said it and one line of it. A click
 * jumps to it. The quoted row is looked up where the page holds it, else
 * fetched by id (it may be older than what is loaded); a row that does not
 * exist says so and is not a link. While it loads, a fixed-height placeholder
 * keeps the message from growing under the reader.
 */

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { X } from "lucide-react"

import { usePersonalAgent } from "@/contexts/personal-agent-context"
import type { TimelineRow } from "@/lib/types"
import { cn } from "@/lib/utils"

import {
  excerptOf,
  INSET_HOVER,
  INSET_SURFACE,
  str,
  usePageScope,
} from "./shared"

/** Who wrote a row, as a quote names them. */
export function useQuoteAuthor(): (row: TimelineRow) => string {
  const t = useTranslations("PersonalAgent.quote")
  const { agentName } = usePageScope()
  return (row) => {
    switch (row.kind) {
      case "owner":
        return t("you")
      case "result":
        return str(row.data, "executor") ?? agentName
      default:
        return agentName
    }
  }
}

/** One line of what a row says. */
export function useQuoteExcerpt(): (row: TimelineRow) => string {
  const t = useTranslations("PersonalAgent.quote")
  return (row) => {
    switch (row.kind) {
      case "result": {
        const title = str(row.data, "title")
        const excerpt = str(row.data, "excerpt")
        return excerptOf(
          [title, excerpt ?? (title ? null : row.body)]
            .filter(Boolean)
            .join(" — ")
        )
      }
      case "dispatch":
        return t("dispatch", { title: excerptOf(row.body) })
      case "owner": {
        const text = excerptOf(row.body)
        return text || t("attachment")
      }
      default:
        return excerptOf(row.body) || t("noText")
    }
  }
}

/** The held row, the fetched one, `null` when it does not exist, or
 *  `undefined` while it is being looked up. */
export function useQuotedRow(id: number): TimelineRow | null | undefined {
  const { quoted, requestQuoted } = usePersonalAgent()
  const { rowsById } = usePageScope()
  const held = rowsById.get(id)
  const fetched = quoted.get(id)
  const missing = held === undefined && fetched === undefined
  useEffect(() => {
    if (missing) requestQuoted([id])
  }, [missing, id, requestQuoted])
  if (held) return held
  return fetched
}

export function QuoteBar({
  targetId,
  className,
  onDismiss,
  tone = "muted",
}: {
  targetId: number
  className?: string
  /** Shown in the composer: the quote can be taken back. */
  onDismiss?: () => void
  /** `light` inside a bubble (the owner's, the assistant's): the bubble's
   *  colour a step deeper, as the other surfaces in it; a shade over the
   *  page otherwise (the input box). */
  tone?: "muted" | "light"
}) {
  const t = useTranslations("PersonalAgent.quote")
  const { jumpTo } = usePageScope()
  const row = useQuotedRow(targetId)
  const author = useQuoteAuthor()
  const excerpt = useQuoteExcerpt()
  const block = cn(
    "flex min-w-0 flex-1 flex-col items-stretch justify-center rounded-md border-s-2 px-2 py-1 text-start text-xs leading-snug",
    tone === "light"
      ? cn("border-primary/50", INSET_SURFACE)
      : "border-primary/45 bg-foreground/[0.045]"
  )
  if (row === undefined) {
    return (
      <div className={cn("flex min-w-0", className)} aria-hidden>
        <span className={cn(block, "h-[2.5625rem] gap-1.5")}>
          <span className="h-2 w-16 rounded-full bg-foreground/10 motion-safe:animate-pulse" />
          <span className="h-2 w-40 max-w-full rounded-full bg-foreground/10 motion-safe:animate-pulse" />
        </span>
      </div>
    )
  }
  if (row === null) {
    return (
      <div className={cn("flex min-w-0 items-center gap-1", className)}>
        <span className={cn(block, "border-border text-muted-foreground")}>
          <span className="py-0.5 italic">{t("unavailable")}</span>
        </span>
        {onDismiss ? <DismissButton onDismiss={onDismiss} /> : null}
      </div>
    )
  }
  return (
    <div className={cn("flex min-w-0 items-center gap-1", className)}>
      <button
        type="button"
        className={cn(
          block,
          "transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          tone === "light" ? INSET_HOVER : "hover:bg-foreground/[0.08]"
        )}
        onClick={() => jumpTo(row.id)}
        title={t("jump")}
      >
        <span className="block truncate font-medium text-foreground/85">
          {author(row)}
        </span>
        <span className="block truncate text-muted-foreground">
          {excerpt(row)}
        </span>
      </button>
      {onDismiss ? <DismissButton onDismiss={onDismiss} /> : null}
    </div>
  )
}

function DismissButton({ onDismiss }: { onDismiss: () => void }) {
  const t = useTranslations("PersonalAgent.quote")
  return (
    <button
      type="button"
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
      onClick={onDismiss}
      title={t("dismiss")}
      aria-label={t("dismiss")}
    >
      <X className="size-3.5" />
    </button>
  )
}
