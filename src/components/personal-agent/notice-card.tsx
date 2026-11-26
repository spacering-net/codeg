"use client"

/**
 * A native card: written by codeg, not drawn by the model, so what the
 * owner clicks is exactly what runs.
 *
 * - **proposal**: something put in front of the owner instead of done — a
 *   dispatch, a follow-up — kept whole. The card shows all of it: the work's
 *   row as the result cards draw it (who would run it, as what and where)
 *   and the prompt; [Do this] runs that very content, [Not now] drops it.
 * - **uncertain**: a step codeg was cut off sending, so it cannot tell
 *   whether it took effect. Nothing is redone on its own: [Look] opens where
 *   it went, [Send again] sends it again, [Let it be] closes the card.
 *
 * - **loop**: two assistants went back and forth with no progress, or in a
 *   circle, and codeg stopped their exchange: [See the exchange], [Let them
 *   go on] (three rounds more), [I'll handle it].
 * - **reminder**: a matter that came due (`./reminder-card.tsx`).
 * - **acceptance**: a round of acceptance of code work an assistant handed
 *   out (`./acceptance-card.tsx`, 7.5).
 * - **forge**: something an assistant does on a forge — a comment, closing
 *   an issue, a merge (`./forge-card.tsx`, 7.4).
 * - **pr**: what a pull request an assistant watches came to — checks
 *   failed, a conflict, ready to merge, merged (`./pr-card.tsx`, 7.4).
 * - **changed**: a settings change from the conversation (13.3), the
 *   assistants' own among them (10.5); assistants made (4.12).
 * - **memory**: what a turn changed in the assistant's memory, persona or
 *   rules, with its diff and [Undo] (`./memory-card.tsx`, 7.7); **tidy**, the
 *   nightly tidy-up, the same card undone as a whole or applied as a draft.
 * - **skill**: a process skill the assistant wrote or changed
 *   (`./skill-card.tsx`, 7.8).
 * - **check**: "is this right?", a message of an ordinary conversation the
 *   owner had checked (`./check-card.tsx`, 10.3).
 * - **stopped**: what the owner's stop took with it — the work the turn
 *   handed out, the messages nobody had started on — and what it could not:
 *   messages another assistant is already working on, each with [Stop this
 *   one too].
 *
 * Acting is two-phase on the server: the card reads "running" until what it
 * runs settles — done, back to open with the reason, or "not sure it ran",
 * which can be run again.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowLeftRight,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleSlash,
  History,
  Lightbulb,
  ListTodo,
  MessageSquareQuote,
  Moon,
  OctagonX,
  Repeat,
  SlidersHorizontal,
  Undo2,
  UserPlus,
  type LucideIcon,
} from "lucide-react"

import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { Button } from "@/components/ui/button"
import { useBotId, usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentNoticeAct } from "@/lib/api"
import { isBotTab, type PersonalAgentPage } from "@/lib/personal-agent-open"
import type {
  BotFace,
  PersonalAgentPrefKey,
  PickedOption,
  TimelineRow,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"
import { usePersonalAgentRoster } from "@/stores/personal-agent-roster-store"

import { AcceptanceCard } from "./acceptance-card"
import { AskCard } from "./ask-card"
import { BriefCard } from "./brief-card"
import { BotAvatar } from "./bot-avatar"
import { ChoiceCard } from "./choice-card"
import { CollapsedText } from "./event-card"
import { ExchangeSheet } from "./exchange-sheet"
import { ForgeCard } from "./forge-card"
import { MemoryCard } from "./memory-card"
import { SkillCard } from "./skill-card"
import { CheckCard } from "./check-card"
import { PlanCard } from "./plan-card"
import { PrCard } from "./pr-card"
import { RoutineCard } from "./routine-card"
import { RuleCard } from "./rule-card"
import { MutedNote, MuteKindButton } from "./mute-kind"
import {
  ChangeValue,
  changesOf,
  namesOf,
  teamKey,
  useChangeText,
} from "./change-text"
import type { MessageItem } from "./message-items"
import { MessageRow } from "./message-row"
import { RowIcon, RowLines, splitLine } from "./list-row"
import { QuoteBar } from "./quote-bar"
import {
  ConnectCard,
  MeetNameCard,
  PromisesCard,
  StarterCard,
} from "./meet-cards"
import { ReminderCard } from "./reminder-card"
import {
  ABOUT_ITEMS,
  COMMUNICATION_ITEMS,
  PROACTIVE_ITEMS,
} from "./settings/pref-pages"
import {
  asMode,
  canOpenWork,
  CardMessage,
  num,
  SHEET_TITLE,
  SheetActions,
  SheetField,
  SheetFields,
  SheetLabel,
  SheetNote,
  SheetPart,
  str,
  useBotName,
  useOpenWork,
  usePageScope,
  useWorkMeta,
  workTargetOf,
} from "./shared"
import { WorkRow } from "./work-card"

type NoticeItem = Extract<MessageItem, { kind: "notice" }>

type Display = Record<string, unknown> | null

function obj(v: unknown): Display {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null
}

const INTENTS = new Set(["revise", "continue", "question", "verify"])

/** How a card stands, as its heading says it: waiting on the owner, being
 *  carried out, done, let go, undone, or not sure. */
type Settle = "open" | "busy" | "done" | "off" | "undone" | "warn"

