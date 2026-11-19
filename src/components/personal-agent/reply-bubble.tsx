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

import { Fragment, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Brain,
  CircleAlert,
  CornerDownRight,
  Newspaper,
  Repeat,
  RotateCcw,
  Square,
  Sunset,
} from "lucide-react"
import { toast } from "sonner"

import { MessageResponse } from "@/components/ai-elements/message"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentResend } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { useBotId } from "@/contexts/personal-agent-context"
import type { ReplyMemory } from "@/lib/types"
import { cn } from "@/lib/utils"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { DispatchAttachments } from "./dispatch-attachments"
import { BlockingPrompts } from "./live-turn"
import type { MessageItem } from "./message-items"
import { bubbleCorners, MessageRow } from "./message-row"
import { PaReplyScope } from "./pa-card-scope"
import { QuoteBar } from "./quote-bar"
import {
  replyView,
  type AnsweredLine,
  type ReplyEnding,
  type SlotView,
} from "./reply-view"
import {
  AGENT_SURFACE,
  BUBBLE_MARKDOWN,
  CardMessage,
  INSET_HOVER,
  MARKDOWN_LIST_ROOM,
  SheetPart,
  usePageScope,
} from "./shared"
import { isChoiceQuestionRow, QuestionChoiceCard } from "./question-choice-card"
import { isOneCard, splitReply } from "./reply-split"
import { StepSlot } from "./step-slot"
import { TidyLines, tidyRowsOf } from "./tidy-lines"

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

/** A request of this turn's that could not be filed under one input: the
 *  inputs the turn was working on, and where each came from. */
function RequestInputs({ rows }: { rows: ReplyItem["attached"] }) {
  const t = useTranslations("PersonalAgent.reply")
  const pending = rows.find(
    (r) =>
      (r.kind === "question" || r.kind === "permission") &&
      r.data?.state === "pending" &&
      Array.isArray(r.data?.inputs)
  )
  if (!pending) return null
  const list = (pending.data?.inputs as unknown[])
    .filter(
      (x): x is Record<string, unknown> => x != null && typeof x === "object"
    )
    .map((x) => {
      const ref = typeof x.ref === "string" ? x.ref : ""
      const bot =
        x.origin_bot && typeof x.origin_bot === "object"
          ? (x.origin_bot as Record<string, unknown>)
          : null
      const name = typeof bot?.name === "string" ? bot.name : null
      return name ? `${ref} (${name})` : ref
    })
  return (
    <p className="mt-1.5 text-xs break-words text-muted-foreground">
      {t("requestInputs", { list: list.join(", ") })}
    </p>
  )
}

/** Text so far that may yet be a routine's `[[silent]]`. */
function silentSoFar(text: string): boolean {
  const t = text.trim()
  return t.length > 0 && "[[silent]]".startsWith(t)
}

function routineOf(
  v: unknown
): { id: number | null; title: string; seq: number | null } | null {
  if (!v || typeof v !== "object") return null
  const r = v as { id?: unknown; title?: unknown; seq?: unknown }
  if (typeof r.title !== "string" || !r.title) return null
  return {
    id: typeof r.id === "number" ? r.id : null,
    title: r.title,
    seq: typeof r.seq === "number" ? r.seq : null,
  }
}

/** The entries of its memory a reply used (7.7). */
function memoriesOf(v: unknown): ReplyMemory[] {
  return Array.isArray(v)
    ? v.filter(
        (m): m is ReplyMemory =>
          m != null &&
          typeof m === "object" &&
          typeof (m as ReplyMemory).name === "string" &&
          (m as ReplyMemory).name.startsWith("memory/") &&
          typeof (m as ReplyMemory).title === "string"
      )
    : []
}

/** "Memory used: Release days · Your hours" under a reply — each opens
 *  that entry on the persona page (7.7). */
function UsedMemory({ memories }: { memories: ReplyMemory[] }) {
  const t = useTranslations("PersonalAgent.memory")
  const openBotPage = usePersonalAgentUi((s) => s.openBotPage)
  if (memories.length === 0) return null
  return (
    <p
      className="mt-1.5 flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground"
      data-pa-reply-memories
    >
      <Brain className="size-3 shrink-0" aria-hidden />
      <span>{t("used")}</span>
      {memories.map((m, i) => (
        <Fragment key={m.name}>
          {i > 0 ? <span aria-hidden>·</span> : null}
          <button
            type="button"
            className="min-w-0 truncate underline-offset-2 hover:text-foreground hover:underline"
            title={m.name}
            data-pa-reply-memory={m.name}
            onClick={() => openBotPage("persona", { entry: m.name })}
          >
            {m.title || m.name}
          </button>
        </Fragment>
      ))}
    </p>
  )
}

/** The tidy-ups a morning brief shows under it (7.7). */
function tidiedOf(v: unknown): unknown {
  return v && typeof v === "object" ? (v as { tidied?: unknown }).tidied : null
}

