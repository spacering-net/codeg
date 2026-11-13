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
 * - **changed**: a settings change from the conversation (13.3), the work
 *   assistants and executor configs among them (10.5); work assistants made
 *   (4.12), an executor config made or to make.
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
  CircleHelp,
  Layers,
  Lightbulb,
  Moon,
  UserPlus,
  OctagonX,
  Repeat,
  SlidersHorizontal,
} from "lucide-react"

import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { useBotId, usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentNoticeAct } from "@/lib/api"
import type {
  AgentType,
  AssistantLabelSnapshot,
  BotFace,
  ChangedItem,
  MadeExecutorData,
  PersonalAgentPrefKey,
  PickedOption,
  TimelineRow,
} from "@/lib/types"
import { AGENT_LABELS } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAssistants } from "@/stores/assistants-store"
import {
  usePersonalAgentUi,
  type SettingsPage,
} from "@/stores/personal-agent-ui-store"

import { AcceptanceCard } from "./acceptance-card"
import { AskCard } from "./ask-card"
import { BriefCard } from "./brief-card"
import { BotAvatar } from "./bot-avatar"
import { ChoiceCard } from "./choice-card"
import { CollapsedText } from "./event-card"
import { ExchangeSheet } from "./exchange-sheet"
import { ForgeCard } from "./forge-card"
import { PrCard } from "./pr-card"
import { RoutineCard } from "./routine-card"
import { RuleCard } from "./rule-card"
import { MutedNote, MuteKindButton } from "./mute-kind"
import type { MessageItem } from "./message-items"
import { bubbleCorners, MessageRow } from "./message-row"
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
  choiceKey,
  COMMUNICATION_ITEMS,
  isClockItem,
  PROACTIVE_ITEMS,
} from "./settings/pref-pages"
import {
  AGENT_SURFACE,
  asMode,
  canOpenWork,
  num,
  str,
  useOpenWork,
  useBotName,
  usePageScope,
  useWorkMeta,
  workTargetOf,
} from "./shared"
import { useBotTemplates } from "./use-templates"
import { WORK_WELL, WorkRow } from "./work-card"

type NoticeItem = Extract<MessageItem, { kind: "notice" }>

type Display = Record<string, unknown> | null

function obj(v: unknown): Display {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null
}

const INTENTS = new Set(["revise", "continue", "question", "verify"])

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
    if (what === "assistant") return <AssistantChangedCard item={item} />
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

  const executor = str(display, "executor")
  const agentType = str(display, "agent_type") as AgentType | null
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
  const Icon = uncertain ? CircleHelp : tonight ? Moon : Lightbulb
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
      <div
        data-bubble
        data-pa-notice={state}
        className={cn(
          AGENT_SURFACE,
          bubbleCorners("start", item.tail),
          "min-w-0 p-3 text-sm text-foreground"
        )}
      >
        <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          {state === "acting" ? (
            <SyncedSpinner small className="size-3.5 shrink-0" />
          ) : (
            <Icon className="size-3.5 shrink-0" aria-hidden />
          )}
          <span className="font-medium">{heading}</span>
        </p>
        {hint ? <p className="mb-2.5 text-sm break-words">{hint}</p> : null}
        {isMessage ? (
          <p
            className="mb-1 text-xs text-muted-foreground"
            data-pa-confirm-message
          >
            {t("confirm.messageTo", { name: str(display, "to_name") ?? "" })}
          </p>
        ) : (
          <div className={WORK_WELL}>
            <WorkRow
              executorId={num(display, "executor_id")}
              executor={executor}
              agentType={agentType}
              title={
                retry
                  ? t("retryOf", { title: str(display, "title") ?? "" })
                  : action === "followup"
                    ? t("followupOf", { title: str(display, "title") ?? "" })
                    : (str(display, "title") ?? row.body)
              }
              meta={meta({
                executor,
                mode,
                folder: str(display, "project"),
              })}
              chip={null}
              onOpen={openable ? () => openWork(target) : null}
            />
          </div>
        )}
        {action === "followup" && intent && INTENTS.has(intent) ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {t(`intent.${intent}` as "intent.revise")}
          </p>
        ) : null}
        {text ? <CollapsedText text={text} /> : null}
        {tonight && state === "open" && data?.keep_awake === true ? (
          <p
            className="mt-2 text-xs text-muted-foreground"
            data-pa-tonight-awake
          >
            {t("tonight.awake")}
          </p>
        ) : null}
        {answerable ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {uncertain && openable ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => openWork(target)}
              >
                {t("uncertain.look")}
              </Button>
            ) : null}
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
          </div>
        ) : null}
        <MutedNote data={data} />
        {shownError ? (
          <p role="alert" className="mt-2 text-xs break-words text-destructive">
            {t("failed", { error: shownError })}
          </p>
        ) : null}
      </div>
    </MessageRow>
  )
}

