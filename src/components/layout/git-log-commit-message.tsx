"use client"

import { memo } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, ChevronUp } from "lucide-react"

import { CommitCopyButton } from "@/components/ai-elements/commit"
import { useCollapsibleOverflow } from "@/hooks/use-collapsible-overflow"
import { cn } from "@/lib/utils"

/**
 * An expanded commit's full message body. Release commits can run to dozens of
 * lines, which would push the file tree and branch list far off the bottom of
 * the (narrow) aux panel, so the body is capped and gets a "Show more"/"Show
 * less" toggle once it's actually clipped — same treatment as a chat user
 * message (see `CollapsibleUserMessage`), shared via `useCollapsibleOverflow`.
 */
export const GitLogCommitMessage = memo(function GitLogCommitMessage({
  message,
}: {
  message: string
}) {
  const t = useTranslations("Folder.gitLogTab")
  const { contentRef, contentId, isOverflowing, expanded, toggle } =
    useCollapsibleOverflow<HTMLParagraphElement>(message)

  const clipped = !expanded

  return (
    <div className="group/msg relative rounded-lg border border-border/60 bg-muted/20 p-2.5">
      <p
        ref={contentRef}
        id={contentId}
        data-testid="git-log-commit-message-content"
        className={cn(
          // pr-6 keeps the first line clear of the floating copy button.
          "text-xs whitespace-pre-wrap break-words pr-6",
          clipped && "max-h-48 overflow-hidden",
          clipped && isOverflowing && "collapsed-content-fade"
        )}
      >
        {message}
      </p>
      {isOverflowing && (
        <button
          type="button"
          data-testid="git-log-commit-message-toggle"
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={contentId}
          className="mt-1 flex shrink-0 items-center gap-1 text-2xs font-medium text-muted-foreground hover:text-foreground"
        >
          {expanded ? t("showLess") : t("showMore")}
          {expanded ? (
            <ChevronUp className="size-3 shrink-0" />
          ) : (
            <ChevronDown className="size-3 shrink-0" />
          )}
        </button>
      )}
      <CommitCopyButton
        className="absolute top-1.5 right-1.5 size-5 opacity-0 transition-opacity group-hover/msg:opacity-100 group-focus-within/msg:opacity-100"
        hash={message}
        title={t("copyMessage")}
      />
    </div>
  )
})