/** The morning brief or the wrap-up a reply is (6.4, 6.5). */
function briefOf(v: unknown): "brief" | "wrap" | null {
  if (!v || typeof v !== "object") return null
  const kind = (v as { kind?: unknown }).kind
  return kind === "brief" || kind === "wrap" ? kind : null
}

export function ReplyBubble({ item }: { item: ReplyItem }) {
  const tr = useTranslations("PersonalAgent.routines")
  const tb = useTranslations("PersonalAgent.brief")
  const scope = usePageScope()
  const { liveReplies, liveTexts } = usePersonalAgent()
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
  // While the turn runs, the bubble holds only what it wrote: the other
  // steps are the status line's (10.7). Its last text stays while it goes on
  // with them; with none yet, there is no bubble at all — unless the turn
  // asks the owner something here. A text it wrote before sending a message
  // is drawn above that message's line already (`said`): not here again.
  const drawnAbove = (n: number | undefined) =>
    n != null && item.saidNs.includes(n)
  const kept = row ? liveTexts?.get(row.id) : undefined
  const said = kept && !drawnAbove(kept.n) ? kept : undefined
  const streamed: SlotView | null =
    view.running && view.slot?.kind !== "text"
      ? said
        ? {
            kind: "text",
            key: `t${said.n}`,
            text: said.text,
            streaming: true,
            n: said.n,
          }
        : null
      : view.running && view.slot?.kind === "text" && drawnAbove(view.slot.n)
        ? null
        : view.slot
  // A routine's "nothing to say" as it streams in is not shown (6.9).
  const slot: SlotView | null =
    view.running && streamed?.kind === "text" && silentSoFar(streamed.text)
      ? null
      : streamed
  const asks = item.attached.some(
    (r) =>
      (r.kind === "question" || r.kind === "permission") &&
      r.data?.state === "pending"
  )
  if (
    view.running &&
    slot == null &&
    !asks &&
    view.answered.length === 0 &&
    view.dispatches.length === 0
  ) {
    return null
  }
  const copyText =
    !view.running && view.slot?.kind === "text" ? view.slot.text : null
  // The brain's own questions, as choice cards in the bubble (10.7).
  const questionRows = item.attached.filter(isChoiceQuestionRow)
  const questionsShown = new Set(
    questionRows.map((r) => r.ref_id).filter((id): id is string => !!id)
  )
  // Short paragraphs, no code and no card: a bubble each (10.7). While it
  // streams too, so the bubbles it ends with are the ones it grew.
  const parts = slot?.kind === "text" ? splitReply(slot.text) : null
  const paragraphs = parts != null && parts.length > 1 ? parts : null
  // A reply that is one card and nothing else is the card: no bubble round
  // it (what it is of — a brief, a routine, the message it answers — and
  // what it drew on stay small lines over and under it).
  const bare =
    !view.running &&
    !liveTurn &&
    paragraphs == null &&
    slot?.kind === "text" &&
    isOneCard(slot.text) &&
    questionRows.length === 0 &&
    view.answered.length === 0 &&
    view.dispatches.length === 0 &&
    view.ending == null &&
    view.resend.length === 0
  // The routine it reports for (6.9): its report a card of its own — the
  // routine and which run its header, what it says under it, whole — as
  // the other news codeg brings is; a report that is one card is that card.
  const routine = routineOf(row?.data?.routine)
  const routineCard = routine != null && !bare
  const split = routineCard ? null : paragraphs
  const lastSlot: SlotView | null =
    split && slot?.kind === "text"
      ? { ...slot, text: split[split.length - 1] }
      : slot
  // The morning brief or the wrap-up it is (6.4, 6.5).
  const brief = briefOf(row?.data?.brief)
  const tidied = tidyRowsOf(tidiedOf(row?.data?.brief))
  const BriefIcon = brief === "wrap" ? Sunset : Newspaper
  const routineWords = routine
    ? tr("reply", { title: routine.title, seq: routine.seq ?? 1 })
    : null
  const quote = (
    <>
      {brief ? (
        <p
          className="mb-1.5 flex items-center gap-1 text-xs text-muted-foreground"
          data-pa-reply-brief={brief}
        >
          <BriefIcon className="size-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">
            {tb(brief === "wrap" ? "replyWrap" : "replyBrief")}
          </span>
        </p>
      ) : null}
      {routine && !routineCard ? (
        <p
          className="mb-1.5 flex items-center gap-1 text-xs text-muted-foreground"
          data-pa-reply-routine={routine.id ?? ""}
        >
          <Repeat className="size-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{routineWords}</span>
        </p>
      ) : null}
      {row?.reply_to != null && !item.quotesPrevious ? (
        <QuoteBar targetId={row.reply_to} tone="light" className="mb-2" />
      ) : null}
    </>
  )
  const rest = (
    <>
      {lastSlot ? (
        <StepSlot view={lastSlot} running={view.running} row={row} />
      ) : null}
      {liveTurn && !scope.readOnly && scope.connectionId && scope.agentType ? (
        <div className="mt-2 flex flex-col gap-2 empty:hidden">
          <BlockingPrompts
            connectionId={scope.connectionId}
            agentType={scope.agentType}
            questionsShown={questionsShown}
          />
        </div>
      ) : null}
      {questionRows.map((r) => (
        <QuestionChoiceCard key={r.id} row={r} live={liveTurn} />
      ))}
      {liveTurn ? <RequestInputs rows={item.attached} /> : null}
      {view.answered.map((line) => (
        <Answered key={line.rowId} line={line} />
      ))}
      {view.dispatches.length > 0 ? (
        <DispatchAttachments rows={view.dispatches} />
      ) : null}
      {!view.running ? (
        <UsedMemory memories={memoriesOf(row?.data?.memories)} />
      ) : null}
      {brief === "brief" && !view.running && tidied.length > 0 ? (
        <div className="mt-3">
          <TidyLines framed rows={tidied} />
        </div>
      ) : null}
      {view.ending ? <Ending ending={view.ending} /> : null}
      {view.resend.length > 0 && !scope.readOnly ? (
        <Resend ids={view.resend} />
      ) : null}
    </>
  )
  const bubble = (
    part: number,
    tail: boolean,
    children: React.ReactNode,
    live = false
  ) => (
    <div
      key={part}
      data-bubble
      data-pa-bubble-part={split ? part : undefined}
      data-pa-bare={bare || undefined}
      className={cn(
        !bare && AGENT_SURFACE,
        !bare && bubbleCorners("start", tail),
        // No wider than the message's share of the column, beside its
        // others too: a line that does not wrap (a quote's title, a long
        // name in code) must not widen it past the column.
        "max-w-full min-w-0 text-sm break-words text-foreground [&>:first-child]:mt-0",
        !bare && "p-3"
      )}
      aria-live={live ? "polite" : undefined}
      aria-busy={live || undefined}
    >
      {children}
    </div>
  )
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
      {routineCard ? (
        <CardMessage
          data-pa-reply-routine-card={routine.id ?? ""}
          aria-live={liveTurn ? "polite" : undefined}
          aria-busy={liveTurn || undefined}
          head={
            <>
              <Repeat aria-hidden />
              <span
                className="min-w-0 truncate"
                data-pa-reply-routine={routine.id ?? ""}
              >
                {routineWords}
              </span>
            </>
          }
        >
          <SheetPart className="break-words text-foreground [&>:first-child]:mt-0">
            {quote}
            {rest}
          </SheetPart>
        </CardMessage>
      ) : split ? (
        <div className="flex min-w-0 flex-col items-start gap-1">
          {split.slice(0, -1).map((text, i) =>
            bubble(
              i,
              false,
              <>
                {i === 0 ? quote : null}
                <MessageResponse
                  className={cn("text-sm", MARKDOWN_LIST_ROOM, BUBBLE_MARKDOWN)}
                >
                  {text}
                </MessageResponse>
              </>
            )
          )}
          {bubble(split.length - 1, item.tail, rest, liveTurn)}
        </div>
      ) : (
        bubble(
          0,
          item.tail,
          <>
            {quote}
            {rest}
          </>,
          liveTurn
        )
      )}
    </MessageRow>
  )
}

