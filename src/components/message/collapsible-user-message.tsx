"use client"

import { memo } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, ChevronUp } from "lucide-react"

import { cn } from "@/lib/utils"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { useCollapsibleOverflow } from "@/hooks/use-collapsible-overflow"

import { ContentPartsRenderer } from "./content-parts-renderer"

/**
 * Caps a user message's rendered height (mirrors Codex desktop) and reveals a
 * "Show more"/"Show less" toggle once it's actually clipped. Assistant
 * messages are out of scope by design — this is only ever used from the
 * `group.role === "user"` branch in `HistoricalMessageGroup`, so `role` isn't
 * a prop here.
 */
export const CollapsibleUserMessage = memo(function CollapsibleUserMessage({
  parts,
  revealToken,
}: {
  parts: AdaptedContentPart[]
  revealToken?: number
}) {
  const t = useTranslations("Folder.chat.messageList")
  const { contentRef, contentId, isOverflowing, expanded, toggle } =
    useCollapsibleOverflow<HTMLDivElement>(parts, revealToken)

  const clipped = !expanded

  return (
    <>
      <div
        ref={contentRef}
        id={contentId}
        data-testid="collapsible-user-message-content"
        className={cn(
          "min-w-0",
          clipped && "max-h-60 overflow-hidden",
          clipped && isOverflowing && "collapsed-content-fade"
        )}
      >
        <ContentPartsRenderer parts={parts} role="user" />
      </div>
      {isOverflowing && (
        <button
          type="button"
          data-testid="collapsible-user-message-toggle"
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={contentId}
          className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {expanded ? t("showLess") : t("showMore")}
          {expanded ? (
            <ChevronUp className="size-3.5 shrink-0" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0" />
          )}
        </button>
      )}
    </>
  )
})
