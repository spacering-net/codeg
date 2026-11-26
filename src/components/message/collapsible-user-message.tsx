"use client"

import { memo, useMemo } from "react"
import { useLocale, useTranslations } from "next-intl"
import { ChevronDown, ChevronUp } from "lucide-react"

import { cn } from "@/lib/utils"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { useCollapsibleOverflow } from "@/hooks/use-collapsible-overflow"
import { useOptionalWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabActions } from "@/stores/tab-store"
import { formatConversationTitle } from "@/lib/conversation-title"
import {
  parseSessionMessageText,
  type SessionMessageAnchor,
} from "@/lib/session-message-text"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

import { ContentPartsRenderer } from "./content-parts-renderer"
import { useSessionMessageJump } from "./session-message-anchor"

function SessionMessageSource({
  id,
  anchor,
}: {
  id: string
  anchor?: SessionMessageAnchor
}) {
  const t = useTranslations("Folder.chat.messageList")
  const conversation = useAppWorkspaceStore((state) =>
    state.conversations.find((candidate) => candidate.id === Number(id))
  )
  const { openTab } = useTabActions()
  const route = useOptionalWorkbenchRoute()
  const title = formatConversationTitle(conversation?.title).trim() || `#${id}`
  const label = t("sessionMessageSource", { session: title })
  if (!conversation) {
    return <span className="text-xs text-muted-foreground">{label}</span>
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="min-w-0 cursor-pointer truncate text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => {
              useSessionMessageJump.setState({
                pending: anchor
                  ? { conversationId: conversation.id, anchor }
                  : null,
              })
              route?.openConversations()
              openTab(
                conversation.folder_id,
                conversation.id,
                conversation.agent_type,
                true,
                conversation.title ?? undefined
              )
            }}
          >
            {label}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-80 break-words">
          {title}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function splitSessionMessageSource(parts: AdaptedContentPart[]): {
  source: string | null
  anchor?: SessionMessageAnchor
  parts: AdaptedContentPart[]
} {
  const index = parts.findIndex((part) => part.type === "text")
  const part = parts[index]
  if (!part || part.type !== "text") return { source: null, parts }

  const message = parseSessionMessageText(part.text)
  if (!message) return { source: null, parts }

  const { source, text, anchor } = message
  const cleaned = parts.slice()
  cleaned[index] = { ...part, text }
  return { source, parts: cleaned, ...(anchor && { anchor }) }
}

/**
 * Caps a user message's rendered height (mirrors Codex desktop) and reveals a
 * "Show more"/"Show less" toggle once it's actually clipped. Assistant
 * messages are out of scope by design — this is only ever used from the
 * `group.role === "user"` branch in `HistoricalMessageGroup`, so `role` isn't
 * a prop here.
 */
export const CollapsibleUserMessage = memo(function CollapsibleUserMessage({
  parts,
  timestamp,
}: {
  parts: AdaptedContentPart[]
  timestamp?: string
}) {
  const locale = useLocale()
  const t = useTranslations("Folder.chat.messageList")
  const message = useMemo(() => splitSessionMessageSource(parts), [parts])
  const receivedAt = message.source && timestamp ? Date.parse(timestamp) : NaN
  const { contentRef, contentId, isOverflowing, expanded, toggle } =
    useCollapsibleOverflow<HTMLDivElement>(message.parts)

  const clipped = !expanded

  return (
    <>
      {message.source && (
        <div className="flex min-w-0 items-baseline gap-x-2">
          <SessionMessageSource id={message.source} anchor={message.anchor} />
          {Number.isFinite(receivedAt) && (
            <time
              dateTime={timestamp}
              title={new Intl.DateTimeFormat(locale, {
                dateStyle: "medium",
                timeStyle: "medium",
              }).format(receivedAt)}
              className="shrink-0 text-xs text-muted-foreground tabular-nums"
            >
              {new Intl.DateTimeFormat(locale, {
                timeStyle: "medium",
              }).format(receivedAt)}
            </time>
          )}
        </div>
      )}
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
        <ContentPartsRenderer parts={message.parts} role="user" />
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