/** A settled card's heading on its tone, its kind's icon swapped for how
 *  it ended: done green, not sure amber, let go or undone quiet. */
const SETTLE_TONE: Record<Settle, string> = {
  open: "",
  busy: "",
  done: "text-emerald-700 dark:text-emerald-400",
  off: "",
  undone: "",
  warn: "text-amber-700 dark:text-amber-400",
}

const SETTLE_ICON: Partial<Record<Settle, LucideIcon>> = {
  done: CircleCheck,
  off: CircleSlash,
  undone: Undo2,
  warn: CircleAlert,
}

/** A card's heading: its kind's icon (how it ended, once it has) and what
 *  it says of where it stands. */
function CardHead({
  icon,
  settle,
  heading,
}: {
  icon: LucideIcon
  settle: Settle
  heading: string
}) {
  const Icon = SETTLE_ICON[settle] ?? icon
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5",
        SETTLE_TONE[settle]
      )}
      data-pa-settle={settle}
    >
      {settle === "busy" ? (
        <SyncedSpinner small className="size-3.5 shrink-0" />
      ) : (
        <Icon aria-hidden />
      )}
      <span className="font-medium">{heading}</span>
    </span>
  )
}

/** A card's last band, when it has something to say there: that its kind
 *  was muted from it, an answer that did not go through. */
function NoticeFoot({
  data,
  error,
}: {
  data: Record<string, unknown> | null | undefined
  error: string | null
}) {
  if (!str(data, "muted") && !error) return null
  return (
    <SheetNote>
      {/* "Don't suggest these" was pressed on it (6.7). */}
      <MutedNote data={data} className="" />
      {error ? (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      ) : null}
    </SheetNote>
  )
}

/** A list on a card: its rows a hairline apart, none over the first or
 *  under the last — the band's own lines are those. */
const CARD_LIST =
  "flex flex-col divide-y divide-border/60 [&>li]:py-2 [&>li:first-child]:pt-0 [&>li:last-child]:pb-0"

/** Why, and on whose word — the owner's words, the assistant's reason,
 *  what was kept — a line each, led by what it is. */
function WhyLines({
  lines,
}: {
  lines: { key: string; icon: LucideIcon; text: React.ReactNode }[]
}) {
  if (lines.length === 0) return null
  return (
    <ul className="flex flex-col gap-1.5 text-xs leading-5 text-muted-foreground">
      {lines.map(({ key, icon: Icon, text }) => (
        <li
          key={key}
          className="flex items-start gap-2"
          data-pa-why={key}
          // The line it was before, where a test or a style reaches it.
          data-pa-both-ways={key === "bothWays" ? "" : undefined}
        >
          <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{text}</span>
        </li>
      ))}
    </ul>
  )
}

/** An assistant's face, by its id, from the roster the page holds — read
 *  as it is, not fetched for a card. */
function RosterFace({ botId, size = 24 }: { botId: number; size?: number }) {
  const entries = usePersonalAgentRoster((st) => st.entries)
  const botName = useBotName()
  const entry = entries?.find((e) => e.id === botId)
  return (
    <BotAvatar
      avatar={entry?.avatar}
      name={botName(entry ?? { id: botId, kind: "worker" })}
      size={size}
      star={entry?.kind === "primary"}
    />
  )
}

/** What will be sent (or was): set in as a quote is. */
const QUOTED = "border-s-2 border-border ps-3"

export function NoticeCard({ item }: { item: NoticeItem }) {
  const kind = str(item.row.data, "notice")
  if (kind === "proposal" || kind === "uncertain") {
    return <ActionCard item={item} uncertain={kind === "uncertain"} />
  }
  if (kind === "loop") return <LoopCard item={item} />
  if (kind === "stopped") return <StoppedCard item={item} />
  if (kind === "changed") {
    const what = str(item.row.data, "what")
    if (what === "bots") return <BotsChangedCard item={item} />
    return <ChangedCard item={item} />
  }
  if (kind === "choice") {
    return str(item.row.data, "purpose") === "meet" ? (
      <MeetNameCard item={item} />
    ) : (
      <ChoiceCard item={item} />
    )
  }
  if (kind === "onboarding") {
    return str(item.row.data, "purpose") === "promises" ? (
      <PromisesCard item={item} />
    ) : (
      <ConnectCard item={item} />
    )
  }
  if (kind === "starter") return <StarterCard item={item} />
  if (kind === "ask") return <AskCard item={item} />
  if (kind === "reminder") return <ReminderCard item={item} />
  if (kind === "acceptance") return <AcceptanceCard item={item} />
  if (kind === "forge") return <ForgeCard item={item} />
  if (kind === "pr") return <PrCard item={item} />
  if (kind === "routine") return <RoutineCard item={item} />
  if (kind === "rule") return <RuleCard item={item} />
  if (kind === "brief") return <BriefCard item={item} />
  if (kind === "memory" || kind === "tidy") return <MemoryCard item={item} />
  if (kind === "skill") return <SkillCard item={item} />
  if (kind === "plan") return <PlanCard item={item} />
  if (kind === "check") return <CheckCard item={item} />
  return null
}

type Choice =
  | "accept"
  | `accept:${string}`
  | "dismiss"
  | "undo"
  | `undo:${number}`
  | `stop:${number}`