type SaidItem = Extract<MessageItem, { kind: "said" }>

/**
 * What a turn wrote before a message it sent to another assistant, over
 * that message's line — where it was written: the turn's reply keeps only
 * its last text, and without this the line would sit above everything the
 * turn said. Drawn as the reply's text is (short paragraphs a bubble each);
 * its actions copy it, with no quote — it is no message of its own.
 */
export function SaidBubble({ item }: { item: SaidItem }) {
  const parts = splitReply(item.text)
  const bubble = (part: number, tail: boolean, text: string) => (
    <div
      key={part}
      data-bubble
      data-pa-said
      data-pa-bubble-part={parts.length > 1 ? part : undefined}
      className={cn(
        AGENT_SURFACE,
        bubbleCorners("start", tail),
        // No wider than the message's share of the column, beside its
        // others too: a line that does not wrap (a quote's title, a long
        // name in code) must not widen it past the column.
        "max-w-full min-w-0 p-3 text-sm break-words text-foreground [&>:first-child]:mt-0"
      )}
    >
      <PaReplyScope row={null} running={false}>
        <MessageResponse
          className={cn("text-sm", MARKDOWN_LIST_ROOM, BUBBLE_MARKDOWN)}
        >
          {text}
        </MessageResponse>
      </PaReplyScope>
    </div>
  )
  return (
    <MessageRow
      side="start"
      gap={item.gap}
      tail={item.tail}
      actions={{
        rowId: item.row.id,
        text: item.text,
        at: item.row.created_at,
        quote: false,
      }}
    >
      {parts.length > 1 ? (
        <div className="flex min-w-0 flex-col items-start gap-1">
          {parts.map((text, i) =>
            bubble(i, i === parts.length - 1 && item.tail, text)
          )}
        </div>
      ) : (
        bubble(0, item.tail, parts[0] ?? item.text)
      )}
    </MessageRow>
  )
}
