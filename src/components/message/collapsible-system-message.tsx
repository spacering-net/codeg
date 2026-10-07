"use client"

import { memo } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, ChevronUp, Info } from "lucide-react"

import { cn } from "@/lib/utils"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { useCollapsibleOverflow } from "@/hooks/use-collapsible-overflow"

import { ContentPartsRenderer } from "./content-parts-renderer"

/**
 * System-role messages — context a transcript injected that nobody typed, e.g.
 * pi's branch summary or Qoder's compaction summary. A Claude Code continuation
 * summary lands here only when it finds no compaction divider to fold into;
 * whenever one is waiting the parser folds it into the divider's "Summary"
 * toggle instead (see `compaction_summary_slot` in `parsers/claude.rs`).
 *
 * Shows a *preview* rather than hiding the body behind a shut accordion: these
 * summaries are often the only record of what the context they replaced held,
 * so the first screenful is worth reading in place. Same clamp-then-toggle
 * affordance as the sibling plan card (`PlanMarkdownCard`) and user messages,
 * shared via `useCollapsibleOverflow` — identical `max-h-72`, bottom fade while
 * clipped, and a footer toggle that only appears once the body is actually cut
 * off.
 *
 * Takes `parts` rather than the whole `ResolvedMessageGroup` so this module
 * doesn't have to import back from `message-list-view` (its only caller).
 */
export const CollapsibleSystemMessage = memo(function CollapsibleSystemMessage({
  parts,
}: {
  parts: AdaptedContentPart[]
}) {
  const t = useTranslations("Folder.chat.messageList")
  const { contentRef, contentId, isOverflowing, expanded, toggle } =
    useCollapsibleOverflow<HTMLDivElement>(parts)

  const clipped = !expanded

  return (
    <div className="w-full overflow-hidden rounded-md border border-yellow-500/30 bg-yellow-500/5 text-sm">
      <div className="flex items-center gap-1.5 border-b border-yellow-500/20 bg-yellow-500/10 px-3 py-2 text-xs font-medium text-yellow-700 dark:text-yellow-400">
        <Info className="size-3.5 shrink-0" />
        {t("systemMessage")}
      </div>
      <div
        ref={contentRef}
        id={contentId}
        data-testid="collapsible-system-message-content"
        className={cn(
          "px-3 py-2.5 text-sm text-muted-foreground",
          clipped && "max-h-72 overflow-hidden",
          clipped && isOverflowing && "collapsed-content-fade"
        )}
      >
        <ContentPartsRenderer parts={parts} role="system" />
      </div>
      {isOverflowing && (
        <button
          type="button"
          data-testid="collapsible-system-message-toggle"
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={contentId}
          className="flex w-full items-center justify-center gap-1 border-t border-yellow-500/20 px-3 py-1.5 text-xs font-medium text-yellow-700/90 transition-colors hover:bg-yellow-500/10 dark:text-yellow-400/90"
        >
          {expanded ? t("showLess") : t("showMore")}
          {expanded ? (
            <ChevronUp className="size-3.5 shrink-0" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0" />
          )}
        </button>
      )}
    </div>
  )
})
