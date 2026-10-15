"use client"

/**
 * Inline-start overlay listing the Agent Teams members streaming on this
 * connection — the receiving end of the backend's member-channel reroute.
 *
 * The CLI's contract has two halves: a member frame tagged
 * `codebuddy.ai/memberEvent` must never enter the main conversation area, AND
 * it must reach the member's own timeline (docs/cn/cli/acp.md §成员流式消息).
 * The "而非主对话区" half has held since 480568c9; this panel is the receiving
 * half — the backend emits `member_chunk`, and this renders it per member,
 * mirroring the web UI's per-member bucketing.
 *
 * Chrome mirrors `SubAgentOverlay` (same overlay stack, collapse-to-a-chip
 * behaviour, same card sizing): the panel starts as a chip and expands into a
 * card with one collapsible section per member. Inside a section, prose and
 * thinking reuse the main thread's own presenters (`MessageResponse` /
 * `Reasoning`) so member text reads exactly like the transcript's; a tool frame
 * is a deliberately weak one-line row (title + status) — v1 has no rich tool
 * rendering on the member channel.
 *
 * State comes entirely from `useMemberTimelineStore` (see it for the
 * buffer/echo/idempotency contract). The store is keyed by the connection's
 * contextKey, so a read-only embed that doesn't know one renders nothing.
 */

import { memo, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDownIcon,
  ChevronRightIcon,
  MessageSquareReplyIcon,
  UsersIcon,
  WrenchIcon,
} from "lucide-react"

import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning"
import { MessageResponse } from "@/components/ai-elements/message"
import { CollapsedOverlayChip } from "@/components/chat/collapsed-overlay-chip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/instant-collapsible"
import {
  useMemberTimelineStore,
  type MemberTimelineItem,
} from "@/stores/member-timeline-store"
import { cn } from "@/lib/utils"

interface MemberTimelineOverlayProps {
  /** The connection this transcript is attached to (its tab id / contextKey).
   *  Omitted (or null) on surfaces without one → the panel renders nothing. */
  contextKey?: string | null
}

export const MemberTimelineOverlay = memo(function MemberTimelineOverlay({
  contextKey,
}: MemberTimelineOverlayProps) {
  const t = useTranslations("Folder.chat.memberTimeline")
  const members = useMemberTimelineStore((s) =>
    contextKey ? s.byContext[contextKey] : undefined
  )
  const names = useMemo(() => (members ? Object.keys(members) : []), [members])
  // Collapse state per connection, mirroring the sibling overlays. The panel
  // and its sections remount when `MessageListView` re-keys this on a new
  // conversation, so the map only ever holds the current tab's key.
  const [collapsedByKey, setCollapsedByKey] = useState<Record<string, boolean>>(
    {}
  )

  if (!contextKey || names.length === 0) return null

  const stateKey = contextKey
  const userCollapsed = collapsedByKey[stateKey]
  // Collapsed by default, like the plan and sub-agent panels next to it.
  const isExpanded = userCollapsed !== undefined ? !userCollapsed : false

  if (!isExpanded) {
    return (
      <CollapsedOverlayChip
        icon={<UsersIcon className="size-3" />}
        summary={t("collapsedSummary", { count: names.length })}
        onClick={() =>
          setCollapsedByKey((prev) => ({ ...prev, [stateKey]: false }))
        }
      />
    )
  }

  return (
    <div className="pointer-events-none flex max-w-[min(22rem,calc(100%-2rem))]">
      <div className="pointer-events-auto w-72 max-w-full rounded-xl border bg-card/60 hover:bg-card/95 shadow-lg backdrop-blur transition-colors supports-[backdrop-filter]:bg-card/50 supports-[backdrop-filter]:hover:bg-card/85">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <UsersIcon className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium truncate">{t("title")}</span>
            <Badge variant="secondary" className="h-5">
              {names.length}
            </Badge>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("collapseAria")}
            onClick={() =>
              setCollapsedByKey((prev) => ({ ...prev, [stateKey]: true }))
            }
          >
            <ChevronDownIcon className="h-4 w-4" />
          </Button>
        </div>

        <div className="max-h-96 overflow-y-auto p-2 space-y-2">
          {names.map((name) => (
            <MemberSection
              key={name}
              name={name}
              items={members?.[name] ?? []}
            />
          ))}
        </div>
      </div>
    </div>
  )
})

