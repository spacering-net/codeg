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
import { CircleHelp, Lightbulb, Loader2, OctagonX, Repeat } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useBotId, usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentNoticeAct } from "@/lib/api"
import type { AgentType, BotFace, TimelineRow } from "@/lib/types"
import { cn } from "@/lib/utils"

import { CollapsedText } from "./event-card"
import { ExchangeSheet } from "./exchange-sheet"
import type { MessageItem } from "./message-items"
import { bubbleCorners, MessageRow } from "./message-row"
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
  return null
}

type Choice = "accept" | "dismiss" | `stop:${number}`

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

  const heading = uncertain
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
                  : t("accept")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={readOnly || busy != null}
              onClick={() => void answer("dismiss")}
            >
              {uncertain ? t("uncertain.dismiss") : t("dismiss")}
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