/** Answer a card; the error to show when the answer did not go through. */
function useAnswer(noticeId: number) {
  const botId = useBotId()
  const [busy, setBusy] = useState<Choice | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const answer = async (choice: Choice) => {
    if (!Number.isFinite(noticeId) || busy) return
    setBusy(choice)
    setFailed(null)
    try {
      await personalAgentNoticeAct(noticeId, choice, botId)
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  return { busy, failed, answer }
}

function ActionCard({
  item,
  uncertain,
}: {
  item: NoticeItem
  uncertain: boolean
}) {
  const t = useTranslations("PersonalAgent.notice")
  const { dispatchById } = usePersonalAgent()
  const { readOnly } = usePageScope()
  const openWork = useOpenWork()
  const meta = useWorkMeta()
  const row = item.row
  const data = row.data
  const display = obj(data?.display)
  const action = str(data, "action")
  const state = str(data, "state") ?? "open"
  const error = str(data, "error")
  const { busy, failed, answer } = useAnswer(Number(row.ref_id))

  const mode = asMode(display?.mode)
  // The work it is about: the dispatch it made, or the one it continues.
  const workId =
    num(obj(data?.result), "dispatch_id") ?? num(display, "dispatch_id")
  const info = workId != null ? dispatchById.get(workId) : undefined
  const target =
    workId != null
      ? workTargetOf(info, {
          ...row,
          dispatch_id: workId,
          data: display,
        })
      : null
  const openable = target != null && canOpenWork(target)
  const intent = str(display, "intent")
  const text = str(display, "prompt") ?? str(display, "message")
  // Held for the owner's confirmation by their settings, not suggested.
  const confirm = !uncertain && str(data, "why") === "confirm"
  // Work a restart interrupted, to retry (7.3).
  const retry = display?.retry === true
  // Offered for tonight at the wrap-up (6.5).
  const tonight = !uncertain && !confirm && data?.tonight === true
  const isMessage = action === "message"
  const tc = (k: "open" | "acted" | "dismissed" | "accept" | "dismiss") =>
    t(`confirm.${k}` as "confirm.open")

  const heading = tonight
    ? state === "acting"
      ? t("acting")
      : state === "acted"
        ? t("tonight.acted")
        : state === "dismissed"
          ? t("tonight.dismissed")
          : state === "unknown"
            ? t("unknown")
            : t("tonight.open")
    : confirm
      ? state === "acting"
        ? t("acting")
        : state === "acted"
          ? tc("acted")
          : state === "dismissed"
            ? tc("dismissed")
            : state === "unknown"
              ? t("unknown")
              : tc("open")
      : uncertain
        ? state === "acting"
          ? t("uncertain.acting")
          : state === "acted"
            ? t("uncertain.acted")
            : state === "dismissed"
              ? t("uncertain.dismissed")
              : state === "resolved"
                ? t("uncertain.resolved")
                : t("uncertain.open")
        : state === "acting"
          ? t("acting")
          : state === "acted"
            ? t("acted")
            : state === "dismissed"
              ? t("dismissed")
              : state === "unknown"
                ? t("unknown")
                : t("open")
  // Waiting for the owner: open, or — a run cut off with no telling — not
  // sure it ran, which can be run again or let be.
  const answerable = state === "open" || state === "unknown"
  const hint = uncertain
    ? answerable
      ? t("uncertain.hint")
      : null
    : state === "unknown"
      ? t("unknownHint")
      : null
  const shownError = failed ?? (state === "open" ? error : null)
  const followupIntent =
    action === "followup" && intent && INTENTS.has(intent) ? intent : null
  const awake = tonight && state === "open" && data?.keep_awake === true
  const Icon = uncertain ? CircleHelp : tonight ? Moon : Lightbulb
  const settle: Settle =
    state === "acting"
      ? "busy"
      : state === "acted" || state === "resolved"
        ? "done"
        : state === "dismissed"
          ? "off"
          : state === "unknown"
            ? "warn"
            : "open"
  const toId = num(display, "to")
  return (
    <MessageRow
      rowId={row.id}
      side="start"
      gap={item.gap}
      tail={item.tail}
      roomy
      actions={{
        rowId: row.id,
        text: [str(display, "title"), text].filter(Boolean).join("\n\n"),
        at: row.created_at,
      }}
    >
      <CardMessage
        data-pa-notice={state}
        head={<CardHead icon={Icon} settle={settle} heading={heading} />}
      >
        {/* What it is about: the work, its row the card's head; or the
            message — to whom, and what it says. */}
        {isMessage ? (
          <SheetPart className="flex flex-col gap-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              {toId != null ? <RosterFace botId={toId} size={28} /> : null}
              <p
                className="min-w-0 text-sm leading-5 font-medium break-words"
                data-pa-confirm-message
              >
                {t("confirm.messageTo", {
                  name: str(display, "to_name") ?? "",
                })}
              </p>
            </div>
            {text ? (
              <div className={QUOTED}>
                <CollapsedText text={text} />
              </div>
            ) : null}
          </SheetPart>
        ) : (
          <WorkRow
            flat
            mode={mode}
            title={
              retry
                ? t("retryOf", { title: str(display, "title") ?? "" })
                : action === "followup"
                  ? t("followupOf", { title: str(display, "title") ?? "" })
                  : (str(display, "title") ?? row.body)
            }
            meta={meta({
              mode,
              folder: str(display, "project"),
            })}
            chip={
              followupIntent ? (
                <span
                  className="inline-flex h-5 shrink-0 items-center rounded-full bg-sky-500/15 px-2 text-[0.6875rem] font-medium text-sky-700 dark:text-sky-300"
                  data-pa-intent={followupIntent}
                >
                  {t(`intent.${followupIntent}` as "intent.revise")}
                </span>
              ) : null
            }
            onOpen={openable ? () => openWork(target) : null}
          />
        )}
        {/* What the work is to do, as it will be sent. */}
        {!isMessage && text ? (
          <SheetPart>
            <div className={QUOTED}>
              <CollapsedText text={text} />
            </div>
          </SheetPart>
        ) : null}
        {/* What to know before answering: not sure it ran, that the
            computer stays awake tonight. */}
        {hint || awake ? (
          <SheetPart className="flex flex-col gap-1.5 text-xs leading-5">
            {hint ? (
              <p className="flex items-start gap-2 break-words text-amber-700 dark:text-amber-400">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0">{hint}</span>
              </p>
            ) : null}
            {awake ? (
              <p
                className="flex items-start gap-2 text-muted-foreground"
                data-pa-tonight-awake
              >
                <Moon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0">{t("tonight.awake")}</span>
              </p>
            ) : null}
          </SheetPart>
        ) : null}
        {answerable ? (
          <SheetActions>
            <Button
              size="sm"
              disabled={readOnly || busy != null}
              onClick={() => void answer("accept")}
            >
              {busy === "accept" ? (
                <SyncedSpinner small className="size-3.5" />
              ) : null}
              {uncertain
                ? t("uncertain.again")
                : state === "unknown"
                  ? t("again")
                  : confirm
                    ? tc("accept")
                    : tonight
                      ? t("tonight.accept")
                      : t("accept")}
            </Button>
            {uncertain && openable ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => openWork(target)}
              >
                {t("uncertain.look")}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={readOnly || busy != null}
              onClick={() => void answer("dismiss")}
            >
              {uncertain
                ? t("uncertain.dismiss")
                : confirm
                  ? tc("dismiss")
                  : tonight
                    ? t("tonight.dismiss")
                    : t("dismiss")}
            </Button>
            {/* The assistant's own suggestion (6.7); tonight's offer is
                the owner's "tonight I can do", not that. */}
            {!uncertain && !confirm && !tonight && state === "open" ? (
              <MuteKindButton
                noticeId={Number(row.ref_id)}
                disabled={busy != null}
              />
            ) : null}
          </SheetActions>
        ) : null}
        <NoticeFoot
          data={data}
          error={shownError ? t("failed", { error: shownError }) : null}
        />
      </CardMessage>
    </MessageRow>
  )
}

function faces(v: unknown): BotFace[] {
  return Array.isArray(v)
    ? v.filter((b): b is BotFace => b != null && typeof b === "object")
    : []
}

/** The frame the cards about assistants share: the card itself, its
 *  heading (its kind's icon, where it stands, on its tone once settled),
 *  its parts (`SheetPart`, `SheetActions`) — the sheet's direct children —
 *  and a last band for a muted kind or an answer that did not go through. */
function CardFrame({
  item,
  icon,
  heading,
  settle = "open",
  text,
  failed,
  children,
}: {
  item: NoticeItem
  icon: LucideIcon
  heading: string
  settle?: Settle
  text: string
  failed: string | null
  children: React.ReactNode
}) {
  const t = useTranslations("PersonalAgent.notice")
  const row = item.row
  return (
    <MessageRow
      rowId={row.id}
      side="start"
      gap={item.gap}
      tail={item.tail}
      roomy
      actions={{ rowId: row.id, text, at: row.created_at }}
    >
      <CardMessage
        data-pa-notice={str(row.data, "state") ?? "open"}
        head={<CardHead icon={icon} settle={settle} heading={heading} />}
      >
        {children}
        <NoticeFoot
          data={row.data}
          error={failed ? t("failed", { error: failed }) : null}
        />
      </CardMessage>
    </MessageRow>
  )
}

function LoopCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.notice.loop")
  const { readOnly } = usePageScope()
  const row = item.row
  const data = row.data
  const state = str(data, "state") ?? "open"
  const [a, b] = faces(data?.bots)
  const { busy, failed, answer } = useAnswer(Number(row.ref_id))
  const [sheet, setSheet] = useState<TimelineRow | null>(null)
  const botName = useBotName()
  const names = { a: botName(a ?? null), b: botName(b ?? null) }
  const text =
    str(data, "why") === "cycle"
      ? t("cycle", names)
      : t("noProgress", { ...names, count: num(data, "count") ?? 0 })
  const thread = num(data, "thread_id")
  const refused = str(data, "refused")
  return (
    <CardFrame
      item={item}
      icon={Repeat}
      settle={
        state === "acted" ? "done" : state === "dismissed" ? "off" : "open"
      }
      heading={
        state === "acted"
          ? t("continued")
          : state === "dismissed"
            ? t("takenOver")
            : t("open")
      }
      text={text}
      failed={failed}
    >
      {/* The two assistants it is between, then what happened. */}
      <SheetPart className="flex flex-col gap-2.5">
        {a && b ? (
          <div
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium"
            data-pa-loop-between
          >
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <BotAvatar avatar={a.avatar} name={names.a} size={24} />
              <span className="truncate">{names.a}</span>
            </span>
            <ArrowLeftRight
              className="size-3.5 shrink-0 text-muted-foreground rtl:-scale-x-100"
              aria-hidden
            />
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <BotAvatar avatar={b.avatar} name={names.b} size={24} />
              <span className="truncate">{names.b}</span>
            </span>
          </div>
        ) : null}
        <p className="text-sm leading-5 break-words">{text}</p>
        {refused ? (
          <p
            className={cn(
              QUOTED,
              "text-xs leading-5 break-words text-muted-foreground"
            )}
          >
            {t("refused", { text: refused })}
          </p>
        ) : null}
      </SheetPart>
      {(thread != null && a && b) || state === "open" ? (
        <SheetActions>
          {state === "open" ? (
            <Button
              size="sm"
              disabled={readOnly || busy != null}
              onClick={() => void answer("accept")}
            >
              {busy === "accept" ? (
                <SyncedSpinner small className="size-3.5" />
              ) : null}
              {t("goOn")}
            </Button>
          ) : null}
          {thread != null && a && b ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                setSheet({
                  ...row,
                  data: {
                    thread_id: thread,
                    direction: "out",
                    from_bot_id: a.id,
                    to_bot_id: b.id,
                  },
                })
              }
            >
              {t("look")}
            </Button>
          ) : null}
          {state === "open" ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={readOnly || busy != null}
              onClick={() => void answer("dismiss")}
            >
              {t("mine")}
            </Button>
          ) : null}
        </SheetActions>
      ) : null}
      <ExchangeSheet row={sheet} onClose={() => setSheet(null)} />
    </CardFrame>
  )
}

