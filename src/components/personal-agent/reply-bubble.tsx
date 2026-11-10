"use client"

/**
 * One turn of the assistant: a bubble on the left, top to bottom — the
 * quote it answers (unless that is the message right above), its step slot
 * (the step it is on while it runs; its last text once it ended), the
 * prompt it waits on while it does, the answers the owner gave as quiet
 * lines, the work it handed out (as pills), and how it ended when that was
 * not plainly. What each part shows comes from `replyView` alone. Whatever
 * comes first sits right under the bubble's top padding, as much as the
 * last sits over its bottom: a turn that ended with no text reads centred.
 * While it is written, its actions (on hover) can stop it.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CircleAlert, CornerDownRight, RotateCcw, Square } from "lucide-react"
import { toast } from "sonner"

import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentResend } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { useBotId } from "@/contexts/personal-agent-context"
import { cn } from "@/lib/utils"

import { DispatchAttachments } from "./dispatch-attachments"
import { BlockingPrompts } from "./live-turn"
import type { MessageItem } from "./message-items"
import { bubbleCorners, MessageRow } from "./message-row"
import { QuoteBar } from "./quote-bar"
import { replyView, type AnsweredLine, type ReplyEnding } from "./reply-view"
import { AGENT_SURFACE, INSET_HOVER, usePageScope } from "./shared"
import { StepSlot } from "./step-slot"

type ReplyItem = Extract<MessageItem, { kind: "reply" }>

function Answered({ line }: { line: AnsweredLine }) {
  const t = useTranslations("PersonalAgent.reply")
  const text =
    line.kind === "permission"
      ? t("answeredPermission", { option: line.text })
      : line.kind === "question"
        ? t("answeredQuestion", { answer: line.text })
        : line.kind === "skipped"
          ? t("answeredSkipped")
          : t(`answeredPlan.${line.text}` as "answeredPlan.approve")
  return (
    <p
      data-row-id={line.rowId}
      className="mt-1.5 text-xs text-muted-foreground"
    >
      {text}
    </p>
  )
}

function Ending({ ending }: { ending: ReplyEnding }) {
  const t = useTranslations("PersonalAgent.reply")
  const why = (w: string | null) =>
    w && ["connection", "overflow", "rejected", "error", "restart"].includes(w)
      ? t(`why.${w}` as "why.connection")
      : null
  let text: string
  let tone = "text-muted-foreground"
  let Icon = CircleAlert
  switch (ending.kind) {
    case "stopped":
      text = t("stopped")
      Icon = Square
      break
    case "error":
      text = t("errorMidway", { error: ending.detail ?? "" })
      tone = "text-red-700 dark:text-red-300"
      break
    case "interrupted":
      if (ending.why === "preempted") {
        // It stopped so the owner's message could go first: nothing went
        // wrong, so no warning colour.
        text = t("preempted")
        Icon = CornerDownRight
        break
      }
      text = t("interrupted", {
        reason: why(ending.why) ?? ending.detail ?? t("why.unknown"),
      })
      tone = "text-amber-700 dark:text-amber-300"
      break
    case "truncated":
      text = t("truncated")
      tone = "text-amber-700 dark:text-amber-300"
      break
  }
  // On the text's 20px line: a reply that ended with nothing else is as
  // tall as one line of text.
  return (
    <p
      className={cn("mt-1.5 flex items-start gap-1.5 text-xs leading-5", tone)}
    >
      <Icon className="mt-1 size-3 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{text}</span>
    </p>
  )
}

function Resend({ ids }: { ids: number[] }) {
  const t = useTranslations("PersonalAgent.reply")
  const botId = useBotId()
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      className={cn(
        "mt-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-foreground/80 transition-colors hover:text-foreground disabled:opacity-50",
        INSET_HOVER
      )}
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          // One after another, so they queue in their own order.
          for (const id of ids) await personalAgentResend(id, botId)
        } catch (e) {
          toast.error(toErrorMessage(e))
        } finally {
          setBusy(false)
        }
      }}
    >
      <RotateCcw className="size-3" aria-hidden />
      {t("resend", { count: ids.length })}
    </button>
  )
}

export function ReplyBubble({ item }: { item: ReplyItem }) {
  const scope = usePageScope()
  const { liveReplies } = usePersonalAgent()
  const row = item.row
  const live =
    row && liveReplies.has(row.id) ? liveReplies.get(row.id) : undefined
  const view = useMemo(
    () =>
      replyView({
        row,
        live,
        attached: item.attached,
        owners: item.owners,
      }),
    [row, live, item.attached, item.owners]
  )
  const liveTurn = view.running && row != null && row.id === scope.liveRowId
  const copyText =
    !view.running && view.slot?.kind === "text" ? view.slot.text : null
  return (
    <MessageRow
      rowId={item.anchor.id}
      side="start"
      gap={item.gap}
      tail={item.tail}
      actions={{
        rowId: row?.id ?? item.anchor.id,
        text: copyText,
        at: (row ?? item.anchor).created_at,
        durationMs: view.durationMs,
        live: liveTurn,
      }}
    >
      <div
        data-bubble
        className={cn(
          AGENT_SURFACE,
          bubbleCorners("start", item.tail),
          "min-w-0 p-3 text-sm break-words text-foreground [&>:first-child]:mt-0"
        )}
        aria-live={liveTurn ? "polite" : undefined}
        aria-busy={liveTurn || undefined}
      >
        {row?.reply_to != null && !item.quotesPrevious ? (
          <QuoteBar targetId={row.reply_to} tone="light" className="mb-2" />
        ) : null}
        {view.slot ? (
          <StepSlot view={view.slot} running={view.running} />
        ) : null}
        {liveTurn &&
        !scope.readOnly &&
        scope.connectionId &&
        scope.agentType ? (
          <div className="mt-2 flex flex-col gap-2 empty:hidden">
            <BlockingPrompts
              connectionId={scope.connectionId}
              agentType={scope.agentType}
            />
          </div>
        ) : null}
        {view.answered.map((line) => (
          <Answered key={line.rowId} line={line} />
        ))}
        {view.dispatches.length > 0 ? (
          <DispatchAttachments rows={view.dispatches} />
        ) : null}
        {view.ending ? <Ending ending={view.ending} /> : null}
        {view.resend.length > 0 && !scope.readOnly ? (
          <Resend ids={view.resend} />
        ) : null}
      </div>
    </MessageRow>
  )
}
