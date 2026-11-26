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
import type { ReplyMemory, ReplyText, TimelineRow } from "@/lib/types"
import { cn } from "@/lib/utils"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { DispatchAttachments } from "./dispatch-attachments"
import { BlockingPrompts } from "./live-turn"
import {
  partEntries,
  replyState,
  turnMarkOf,
  type MessageItem,
  type PartEntry,
} from "./message-items"
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
  conclusionOf,
  silentSoFar,
  textsIn,
  turnTexts,
  type TurnPart,
} from "./turn-texts"
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
import { isOneCard } from "./reply-split"
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

/**
 * What a part of a turn draws, in the order it came (`partEntries`): every
 * run its own block — keyed by its reply and its ordinal, so a run that
 * grows, and the same run settling, stay one element — and the work handed
 * out between runs as pills, each group with its own "N more". Only the
 * conclusion's cards act (while it runs: its latest run's, whose buttons
 * wait); what the turn said on the way is drawn read-only — its conclusion
 * may have put it right.
 */
function PartBody({
  row,
  entries,
  running,
  latest,
  readOnly = false,
}: {
  row: TimelineRow | null
  entries: readonly PartEntry[]
  running: boolean
  /** The turn's latest run, while it runs: it streams. */
  latest: number | null
  /** None of them the conclusion (a part not the reply's). */
  readOnly?: boolean
}) {
  const conclusion = row ? conclusionOf(row) : null
  return (
    <>
      {entries.map((e, i) => {
        if (e.kind === "pills") {
          return (
            <DispatchAttachments
              key={`p${e.group}`}
              rows={e.rows}
              group={e.group}
            />
          )
        }
        const t = e.run
        const streaming = running && t.n === latest
        const acts =
          !readOnly && (running ? t.n === latest : t.n === conclusion)
        return (
          <div
            key={`${row?.id}:${t.n}`}
            data-pa-run={t.n}
            className={cn(i > 0 && "mt-2")}
          >
            <PaReplyScope row={row} running={running} readOnly={!acts}>
              <MessageResponse
                className={cn("text-sm", MARKDOWN_LIST_ROOM, BUBBLE_MARKDOWN)}
                mode={streaming ? "streaming" : undefined}
                parseIncompleteMarkdown={streaming ? true : undefined}
              >
                {t.text}
              </MessageResponse>
            </PaReplyScope>
          </div>
        )
      })}
    </>
  )
}

/** The runs part `part` of reply `row`'s turn draws, from every copy the
 *  page has of it (`turnTexts`): a routine's "nothing to say" as it
 *  streams in is not one (6.9). `latest`: the turn's latest run while it
 *  runs. */
function usePartTexts(
  row: TimelineRow | null,
  part: TurnPart
): { texts: ReplyText[]; latest: number | null } {
  const { liveReplies } = usePersonalAgent()
  const heard = row ? liveReplies.get(row.id) : undefined
  return useMemo(() => {
    if (!row) return { texts: [], latest: null }
    const all = turnTexts(row, heard, part.lines)
    const running = replyState(row) === "running"
    const last = all[all.length - 1]
    const shown =
      running && last && silentSoFar(last.text) ? all.slice(0, -1) : all
    return {
      texts: textsIn(shown, part),
      latest: running ? (last?.n ?? null) : null,
    }
  }, [row, heard, part])
}