function faces(v: unknown): BotFace[] {
  return Array.isArray(v)
    ? v.filter((b): b is BotFace => b != null && typeof b === "object")
    : []
}

/** The frame the cards about assistants share: a heading with its icon, the
 *  card's body, the error of an answer that did not go through. */
function CardFrame({
  item,
  icon: Icon,
  heading,
  text,
  failed,
  children,
}: {
  item: NoticeItem
  icon: typeof Repeat
  heading: string
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
      <div
        data-bubble
        data-pa-notice={str(row.data, "state") ?? "open"}
        className={cn(
          AGENT_SURFACE,
          bubbleCorners("start", item.tail),
          "min-w-0 p-3 text-sm text-foreground"
        )}
      >
        <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="size-3.5 shrink-0" aria-hidden />
          <span className="font-medium">{heading}</span>
        </p>
        {children}
        {/* "Don't suggest these" was pressed on it (6.7). */}
        <MutedNote data={row.data} />
        {failed ? (
          <p role="alert" className="mt-2 text-xs break-words text-destructive">
            {t("failed", { error: failed })}
          </p>
        ) : null}
      </div>
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
  return (
    <CardFrame
      item={item}
      icon={Repeat}
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
      <p className="text-sm break-words">{text}</p>
      {str(data, "refused") ? (
        <p className="mt-1.5 text-xs break-words text-muted-foreground">
          {t("refused", { text: str(data, "refused") ?? "" })}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {thread != null && a && b ? (
          <Button
            size="sm"
            variant="outline"
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
          <>
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
            <Button
              size="sm"
              variant="ghost"
              disabled={readOnly || busy != null}
              onClick={() => void answer("dismiss")}
            >
              {t("mine")}
            </Button>
          </>
        ) : null}
      </div>
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
        <div className="mb-2">
          <p className="text-xs text-muted-foreground">
            {t("work", { count: work.length })}
          </p>
          <ul className="mt-1 list-inside list-disc text-sm">
            {work.map((w) => (
              <li key={w.id} className="break-words">
                {w.title ?? `#${w.id}`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {messages.length > 0 ? (
        <div className="mb-2">
          <p className="text-xs text-muted-foreground">
            {t("messages", { count: messages.length })}
          </p>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {messages.map((m) => (
              <li key={m.id} className="break-words">
                {t("messageTo", { name: botName(m.to), text: m.excerpt })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {handled.length > 0 ? (
        <div>
          <p className="text-xs text-muted-foreground">{t("notStopped")}</p>
          <ul className="mt-1 flex flex-col gap-1.5 text-sm">
            {handled.map((h) => (
              <li
                key={h.id}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <span className="min-w-0 break-words">
                  {t("onIt", { name: botName(h.to), text: h.excerpt })}
                </span>
                {also.has(h.id) ? (
                  <span className="text-xs text-muted-foreground">
                    {t("alsoStopped")}
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
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
        </div>
      ) : null}
    </CardFrame>
  )
}

/** The settings page an item is on. */
function pageOf(key: string): SettingsPage {
  if (key === "own.brain") return "identity"
  if (key.startsWith("own.")) return "advanced"
  if (key.startsWith("team.division.")) return "division"
  if (key.startsWith("team.usage.")) return "executors"
  if (key.startsWith("bot.")) return "workers"
  if (key.startsWith("assistant.")) return "executors"
  const item = key.replace(/^prefs\./, "") as PersonalAgentPrefKey
  if (ABOUT_ITEMS.includes(item)) return "about"
  if (PROACTIVE_ITEMS.includes(item)) return "proactive"
  return COMMUNICATION_ITEMS.includes(item) ? "communication" : "automation"
}

type Change = ChangedItem

function changesOf(v: unknown): Change[] {
  return Array.isArray(v)
    ? v.filter(
        (c): c is Change =>
          c != null &&
          typeof c === "object" &&
          typeof (c as Change).key === "string"
      )
    : []
}

/** Display names of the uids a card's keys and values hold:
 *  `bot:<uid>`, `assistant:<uid>` (the card's `names`). */
type Names = Record<string, string>

function namesOf(v: unknown): Names {
  if (!v || typeof v !== "object") return {}
  const out: Names = {}
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n === "string") out[k] = n
  }
  return out
}

/** `bot.<uid>.<field>` / `assistant.<uid>.<field>`: whose, and which item. */
export function teamKey(
  key: string
): { kind: "bot" | "assistant"; uid: string; field: string } | null {
  const m = /^(bot|assistant)\.(.+)\.([a-z_]+)$/.exec(key)
  return m
    ? { kind: m[1] as "bot" | "assistant", uid: m[2], field: m[3] }
    : null
}

/** "Codex · GPT-5.5 · High": an agent and its picks, as saved. */
function selectionText(v: unknown): string | null {
  if (!v || typeof v !== "object") return null
  const snap = (v as { label_snapshot?: AssistantLabelSnapshot }).label_snapshot
  if (!snap) return null
  return [snap.agent, snap.mode, ...snap.options.map((o) => o.value_label)]
    .filter(Boolean)
    .join(" · ")
}

/** A long text, cut to a line for a change's row. */
function clip(text: string, max = 80): string {
  const one = text.replace(/\s+/g, " ").trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** An item's name and its values, as the settings view words them;
 *  `names` names the work assistants and executor configs by uid. */
function useChangeText(names: Names = {}) {
  const ts = useTranslations("PersonalAgent.settings")
  const tp = useTranslations("PersonalAgent.settings.prefs")
  const tk = useTranslations("PersonalAgent.settings.division")
  const tt = useTranslations("PersonalAgent.notice.changed.team")
  const tf = useTranslations("PersonalAgent.bots.face")
  const assistants = useAssistants()
  const ownLabel: Record<string, string> = {
    auto_compact_percent: ts("autoCompact"),
    compact_command: ts("compactCommand"),
    handoff_budget_chars: ts("handoffBudget"),
    dispatch_concurrency: ts("concurrency"),
    skill_enabled: ts("skill"),
    brain: ts("brain"),
  }
  const byUid = (uid: string) =>
    names[`assistant:${uid}`] ??
    assistants.find((a) => a.uid === uid)?.name ??
    uid
  const pickName = (pick: string) => {
    if (names[pick]) return names[pick]
    const [kind, uid] = pick.split(":")
    return kind === "assistant" ? byUid(uid ?? "") : (uid ?? pick)
  }
  const label = (key: string): string => {
    if (key.startsWith("prefs.")) {
      return tp(`${key.slice(6)}.title` as "reply_length.title")
    }
    if (key.startsWith("own.")) return ownLabel[key.slice(4)] ?? key
    if (key.startsWith("team.division.")) {
      return tk(key.slice(14) as "code")
    }
    if (key.startsWith("team.usage.")) {
      return ts("changed.usageOf", { name: byUid(key.slice(11)) })
    }
    const team = teamKey(key)
    if (team) {
      const name =
        team.kind === "bot"
          ? (names[`bot:${team.uid}`] ?? team.uid)
          : byUid(team.uid)
      const field =
        team.kind === "bot"
          ? tt(`botField.${team.field}` as "botField.name")
          : tt(`assistantField.${team.field}` as "assistantField.name")
      return tt("of", { name, field })
    }
    return key
  }
  const value = (key: string, v: unknown): string => {
    const team = teamKey(key)
    // "Codex · GPT-5.5 · High": the agent and the picks, as saved.
    if (
      key === "own.brain" ||
      team?.field === "brain" ||
      (team?.kind === "assistant" && team.field === "agent")
    ) {
      const text = selectionText(v)
      if (text) return text
    }
    if (team?.field === "executor" && typeof v === "string") {
      return byUid(v)
    }
    if (team?.field === "avatar" && v && typeof v === "object") {
      const face = v as { kind?: string; shape?: string; color?: string }
      if (face.kind === "face" && face.shape && face.color) {
        return [
          tf(`shapes.${face.shape}` as "shapes.blob"),
          tf(`colors.${face.color}` as "colors.black"),
        ].join(" · ")
      }
      return tt("avatarOther")
    }
    if (
      team &&
      (team.field === "instructions" || team.field === "description") &&
      typeof v === "string"
    ) {
      return v.trim() ? clip(v) : tt("empty")
    }
    // A zone is its own name; only `system` has words.
    if (key === "prefs.time_zone" && typeof v === "string") {
      return v === "system" ? tp("time_zone.system") : v
    }
    // A time of day is its own words.
    if (key.startsWith("prefs.") && isClockItem(key.slice(6))) {
      return typeof v === "string" ? v : String(v ?? "")
    }
    if (key.startsWith("prefs.") && typeof v === "string") {
      return tp(choiceKey(key.slice(6), v) as "reply_length.short")
    }
    if (key.startsWith("team.division.")) {
      if (typeof v !== "string") return ts("team.auto")
      return pickName(v)
    }
    if (key.startsWith("team.usage.")) {
      return v == null ? ts("changed.usageDefault") : ts("changed.usageSet")
    }
    if (typeof v === "boolean") return v ? ts("changed.on") : ts("changed.off")
    if (v == null) return ts("changed.default")
    return String(v)
  }
  return { label, value }
}

/** A work assistant's role by its name in the owner's language (the
 *  templates are read only when a card shows one). */
function TemplateName({ id }: { id: string }) {
  const templates = useBotTemplates()
  return <>{templates?.find((x) => x.id === id)?.name ?? id}</>
}

/** One value of a change, as its item words it. */
function ChangeValue({
  item,
  value,
  text,
}: {
  item: string
  value: unknown
  text: (key: string, v: unknown) => string
}) {
  if (teamKey(item)?.field === "template" && typeof value === "string") {
    return <TemplateName id={value} />
  }
  return <>{text(item, value)}</>
}

/** The options codeg picked for the owner on a brain or an agent, and who
 *  picked each: the owner's words, another executor config, the agent. */
function PickedList({ picked }: { picked: PickedOption[] }) {
  const t = useTranslations("PersonalAgent.bots.choice")
  if (picked.length === 0) return null
  return (
    <ul
      className="mt-0.5 space-y-0.5 ps-3 text-xs text-muted-foreground"
      data-pa-picked
    >
      {picked.map((p) => (
        <li key={p.id} className="break-words" data-pa-picked-from={p.from}>
          <span className="text-foreground/80">{p.name}</span>
          {": "}
          {p.value_label}
          <span className="ms-1 rounded bg-muted px-1 text-[0.6875rem]">
            {t(`from.${p.from}` as "from.given")}
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
  const botName = useBotName()
  const row = item.row
  const data = row.data
  const { label, value } = useChangeText(namesOf(data?.names))
  const state = str(data, "state") ?? "open"
  const why = str(data, "why") ?? "asked"
  const changes = changesOf(data?.changes)
  // An executor config is also who a session's @ reaches (10.5).
  const bothWays = changes.some((c) => c.key.startsWith("assistant."))
  const quote = str(data, "quote")
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
  return (
    <CardFrame
      item={item}
      icon={SlidersHorizontal}
      heading={heading}
      text={text}
      failed={
        failed ?? (state === "open" || state === "applied" ? error : null)
      }
    >
      <ul className="space-y-1" data-pa-changes>
        {changes.map((c) => (
          <li
            key={c.key}
            className="text-sm break-words"
            data-pa-change={c.key}
          >
            <span className="text-muted-foreground">{label(c.key)}</span>{" "}
            <span className="line-through decoration-muted-foreground/60">
              <ChangeValue item={c.key} value={c.from} text={value} />
            </span>
            {" → "}
            <span className="font-medium">
              <ChangeValue item={c.key} value={c.to} text={value} />
            </span>
            <PickedList picked={pickedOf(c.picked)} />
          </li>
        ))}
      </ul>
      {bothWays ? (
        <p className="mt-2 text-xs text-muted-foreground" data-pa-both-ways>
          {t("bothWays")}
        </p>
      ) : null}
      {forRow != null ? (
        <QuoteBar targetId={forRow} tone="light" className="mt-2" />
      ) : quote ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("quote", { quote })}
        </p>
      ) : null}
      {reason ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("reason", { reason })}
        </p>
      ) : null}
      {kept.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("kept", { items: kept.map(label).join("、") })}
        </p>
      ) : null}
      {why !== "line" ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
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
              variant="outline"
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
              onClick={() => openSettings(pageOf(changes[0].key))}
            >
              {t("seeSettings")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </CardFrame>
  )
}

interface MadeBot {
  bot_id: number
  name: string
  face: BotFace | null
  template_name: string | null
  executor_name: string | null
  executor_agent: string | null
  executor_created: boolean
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

/** Work assistants made from the conversation (4.12) or on the way up from
 *  the executor configs (4.15), each with [Undo] — or one to make, waiting
 *  on the owner: [Make it] [Not now]. */
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
  const reason = str(data, "reason")
  const error = str(data, "error")
  const { busy, failed, answer } = useAnswer(Number(row.ref_id))
  const live = bots.filter((b) => b.state !== "undone")
  // A team suggested when getting to know the owner (5.4): ticked to make.
  const team = Array.isArray(pending?.team)
    ? (pending.team as Array<Record<string, unknown>>).filter(
        (m) => typeof m.template === "string"
      )
    : null
  const teamProjects = Array.isArray(pending?.projects)
    ? (pending.projects as unknown[]).filter(
        (p): p is string => typeof p === "string"
      )
    : []
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set())
  const ticked = (team ?? [])
    .map((m) => m.template as string)
    .filter((k) => !unticked.has(k))
  const heading =
    state === "open"
      ? why === "suggest"
        ? team
          ? t("teamSuggested")
          : t("suggested")
        : t("show")
      : state === "dismissed"
        ? t("dismissed")
        : state === "undone"
          ? t("undone")
          : why === "made"
            ? t("made", { count: bots.length })
            : t("applied")
  const text =
    bots.map((b) => b.name).join(", ") ||
    str(pending, "name") ||
    (team ?? []).map((m) => String(m.name ?? "")).join(", ")
  return (
    <CardFrame
      item={item}
      icon={UserPlus}
      heading={heading}
      text={text}
      failed={
        failed ?? (state === "open" || state === "applied" ? error : null)
      }
    >
      {why === "made" ? (
        <p className="mb-2 text-xs text-muted-foreground">{t("madeHint")}</p>
      ) : null}
      {team &&
      (state === "open" || (state === "dismissed" && bots.length === 0)) ? (
        <>
          {teamProjects.length > 0 ? (
            <p className="mb-2 text-xs text-muted-foreground">
              {t("teamFor", { projects: teamProjects.join(", ") })}
            </p>
          ) : null}
          <ul className="space-y-1.5" data-pa-team>
            {team.map((m) => {
              const key = m.template as string
              const id = `pa-team-${row.id}-${key}`
              return (
                <li
                  key={key}
                  className="flex items-center gap-2"
                  data-pa-team-member={key}
                >
                  <Checkbox
                    id={id}
                    checked={!unticked.has(key)}
                    disabled={state !== "open" || readOnly || busy != null}
                    onCheckedChange={(on) =>
                      setUnticked((u) => {
                        const next = new Set(u)
                        if (on === true) next.delete(key)
                        else next.add(key)
                        return next
                      })
                    }
                  />
                  <label
                    htmlFor={id}
                    className="min-w-0 flex-1 cursor-pointer text-sm font-medium"
                  >
                    {String(m.name ?? key)}
                  </label>
                </li>
              )
            })}
          </ul>
        </>
      ) : state === "open" || (state === "dismissed" && bots.length === 0) ? (
        <p className="text-sm font-medium break-words" data-pa-bot-pending>
          {str(pending, "name")}
        </p>
      ) : (
        <ul className="space-y-1.5" data-pa-bots-made>
          {bots.map((b) => {
            const filled = b.picked.filter((p) => p.from !== "given").length
            return (
              <li
                key={b.bot_id}
                data-pa-bot-made={b.bot_id}
                data-state={b.state}
                className="flex items-center gap-2"
              >
                <BotAvatar
                  avatar={b.face?.avatar ?? null}
                  name={b.name}
                  size={24}
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block truncate text-sm font-medium",
                      b.state === "undone" &&
                        "text-muted-foreground line-through"
                    )}
                  >
                    {b.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[
                      b.template_name,
                      b.executor_name
                        ? b.executor_created
                          ? filled > 0
                            ? t("executorFilled", {
                                agent: b.executor_agent ?? "",
                                count: filled,
                              })
                            : t("executorMade", {
                                agent: b.executor_agent ?? "",
                              })
                          : t("executorBound", { name: b.executor_name })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                {b.state !== "undone" ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setViewBot(b.bot_id)}
                    >
                      {t("open")}
                    </Button>
                    {bots.length > 1 && state === "applied" ? (
                      <Button
                        size="xs"
                        variant="outline"
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
                  <span className="text-xs text-muted-foreground">
                    {t("undoneOne")}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {quote ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("quote", { quote })}
        </p>
      ) : null}
      {reason ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("reason", { reason })}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {state === "open" ? (
          <>
            <Button
              size="sm"
              disabled={
                readOnly ||
                busy != null ||
                (team != null && ticked.length === 0)
              }
              onClick={() =>
                void answer(team ? `accept:${ticked.join(",")}` : "accept")
              }
              data-pa-bots-accept
            >
              {busy === "accept" || busy?.startsWith("accept:") ? (
                <SyncedSpinner small className="size-3.5" />
              ) : null}
              {team ? t("teamMake", { count: ticked.length }) : t("accept")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={readOnly || busy != null}
              onClick={() => void answer("dismiss")}
            >
              {t("dismiss")}
            </Button>
            {why === "suggest" && !team ? (
              <MuteKindButton
                noticeId={Number(row.ref_id)}
                disabled={busy != null}
              />
            ) : null}
          </>
        ) : state === "applied" && live.length > 0 ? (
          <Button
            size="sm"
            variant="outline"
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
      </div>
    </CardFrame>
  )
}

function madeOf(v: unknown): MadeExecutorData | null {
  const m = obj(v)
  const a = obj(m?.assistant)
  return m && a && typeof a.id === "number"
    ? (m as unknown as MadeExecutorData)
    : null
}

/** An agent's name from its wire slug. */
function agentName(v: unknown): string | null {
  return typeof v === "string"
    ? (AGENT_LABELS[v as keyof typeof AGENT_LABELS] ?? v)
    : null
}

/** A call's options as the editor reads them: `{mode_id, config_values}`,
 *  or a flat `{option id: value}` with `mode` among them. */
function optionsOf(
  v: unknown
): { mode_id?: string | null; config_values: Record<string, string> } | null {
  const o = obj(v)
  if (!o) return null
  const flat = obj(o.config_values) ?? o
  const config_values: Record<string, string> = {}
  for (const [k, x] of Object.entries(flat)) {
    if (k === "mode_id" || (flat === o && k === "mode")) continue
    if (typeof x === "string") config_values[k] = x
    else if (typeof x === "boolean" || typeof x === "number") {
      config_values[k] = String(x)
    }
  }
  const mode = str(o, "mode_id") ?? (flat === o ? str(o, "mode") : null)
  return { mode_id: mode, config_values }
}

/** An executor config made from the conversation (10.5) — with [Undo]
 *  (deleting it, its place in the division back) and [Edit]; one to make,
 *  waiting on the owner: [Make it] [Not now]; or nothing made because the
 *  agent's options could not be read: [Open editor], filled in with what
 *  was asked. */
function AssistantChangedCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.notice.changed.assistant")
  const tc = useTranslations("PersonalAgent.notice.changed")
  const tk = useTranslations("PersonalAgent.settings.division")
  const { readOnly } = usePageScope()
  const openExecutorEditor = usePersonalAgentUi((s) => s.openExecutorEditor)
  const row = item.row
  const data = row.data
  const state = str(data, "state") ?? "open"
  const why = str(data, "why") ?? "asked"
  const made = madeOf(data?.made)
  const pending = obj(data?.pending)
  const quote = str(data, "quote")
  const reason = str(data, "reason")
  const error = str(data, "error")
  const kept = Array.isArray(data?.kept) ? (data.kept as string[]) : []
  const { busy, failed, answer } = useAnswer(Number(row.ref_id))
  const name =
    made?.assistant.name ??
    str(pending, "name") ??
    str(pending, "template") ??
    ""
  const agent = made?.assistant.agent ?? agentName(pending?.agent_type) ?? null
  const picked = made ? pickedOf(made.picked) : []
  const firstFor = (made ? changesOf(made.team) : [])
    .map((c) => c.key)
    .filter((k) => k.startsWith("team.division."))
    .map((k) => tk(k.slice(14) as "code"))
  const heading =
    state === "editor"
      ? t("editor")
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
  const openEditor = () => {
    const prefill = pending ?? {}
    openExecutorEditor(null, {
      name: str(prefill, "name") ?? undefined,
      description: str(prefill, "description") ?? undefined,
      instructions: str(prefill, "instructions") ?? undefined,
      template: str(prefill, "template") ?? undefined,
      agentType: (str(prefill, "agent_type") as AgentType | null) ?? null,
      options: optionsOf(prefill.options) ?? undefined,
    })
  }
  return (
    <CardFrame
      item={item}
      icon={Layers}
      heading={heading}
      text={[name, agent].filter(Boolean).join(" · ")}
      failed={
        failed ?? (state === "open" || state === "applied" ? error : null)
      }
    >
      <p
        className={cn(
          "text-sm font-medium break-words",
          state === "undone" && "text-muted-foreground line-through"
        )}
        data-pa-assistant-made={made?.assistant.id ?? ""}
      >
        {name}
        {agent ? (
          <span className="ms-1.5 text-xs font-normal text-muted-foreground">
            {t("on", { agent })}
          </span>
        ) : null}
      </p>
      {state === "editor" ? (
        <p className="mt-1.5 text-xs break-words text-muted-foreground">
          {t("editorHint", { agent: agent ?? "", why: reason ?? "" })}
        </p>
      ) : null}
      {picked.length > 0 ? <PickedList picked={picked} /> : null}
      {firstFor.length > 0 ? (
        <p className="mt-1.5 text-xs text-muted-foreground" data-pa-first-for>
          {t("firstFor", { kinds: firstFor.join(" / ") })}
        </p>
      ) : null}
      {made && state === "applied" ? (
        <p className="mt-1.5 text-xs text-muted-foreground" data-pa-both-ways>
          {tc("bothWays")}
        </p>
      ) : null}
      {quote ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {tc("quote", { quote })}
        </p>
      ) : null}
      {reason && state !== "editor" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {tc("reason", { reason })}
        </p>
      ) : null}
      {kept.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("kept", { count: kept.length })}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {state === "open" ? (
          <>
            <Button
              size="sm"
              disabled={readOnly || busy != null}
              onClick={() => void answer("accept")}
              data-pa-assistant-act="accept"
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
              data-pa-assistant-act="dismiss"
            >
              {tc("dismiss")}
            </Button>
            {why === "suggest" ? (
              <MuteKindButton
                noticeId={Number(row.ref_id)}
                disabled={busy != null}
              />
            ) : null}
          </>
        ) : null}
        {state === "editor" ? (
          <Button
            size="sm"
            disabled={readOnly}
            onClick={openEditor}
            data-pa-assistant-act="editor"
          >
            {t("openEditor")}
          </Button>
        ) : null}
        {state === "applied" && made ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={readOnly || busy != null}
              onClick={() => void answer("undo")}
              data-pa-assistant-act="undo"
            >
              {busy === "undo" ? (
                <SyncedSpinner small className="size-3.5" />
              ) : null}
              {tc("undo")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => openExecutorEditor(made.assistant.id)}
              data-pa-assistant-act="edit"
            >
              {t("edit")}
            </Button>
          </>
        ) : null}
      </div>
    </CardFrame>
  )
}
