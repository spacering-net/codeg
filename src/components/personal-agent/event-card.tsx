"use client"

/**
 * News about work the assistant handed out, as a message from the assistant
 * that ran it. On top, the work's row — the one the reply that handed it out
 * carries (`WorkRow`), so the two read as the same work: that assistant's
 * avatar with its agent's mark, the work's title, who ran it as what and
 * where, how it stood when the news came, and the way to its session. Under
 * it, the note it ended with, and its result as the message's text: markdown
 * at the size of a reply's, cut at a few lines and faded, with the way to
 * read the rest under it. The latest news of a task carries its task card
 * (`TaskStrip`, 8.5) under the row. It quotes the reply that dispatched (or last
 * continued) the work, unless that is the message right above. Unread until
 * the assistant starts on it.
 */

import { useTranslations } from "next-intl"
import { ChevronDown, ChevronUp } from "lucide-react"

import { JsonRenderScope } from "@/components/ai-elements/json-render-pre"
import { MessageResponse } from "@/components/ai-elements/message"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { useCollapsibleOverflow } from "@/hooks/use-collapsible-overflow"
import type { AgentType } from "@/lib/types"
import { cn } from "@/lib/utils"

import type { MessageItem } from "./message-items"
import { bubbleCorners, MessageRow } from "./message-row"
import { QuoteBar } from "./quote-bar"
import {
  AGENT_SURFACE,
  asDispatchState,
  asMode,
  BUBBLE_MARKDOWN,
  canOpenWork,
  DispatchStateChip,
  MARKDOWN_LIST_ROOM,
  num,
  str,
  UnreadMark,
  useOpenWork,
  useWorkMeta,
  workTargetOf,
} from "./shared"
import { asLadder, LadderChip, TaskStrip } from "./task-strip"
import { WORK_WELL, WorkRow } from "./work-card"

type EventItem = Extract<MessageItem, { kind: "event" }>

/** The notes codeg writes itself (a restart, a lost connection, a deleted
 *  task), by what brought the news: worded in the owner's language. Any
 *  other note is an agent's own error, shown as it came. */
const OWN_NOTES = new Set(["boot", "lost", "gone"])

/** The result, as the message's text, cut at six of its lines until asked
 *  for all. A proposal card shows its prompt the same way. */
export function CollapsedText({ text }: { text: string }) {
  const t = useTranslations("PersonalAgent.event")
  const { contentRef, contentId, isOverflowing, expanded, toggle } =
    useCollapsibleOverflow<HTMLDivElement>(text)
  const clipped = !expanded
  return (
    <div data-pa-result className="mt-2.5">
      <div
        ref={contentRef}
        id={contentId}
        className={cn(
          "break-words",
          MARKDOWN_LIST_ROOM,
          clipped && "max-h-[7.5rem] overflow-hidden",
          clipped && isOverflowing && "collapsed-content-fade"
        )}
      >
        <JsonRenderScope>
          {/* The result is cut at a length, not at a block: close what the
              cut left open (a fence, a list) as a stream would. */}
          <MessageResponse
            parseIncompleteMarkdown
            className={cn("text-sm", BUBBLE_MARKDOWN)}
          >
            {text}
          </MessageResponse>
        </JsonRenderScope>
      </div>
      {isOverflowing ? (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={contentId}
          className="mt-1.5 inline-flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? t("less") : t("more")}
          {expanded ? (
            <ChevronUp className="size-3.5" aria-hidden />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden />
          )}
        </button>
      ) : null}
    </div>
  )
}

export function EventCard({ item }: { item: EventItem }) {
  const t = useTranslations("PersonalAgent")
  const { dispatchById } = usePersonalAgent()
  const openWork = useOpenWork()
  const meta = useWorkMeta()
  const row = item.row
  const data = row.data
  const info =
    row.dispatch_id != null ? dispatchById.get(row.dispatch_id) : undefined
  // How the work stood when the news came, not how it stands now: the news
  // from before a follow-up still says the work went to review.
  const state = asDispatchState(data?.state)
  // Where it stood on the PR ladder then (8.5); older news says its state.
  const newsLadder = asLadder(data?.ladder)
  const executor = info?.executor.name ?? str(data, "executor")
  const agentType =
    info?.executor.agent_type ?? (str(data, "agent_type") as AgentType | null)
  const excerpt = str(data, "excerpt")
  const cause = str(data, "cause")
  const rawNote = str(data, "note")
  const note =
    rawNote && cause && OWN_NOTES.has(cause)
      ? t(`event.note.${cause}` as "event.note.boot")
      : rawNote
  const title = info?.title ?? str(data, "title") ?? row.body
  const target = workTargetOf(info, row)
  const unread = row.read_at == null
  return (
    <MessageRow
      rowId={row.id}
      side="start"
      gap={item.gap}
      tail={item.tail}
      roomy
      actions={{
        rowId: row.id,
        text:
          [str(data, "title"), excerpt].filter(Boolean).join("\n\n") ||
          row.body,
        at: row.created_at,
      }}
      aside={unread ? <UnreadMark /> : null}
    >
      {/* A reply's padding, so the work's row and the text under it line up
          with the reply's above. */}
      <div
        data-bubble
        className={cn(
          AGENT_SURFACE,
          bubbleCorners("start", item.tail),
          "min-w-0 p-3 text-sm text-foreground"
        )}
      >
        {row.reply_to != null && !item.quotesPrevious ? (
          <QuoteBar targetId={row.reply_to} tone="light" className="mb-2" />
        ) : null}
        <div className={WORK_WELL}>
          <WorkRow
            executorId={info?.executor.assistant_id ?? num(data, "executor_id")}
            executor={executor}
            agentType={agentType}
            title={title}
            meta={meta({
              executor,
              mode: info?.mode ?? asMode(data?.mode),
              folder: info?.folder_name ?? null,
            })}
            chip={
              newsLadder ? (
                <LadderChip ladder={newsLadder} />
              ) : (
                <DispatchStateChip state={state} />
              )
            }
            onOpen={canOpenWork(target) ? () => openWork(target) : null}
          />
        </div>
        {/* The task card, on the latest news of its work: where it stands
            now, said again on the strip when the row above says otherwise. */}
        {item.latest && info?.task ? (
          <TaskStrip d={info} chip={newsLadder !== info.ladder} />
        ) : null}
        {note ? (
          <p className="mt-2 text-xs break-words text-muted-foreground">
            {note}
          </p>
        ) : null}
        {excerpt ? <CollapsedText text={excerpt} /> : null}
      </div>
    </MessageRow>
  )
}