const MemberSection = memo(function MemberSection({
  name,
  items,
}: {
  name: string
  items: MemberTimelineItem[]
}) {
  // Sections open so the rerouted content is visible as soon as the panel is;
  // collapsing per member is available for the busy case.
  const [open, setOpen] = useState(true)
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-lg border border-border/60"
    >
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/50">
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
        <span className="min-w-0 truncate text-xs font-semibold text-foreground">
          {name}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-2 px-2.5 pb-2.5 pt-0.5">
          {items.map((item) => (
            <MemberItemRow key={item.id} item={item} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
})

function MemberItemRow({ item }: { item: MemberTimelineItem }) {
  const t = useTranslations("Folder.chat.memberTimeline")
  switch (item.kind) {
    case "message":
      // Same prose presenter (and streaming/finished modes) as the main
      // thread's text parts, so member prose reads identically.
      return (
        <div className="break-words text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside [&_[data-streamdown='code-block-body']]:max-h-96 [&_[data-streamdown='code-block-body']]:overflow-auto">
          <MessageResponse
            mode={item.final ? "static" : "streaming"}
            parseIncompleteMarkdown={!item.final}
          >
            {item.text}
          </MessageResponse>
        </div>
      )
    case "thought": {
      // The main thread's reasoning chrome, same expand rule.
      const hasContent = item.text.trim().length > 0
      const expandable = hasContent || !item.final
      return (
        <Reasoning isStreaming={!item.final} expandable={expandable}>
          <ReasoningTrigger />
          {expandable && <ReasoningContent>{item.text}</ReasoningContent>}
        </Reasoning>
      )
    }
    case "user":
      // A message delivered to the member (team lead / kickoff). Kept visually
      // distinct from the member's own prose: quieter, plain text, no markdown.
      return (
        <div className="rounded-md border-s-2 border-border bg-muted/40 px-2 py-1.5">
          <div className="mb-0.5 flex items-center gap-1 text-muted-foreground">
            <MessageSquareReplyIcon
              aria-hidden="true"
              className="size-3 shrink-0"
            />
            <span className="text-2xs uppercase tracking-wide">
              {t("userEchoLabel")}
            </span>
          </div>
          <div className="text-xs break-words whitespace-pre-wrap">
            {item.text}
          </div>
        </div>
      )
    case "tool":
      // v1: one weakened line — title + (localized) status, no rich card.
      return (
        <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <WrenchIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span
            className="min-w-0 flex-1 truncate text-xs"
            title={item.title ?? item.toolCallId}
          >
            {item.title ?? item.toolCallId}
          </span>
          {item.status && (
            <span className="shrink-0 text-2xs">
              {toolStatusLabel(t, item.status)}
            </span>
          )}
        </div>
      )
  }
}

/**
 * Localized label for an ACP tool status. The backend forwards the status via
 * the main thread's own `format!("{:?}").to_lowercase()` conversion, so an
 * in-progress frame reads `inprogress`; `in_progress` is accepted too because
 * that is what the field's own vocabulary (and history) uses. Unknown statuses
 * fall back to the raw wire text rather than guessing.
 */
function toolStatusLabel(
  t: (
    key: "statusPending" | "statusRunning" | "statusCompleted" | "statusFailed"
  ) => string,
  status: string
): string {
  switch (status.trim().toLowerCase()) {
    case "pending":
      return t("statusPending")
    case "inprogress":
    case "in_progress":
    case "running":
      return t("statusRunning")
    case "completed":
      return t("statusCompleted")
    case "failed":
      return t("statusFailed")
    default:
      return status
  }
}
