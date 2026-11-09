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
 * Acting is two-phase on the server: the card reads "running" until what it
 * runs settles — done, back to open with the reason, or "not sure it ran",
 * which can be run again.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CircleHelp, Lightbulb, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useBotId, usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentNoticeAct } from "@/lib/api"
import type { AgentType } from "@/lib/types"
import { cn } from "@/lib/utils"

import { CollapsedText } from "./event-card"
import type { MessageItem } from "./message-items"
import { bubbleCorners, MessageRow } from "./message-row"
import {
  AGENT_SURFACE,
  asMode,
  canOpenWork,
  num,
  str,
  useOpenWork,
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
  return null
}

/** Answer a card; the error to show when the answer did not go through. */
function useAnswer(noticeId: number) {
  const botId = useBotId()
  const [busy, setBusy] = useState<"accept" | "dismiss" | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const answer = async (choice: "accept" | "dismiss") => {
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