interface Taken {
  id: number
  to: BotFace | null
  excerpt: string
}

function takenList(v: unknown): Taken[] {
  if (!Array.isArray(v)) return []
  return v
    .filter(
      (x): x is Record<string, unknown> => x != null && typeof x === "object"
    )
    .map((x) => ({
      id: num(x, "id") ?? 0,
      to:
        x.to && typeof x.to === "object" ? (x.to as unknown as BotFace) : null,
      excerpt: str(x, "excerpt") ?? "",
    }))
}

function StoppedCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.notice.stopped")
  const { readOnly } = usePageScope()
  const row = item.row
  const data = row.data
  const { busy, failed, answer } = useAnswer(Number(row.ref_id))
  const work = Array.isArray(data?.dispatches)
    ? (data.dispatches as unknown[])
        .filter(
          (x): x is Record<string, unknown> =>
            x != null && typeof x === "object"
        )
        .map((x) => ({ id: num(x, "id") ?? 0, title: str(x, "title") }))
    : []
  const messages = takenList(data?.messages)
  const handled = takenList(data?.handled)
  const also = new Set(
    Array.isArray(data?.also_stopped)
      ? (data.also_stopped as unknown[]).filter(
          (v): v is number => typeof v === "number"
        )
      : []
  )
  const heading = str(data, "scope") === "all" ? t("all") : t("this")
  const botName = useBotName()
  return (
    <CardFrame
      item={item}
      icon={OctagonX}
      heading={heading}
      text={heading}
      failed={failed}
    >
      {work.length > 0 ? (
        <SheetPart>
          <SheetLabel>{t("work", { count: work.length })}</SheetLabel>
          <ul className={CARD_LIST} data-pa-stopped-work>
            {work.map((w) => (
              <li key={w.id} className="flex min-w-0 items-center gap-2.5">
                <RowIcon icon={ListTodo} className="size-6 rounded-md" />
                <span className="min-w-0 text-sm leading-5 break-words">
                  {w.title ?? `#${w.id}`}
                </span>
              </li>
            ))}
          </ul>
        </SheetPart>
      ) : null}
      {messages.length > 0 ? (
        <SheetPart>
          <SheetLabel>{t("messages", { count: messages.length })}</SheetLabel>
          <ul className={CARD_LIST} data-pa-stopped-messages>
            {messages.map((m) => {
              const line = t("messageTo", {
                name: botName(m.to),
                text: m.excerpt,
              })
              const split = splitLine(line)
              return (
                <li key={m.id} className="flex min-w-0 items-start gap-2.5">
                  {m.to ? (
                    <BotAvatar
                      avatar={m.to.avatar}
                      name={botName(m.to)}
                      size={24}
                    />
                  ) : null}
                  <div className="flex min-w-0 flex-col gap-0.5 break-words">
                    {split ? (
                      <RowLines head={split.head} text={split.text} />
                    ) : (
                      <p className="text-sm leading-5">{line}</p>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </SheetPart>
      ) : null}
      {handled.length > 0 ? (
        <SheetPart>
          <SheetLabel>{bareLabel(t("notStopped"))}</SheetLabel>
          <ul className={CARD_LIST} data-pa-stopped-handled>
            {handled.map((h) => (
              <li
                key={h.id}
                className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2"
              >
                <span className="flex min-w-0 flex-[1_1_12rem] items-start gap-2.5">
                  {h.to ? (
                    <BotAvatar
                      avatar={h.to.avatar}
                      name={botName(h.to)}
                      size={24}
                    />
                  ) : null}
                  <span className="min-w-0 text-sm leading-5 break-words">
                    {t("onIt", { name: botName(h.to), text: h.excerpt })}
                  </span>
                </span>
                {also.has(h.id) ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <CircleCheck className="size-3.5" aria-hidden />
                    {t("alsoStopped")}
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={readOnly || busy != null}
                    onClick={() => void answer(`stop:${h.id}`)}
                  >
                    {busy === `stop:${h.id}` ? (
                      <SyncedSpinner small className="size-3.5" />
                    ) : null}
                    {t("stopToo", { name: botName(h.to) })}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </SheetPart>
      ) : null}
    </CardFrame>
  )
}

/** A persona's change, whole: the opening it has now (as the card was
 *  made) and the one it gets — what is written when it is accepted. */
function PersonaChange({ from, to }: { from: unknown; to: unknown }) {
  const t = useTranslations("PersonalAgent.notice.changed.team")
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "")
  const before = text(from)
  const after = text(to)
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-pa-persona-change>
      <div>
        <p className="text-[0.6875rem] leading-4 text-muted-foreground">
          {t("personaNow")}
        </p>
        <p
          className="text-sm leading-5 break-words whitespace-pre-wrap text-muted-foreground"
          data-pa-persona-from
        >
          {before || t("empty")}
        </p>
      </div>
      <div>
        <p className="text-[0.6875rem] leading-4 text-muted-foreground">
          {t("personaNew")}
        </p>
        <p
          className="text-sm leading-5 font-medium break-words whitespace-pre-wrap"
          data-pa-persona-to
        >
          {after || t("empty")}
        </p>
      </div>
    </div>
  )
}

/** A label as a band's heading: its own colon left to the layout. */
function bareLabel(label: string): string {
  return label.replace(/\s*[:：]\s*$/u, "")
}

/** The page an item is on: a tab of the assistant's own page, or a page of
 *  the settings every assistant shares. */
export function pageOf(key: string): PersonalAgentPage {
  if (key === "own.brain") return "identity"
  if (key.startsWith("own.")) return "advanced"
  // An assistant's own item: on its own page (whose — `botUidOf`).
  if (key.startsWith("bot.")) {
    const field = key.split(".")[2] ?? ""
    if (field === "persona") return "persona"
    if (field === "notify" || field === "muted") return "notify"
    return "identity"
  }
  const item = key.replace(/^prefs\./, "") as PersonalAgentPrefKey
  if (item === "projects") return "projects"
  if (ABOUT_ITEMS.includes(item)) return "about"
  if (PROACTIVE_ITEMS.includes(item)) return "proactive"
  return COMMUNICATION_ITEMS.includes(item) ? "communication" : "automation"
}

/** The assistant a `bot.<uid>.<item>` key is about. */
export function botUidOf(key: string): string | null {
  return key.startsWith("bot.") ? (key.split(".")[1] ?? null) : null
}

/** The options codeg picked for the owner on a brain or an agent, and who
 *  picked each: the owner's words, another executor config, the agent. */
function PickedList({
  picked,
  className,
}: {
  picked: PickedOption[]
  className?: string
}) {
  const t = useTranslations("PersonalAgent.bots.choice")
  if (picked.length === 0) return null
  return (
    <ul
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-s-2 border-border ps-3 text-xs leading-5",
        className
      )}
      data-pa-picked
    >
      {picked.map((p) => (
        <li key={p.id} className="contents" data-pa-picked-from={p.from}>
          <span className="text-muted-foreground">{p.name}</span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 break-words">
            <span>{p.value_label}</span>
            <span className="inline-flex h-4 items-center rounded-sm bg-muted px-1 text-[0.625rem] text-muted-foreground">
              {t(`from.${p.from}` as "from.given")}
            </span>
          </span>
        </li>
      ))}
    </ul>
  )
}

function pickedOf(v: unknown): PickedOption[] {
  return Array.isArray(v)
    ? v.filter(
        (p): p is PickedOption =>
          p != null &&
          typeof p === "object" &&
          typeof (p as PickedOption).id === "string"
      )
    : []
}

/** A change to the settings from the conversation (13.3): made as the owner
 *  said, with [Undo]; or put in front of them first — they asked to see
 *  such changes first, or the assistant only inferred it — with [Change
 *  it] [Not now]. In the primary's conversation, one line for what a work
 *  assistant changed of everyone's. */
function ChangedCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.notice.changed")
  const { readOnly } = usePageScope()
  const openSettings = usePersonalAgentUi((s) => s.openSettings)
  const openBotPage = usePersonalAgentUi((s) => s.openBotPage)
  const entries = usePersonalAgentRoster((st) => st.entries)
  const botName = useBotName()
  const row = item.row
  const data = row.data
  const { label, value } = useChangeText(namesOf(data?.names))
  const state = str(data, "state") ?? "open"
  const why = str(data, "why") ?? "asked"
  const changes = changesOf(data?.changes)
  const quote = str(data, "quote")
  const unchecked = str(data, "unchecked_quote")
  const reason = str(data, "reason")
  const forRow = num(data, "for_row")
  const kept = Array.isArray(data?.kept) ? (data.kept as string[]) : []
  const error = str(data, "error")
  const { busy, failed, answer } = useAnswer(Number(row.ref_id))
  const from =
    data?.from_bot && typeof data.from_bot === "object"
      ? (data.from_bot as { id?: number; name?: string; kind?: string })
      : null
  const heading =
    why === "line"
      ? t("line", { name: botName(from) })
      : state === "applied"
        ? why === "asked"
          ? t("applied")
          : t("accepted")
        : state === "undone"
          ? t("undone")
          : state === "dismissed"
            ? t("dismissed")
            : why === "suggest"
              ? t("suggested")
              : t("show")
  const text = changes
    .map(
      (c) => `${label(c.key)}: ${value(c.key, c.from)} → ${value(c.key, c.to)}`
    )
    .join("\n")
  const why_: { key: string; icon: LucideIcon; text: React.ReactNode }[] = []
  if (forRow == null && quote) {
    why_.push({
      key: "quote",
      icon: MessageSquareQuote,
      text: t("quote", { quote }),
    })
  }
  if (unchecked) {
    why_.push({
      key: "unchecked",
      icon: CircleHelp,
      text: t("uncheckedQuote", { quote: unchecked }),
    })
  }
  if (reason)
    why_.push({ key: "reason", icon: Lightbulb, text: t("reason", { reason }) })
  if (kept.length > 0) {
    why_.push({
      key: "kept",
      icon: History,
      text: t("kept", { items: kept.map(label).join("、") }),
    })
  }
  return (
    <CardFrame
      item={item}
      icon={SlidersHorizontal}
      settle={
        why === "line" || state === "applied"
          ? "done"
          : state === "undone"
            ? "undone"
            : state === "dismissed"
              ? "off"
              : "open"
      }
      heading={heading}
      text={text}
      failed={
        failed ?? (state === "open" || state === "applied" ? error : null)
      }
    >
      {/* Each setting: what it is on the left, what it was and what it is
          now on the right. */}
      {changes.length > 0 ? (
        <SheetPart>
          <SheetFields className="text-sm" data-pa-changes>
            {changes.map((c) => (
              <SheetField
                key={c.key}
                label={
                  <span className="text-xs leading-5">{label(c.key)}</span>
                }
                data-pa-change={c.key}
              >
                {teamKey(c.key)?.field === "persona" ? (
                  <PersonaChange from={c.from} to={c.to} />
                ) : (
                  <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 leading-5">
                    <span className="text-muted-foreground line-through decoration-muted-foreground/60">
                      <ChangeValue item={c.key} value={c.from} text={value} />
                    </span>
                    <span
                      aria-hidden
                      className="text-muted-foreground rtl:-scale-x-100"
                    >
                      →
                    </span>
                    <span className="font-medium">
                      <ChangeValue item={c.key} value={c.to} text={value} />
                    </span>
                  </span>
                )}
                <PickedList
                  picked={pickedOf(c.picked)}
                  className="mt-1 w-full"
                />
              </SheetField>
            ))}
          </SheetFields>
        </SheetPart>
      ) : null}
      {/* Why, and on whose word: the message it came from, the reason, what
          was kept as it was, where else it takes effect. */}
      {forRow != null || why_.length > 0 ? (
        <SheetPart className="flex flex-col gap-2">
          {forRow != null ? <QuoteBar targetId={forRow} tone="light" /> : null}
          <WhyLines lines={why_} />
        </SheetPart>
      ) : null}
      {why !== "line" &&
      (state === "open" || state === "applied" || changes.length > 0) ? (
        <SheetActions>
          {state === "open" ? (
            <>
              <Button
                size="sm"
                disabled={readOnly || busy != null}
                onClick={() => void answer("accept")}
              >
                {busy === "accept" ? (
                  <SyncedSpinner small className="size-3.5" />
                ) : null}
                {t("accept")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={readOnly || busy != null}
                onClick={() => void answer("dismiss")}
              >
                {t("dismiss")}
              </Button>
              {why === "suggest" ? (
                <MuteKindButton
                  noticeId={Number(row.ref_id)}
                  disabled={busy != null}
                />
              ) : null}
            </>
          ) : state === "applied" ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={readOnly || busy != null}
              onClick={() => void answer("undo")}
            >
              {busy === "undo" ? (
                <SyncedSpinner small className="size-3.5" />
              ) : null}
              {t("undo")}
            </Button>
          ) : null}
          {changes.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const page = pageOf(changes[0].key)
                const uid = botUidOf(changes[0].key)
                // Another assistant's item: its own page.
                const of = uid ? entries?.find((e) => e.uid === uid) : undefined
                if (of && isBotTab(page)) {
                  openBotPage(page, {
                    bot: of.kind === "primary" ? null : of.id,
                  })
                } else if (isBotTab(page)) openBotPage(page)
                else if (page !== "assistants") openSettings(page)
              }}
            >
              {t("seeSettings")}
            </Button>
          ) : null}
        </SheetActions>
      ) : null}
    </CardFrame>
  )
}

interface MadeBot {
  bot_id: number
  name: string
  face: BotFace | null
  /** The agent its work runs on. */
  work_agent?: string | null
  picked: { from: string }[]
  state: "made" | "undone"
}

function madeBots(v: unknown): MadeBot[] {
  return Array.isArray(v)
    ? v.filter(
        (b): b is MadeBot =>
          b != null && typeof b === "object" && typeof b.bot_id === "number"
      )
    : []
}

/** Work assistants made from the conversation (4.12), each with [Undo] —
 *  or one to make, waiting on the owner: [Make it] [Not now]. The persona
 *  it is made with shows whole: what accepting the card writes. */
function BotsChangedCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.bots.changed")
  const { readOnly } = usePageScope()
  const setViewBot = usePersonalAgentUi((s) => s.setViewBot)
  const row = item.row
  const data = row.data
  const state = str(data, "state") ?? "open"
  const why = str(data, "why") ?? "asked"
  const bots = madeBots(data?.bots)
  const pending = obj(data?.pending)
  const quote = str(data, "quote")
  const unchecked = str(data, "unchecked_quote")
  const reason = str(data, "reason")
  const error = str(data, "error")
  const persona = str(pending, "persona")
  const { busy, failed, answer } = useAnswer(Number(row.ref_id))
  const live = bots.filter((b) => b.state !== "undone")
  const heading =
    state === "open"
      ? why === "suggest"
        ? t("suggested")
        : t("show")
      : state === "dismissed"
        ? t("dismissed")
        : state === "undone"
          ? t("undone")
          : t("applied")
  const text = bots.map((b) => b.name).join(", ") || str(pending, "name") || ""
  const why_: { key: string; icon: LucideIcon; text: React.ReactNode }[] = []
  if (quote) {
    why_.push({
      key: "quote",
      icon: MessageSquareQuote,
      text: t("quote", { quote }),
    })
  }
  if (unchecked) {
    why_.push({
      key: "unchecked",
      icon: CircleHelp,
      text: t("uncheckedQuote", { quote: unchecked }),
    })
  }
  if (reason)
    why_.push({ key: "reason", icon: Lightbulb, text: t("reason", { reason }) })
  const proposing =
    state === "open" || (state === "dismissed" && bots.length === 0)
  return (
    <CardFrame
      item={item}
      icon={UserPlus}
      settle={
        state === "open"
          ? "open"
          : state === "dismissed"
            ? "off"
            : state === "undone"
              ? "undone"
              : "done"
      }
      heading={heading}
      text={text}
      failed={
        failed ?? (state === "open" || state === "applied" ? error : null)
      }
    >
      <SheetPart className="flex flex-col gap-2.5">
        {proposing ? (
          <p className={SHEET_TITLE} data-pa-bot-pending>
            {str(pending, "name")}
          </p>
        ) : (
          <ul className={CARD_LIST} data-pa-bots-made>
            {bots.map((b) => {
              const filled = b.picked.filter((p) => p.from !== "given").length
              return (
                <li
                  key={b.bot_id}
                  data-pa-bot-made={b.bot_id}
                  data-state={b.state}
                  className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2"
                >
                  <span className="flex min-w-0 flex-[1_1_12rem] items-center gap-2.5">
                    <BotAvatar
                      avatar={b.face?.avatar ?? null}
                      name={b.name}
                      size={32}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block truncate text-sm leading-5 font-medium",
                          b.state === "undone" &&
                            "text-muted-foreground line-through"
                        )}
                      >
                        {b.name}
                      </span>
                      {b.work_agent ? (
                        <span className="block truncate text-xs leading-4 text-muted-foreground">
                          {filled > 0
                            ? t("workFilled", {
                                agent: b.work_agent,
                                count: filled,
                              })
                            : t("workOn", { agent: b.work_agent })}
                        </span>
                      ) : null}
                    </span>
                  </span>
                  {b.state !== "undone" ? (
                    <span className="flex shrink-0 items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setViewBot(b.bot_id)}
                      >
                        {t("open")}
                      </Button>
                      {bots.length > 1 && state === "applied" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={readOnly || busy != null}
                          onClick={() => void answer(`undo:${b.bot_id}`)}
                          data-pa-undo-bot={b.bot_id}
                        >
                          {busy === `undo:${b.bot_id}` ? (
                            <SyncedSpinner small className="size-3" />
                          ) : null}
                          {t("undoOne")}
                        </Button>
                      ) : null}
                    </span>
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      <Undo2 className="size-3.5" aria-hidden />
                      {t("undoneOne")}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {persona ? (
          <div data-pa-bot-persona>
            <p className="text-[0.6875rem] leading-4 text-muted-foreground">
              {t("persona")}
            </p>
            <p className="text-sm leading-5 break-words whitespace-pre-wrap">
              {persona}
            </p>
          </div>
        ) : null}
      </SheetPart>
      {why_.length > 0 ? (
        <SheetPart>
          <WhyLines lines={why_} />
        </SheetPart>
      ) : null}
      {state === "open" || (state === "applied" && live.length > 0) ? (
        <SheetActions>
          {state === "open" ? (
            <>
              <Button
                size="sm"
                disabled={readOnly || busy != null}
                onClick={() => void answer("accept")}
                data-pa-bots-accept
              >
                {busy === "accept" ? (
                  <SyncedSpinner small className="size-3.5" />
                ) : null}
                {t("accept")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={readOnly || busy != null}
                onClick={() => void answer("dismiss")}
              >
                {t("dismiss")}
              </Button>
              {why === "suggest" ? (
                <MuteKindButton
                  noticeId={Number(row.ref_id)}
                  disabled={busy != null}
                />
              ) : null}
            </>
          ) : state === "applied" && live.length > 0 ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={readOnly || busy != null}
              onClick={() => void answer("undo")}
              data-pa-undo-bots
            >
              {busy === "undo" ? (
                <SyncedSpinner small className="size-3.5" />
              ) : null}
              {bots.length > 1 ? t("undoAll") : t("undo")}
            </Button>
          ) : null}
        </SheetActions>
      ) : null}
    </CardFrame>
  )
}