export function ReplyBubble({ item }: { item: ReplyItem }) {
  const tr = useTranslations("PersonalAgent.routines")
  const tb = useTranslations("PersonalAgent.brief")
  const scope = usePageScope()
  const { liveReplies } = usePersonalAgent()
  const row = item.row
  const heard = row ? liveReplies.get(row.id) : undefined
  const view = useMemo(
    () =>
      replyView({
        row,
        live: heard ? heard.current : undefined,
        attached: item.attached,
        owners: item.owners,
        pills: item.pills,
      }),
    [row, heard, item.attached, item.owners, item.pills]
  )
  const { texts, latest } = usePartTexts(row, item.part)
  // Its runs and the work handed out between them, in the order they came;
  // work its turn handed out at no recorded step comes after the answers,
  // as it always did.
  const entries = partEntries(
    texts,
    item.partPills.filter((r) => turnMarkOf(r) != null),
    item.pills
  )
  const unplaced = item.pills.filter((r) => turnMarkOf(r) == null)
  const unplacedGroup =
    item.partPills.find((r) => turnMarkOf(r) == null)?.id ?? null
  const liveTurn = view.running && row != null && row.id === scope.liveRowId
  // While the turn runs, the bubble holds only what it wrote: the other
  // steps are the status line's (10.7). With nothing written yet, there is
  // no bubble at all — unless the turn asks the owner something here.
  const asks = item.attached.some(
    (r) =>
      (r.kind === "question" || r.kind === "permission") &&
      r.data?.state === "pending"
  )
  if (
    view.running &&
    texts.length === 0 &&
    !asks &&
    view.answered.length === 0 &&
    view.dispatches.length === 0
  ) {
    return null
  }
  // Ended without a word anywhere in its turn: what it did instead.
  const note: SlotView | null =
    !view.running && view.slot?.kind === "note" && texts.length === 0
      ? view.slot
      : null
  const copyText =
    !view.running && texts.length > 0
      ? texts.map((t) => t.text).join("\n\n")
      : null
  // The brain's own questions, as choice cards in the bubble (10.7).
  const questionRows = item.attached.filter(isChoiceQuestionRow)
  const questionsShown = new Set(
    questionRows.map((r) => r.ref_id).filter((id): id is string => !!id)
  )
  // A reply that is one card and nothing else is the card: no bubble round
  // it (what it is of — a brief, a routine, the message it answers — and
  // what it drew on stay small lines over and under it).
  const bare =
    !view.running &&
    !liveTurn &&
    texts.length === 1 &&
    isOneCard(texts[0].text) &&
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
      {item.quote && row?.reply_to != null && !item.quotesPrevious ? (
        <QuoteBar targetId={row.reply_to} tone="light" className="mb-2" />
      ) : null}
    </>
  )
  const rest = (
    <>
      {entries.length > 0 ? (
        <PartBody
          row={row}
          entries={entries}
          running={view.running}
          latest={latest}
        />
      ) : null}
      {note ? <StepSlot view={note} running={false} row={row} /> : null}
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
      {unplaced.length > 0 ? (
        <DispatchAttachments rows={unplaced} group={unplacedGroup} />
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
      ) : (
        <div
          data-bubble
          data-pa-bare={bare || undefined}
          className={cn(
            !bare && AGENT_SURFACE,
            !bare && bubbleCorners("start", item.tail),
            // No wider than the message's share of the column, beside its
            // others too: a line that does not wrap (a quote's title, a long
            // name in code) must not widen it past the column.
            "max-w-full min-w-0 text-sm break-words text-foreground [&>:first-child]:mt-0",
            !bare && "p-3"
          )}
          aria-live={liveTurn ? "polite" : undefined}
          aria-busy={liveTurn || undefined}
        >
          {quote}
          {rest}
        </div>
      )}
    </MessageRow>
  )
}

type SaidItem = Extract<MessageItem, { kind: "said" }>

/**
 * A part of a turn that is not its reply's (P6): what the turn said, and
 * the work it handed out, between the lines it wrote to other assistants —
 * where it said it. One bubble; its cards are read-only (the conclusion is
 * the reply's). Its pills all made way and nothing said: drawn empty, so
 * the lines round it stay apart. Its actions copy it, with no quote — it is
 * no message of its own.
 */
export function SaidBubble({ item }: { item: SaidItem }) {
  const { texts, latest } = usePartTexts(item.reply, item.part)
  const entries = partEntries(texts, item.partPills, item.pills)
  const running = replyState(item.reply) === "running"
  if (texts.length === 0 && item.pills.length === 0) return null
  const text = texts.map((t) => t.text).join("\n\n")
  return (
    <MessageRow
      side="start"
      gap={item.gap}
      tail={item.tail}
      actions={{
        rowId: item.row.id,
        text: text || null,
        at: item.row.created_at,
        quote: false,
      }}
    >
      <div
        data-bubble
        data-pa-said
        className={cn(
          AGENT_SURFACE,
          bubbleCorners("start", item.tail),
          // No wider than the message's share of the column, beside its
          // others too: a line that does not wrap (a quote's title, a long
          // name in code) must not widen it past the column.
          "max-w-full min-w-0 p-3 text-sm break-words text-foreground [&>:first-child]:mt-0"
        )}
      >
        {item.quote && item.reply.reply_to != null && !item.quotesPrevious ? (
          <QuoteBar
            targetId={item.reply.reply_to}
            tone="light"
            className="mb-2"
          />
        ) : null}
        {entries.length > 0 ? (
          <PartBody
            row={item.reply}
            entries={entries}
            running={running}
            latest={latest}
            // Its runs are all on the way: none is the conclusion.
            readOnly
          />
        ) : null}
      </div>
    </MessageRow>
  )
}
