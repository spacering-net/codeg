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
  Lightbulb,
  UserPlus,
  Loader2,
  OctagonX,
  Repeat,
  SlidersHorizontal,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { useBotId, usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentNoticeAct } from "@/lib/api"
import type {
  AgentType,
  AssistantLabelSnapshot,
  BotFace,
  PersonalAgentPrefKey,
  TimelineRow,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAssistants } from "@/stores/assistants-store"
import {
  usePersonalAgentUi,
  type SettingsPage,
} from "@/stores/personal-agent-ui-store"

import { BotAvatar } from "./bot-avatar"
import { ChoiceCard } from "./choice-card"
import { CollapsedText } from "./event-card"
import { ExchangeSheet } from "./exchange-sheet"
import type { MessageItem } from "./message-items"
import { bubbleCorners, MessageRow } from "./message-row"
import { QuoteBar } from "./quote-bar"
import { COMMUNICATION_ITEMS } from "./settings/pref-pages"
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
    return str(item.row.data, "what") === "bots" ? (
      <BotsChangedCard item={item} />
    ) : (
      <ChangedCard item={item} />
    )
  }
  if (kind === "choice") return <ChoiceCard item={item} />
  return null
}

type Choice =
  | "accept"
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
  const isMessage = action === "message"
  const tc = (k: "open" | "acted" | "dismissed" | "accept" | "dismiss") =>
    t(`confirm.${k}` as "confirm.open")

  const heading = confirm
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
  const Icon = uncertain ? CircleHelp : Lightbulb
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
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
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
                action === "followup"
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
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : null}
              {uncertain
                ? t("uncertain.again")
                : state === "unknown"
                  ? t("again")
                  : confirm
                    ? tc("accept")
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
                  : t("dismiss")}
            </Button>
          </div>
        ) : null}
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
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
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
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
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
  const item = key.replace(/^prefs\./, "")
  return COMMUNICATION_ITEMS.includes(item as PersonalAgentPrefKey)
    ? "communication"
    : "automation"
}

interface Change {
  key: string
  from: unknown
  to: unknown
}

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

/** An item's name and its values, as the settings view words them. */
function useChangeText() {
  const ts = useTranslations("PersonalAgent.settings")
  const tp = useTranslations("PersonalAgent.settings.prefs")
  const tk = useTranslations("PersonalAgent.settings.division")
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
    assistants.find((a) => a.uid === uid)?.name ?? uid
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
    return key
  }
  const value = (key: string, v: unknown): string => {
    if (key === "own.brain" && v && typeof v === "object") {
      // "Codex · GPT-5.5 · High": the agent and the picks, as saved.
      const snap = (v as { label_snapshot?: AssistantLabelSnapshot })
        .label_snapshot
      if (snap) {
        return [
          snap.agent,
          snap.mode,
          ...snap.options.map((o) => o.value_label),
        ]
          .filter(Boolean)
          .join(" · ")
      }
    }
    if (key.startsWith("prefs.") && typeof v === "string") {
      return tp(`${key.slice(6)}.${v}` as "reply_length.short")
    }
    if (key.startsWith("team.division.")) {
      if (typeof v !== "string") return ts("team.auto")
      const [kind, uid] = v.split(":")
      return kind === "assistant" ? byUid(uid ?? "") : (uid ?? v)
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
  const { label, value } = useChangeText()
  const row = item.row
  const data = row.data
  const state = str(data, "state") ?? "open"
  const why = str(data, "why") ?? "asked"
  const changes = changesOf(data?.changes)
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
          <li key={c.key} className="text-sm break-words">
            <span className="text-muted-foreground">{label(c.key)}</span>{" "}
            <span className="line-through decoration-muted-foreground/60">
              {value(c.key, c.from)}
            </span>
            {" → "}
            <span className="font-medium">{value(c.key, c.to)}</span>
          </li>
        ))}
      </ul>
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
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
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
            </>
          ) : state === "applied" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={readOnly || busy != null}
              onClick={() => void answer("undo")}
            >
              {busy === "undo" ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
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
  const heading =
    state === "open"
      ? why === "suggest"
        ? t("suggested")
        : t("show")
      : state === "dismissed"
        ? t("dismissed")
        : state === "undone"
          ? t("undone")
          : why === "made"
            ? t("made", { count: bots.length })
            : t("applied")
  const text = bots.map((b) => b.name).join(", ") || str(pending, "name") || ""
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
      {state === "open" || (state === "dismissed" && bots.length === 0) ? (
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
                          <Loader2
                            className="size-3 animate-spin"
                            aria-hidden
                          />
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
              disabled={readOnly || busy != null}
              onClick={() => void answer("accept")}
            >
              {busy === "accept" ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
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
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : null}
            {bots.length > 1 ? t("undoAll") : t("undo")}
          </Button>
        ) : null}
      </div>
    </CardFrame>
  )
}
