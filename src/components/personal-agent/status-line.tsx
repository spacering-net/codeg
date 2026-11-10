"use client"

/**
 * The line over the input box (10.7): the assistant's small face and what it
 * is doing now, in one short line with a moving shimmer (8.4).
 *
 * - While its brain runs a turn: the step it is on. The vague ones (thinking,
 *   a call of no known kind) show after 1.5 s, so a passing one does not
 *   flash by; the line holds what it said before meanwhile. The specific
 *   ones show at once.
 * - Its brain at rest, work it handed out running: that work's step, the
 *   work's title in front; clicking opens the work.
 * - Clicking it during a turn opens this turn's steps, one short line each
 *   ("Edited parser.rs +14 −10"), read again as the turn moves.
 * - Nothing running: the line folds away. A state gone stale (no push for
 *   its 30 s) is nothing running.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown } from "lucide-react"

import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentTurnSteps } from "@/lib/api"
import type { StepLine } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  useBotLive,
  usePersonalAgentRoster,
} from "@/stores/personal-agent-roster-store"

import {
  activityText,
  doingText,
  stepText,
  useActivityTranslate,
  VAGUE_KINDS,
} from "./activity-text"
import { BotAvatar } from "./bot-avatar"
import { StopButton } from "./message-actions"
import { viewOf } from "./roster-order"
import { useOpenWork, workTargetOf } from "./shared"

/** A vague step shows after this. */
export const VAGUE_DELAY_MS = 1500
/** The steps are read again at most this often while open. */
const STEPS_GAP_MS = 1000

function useTick(on: boolean, ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const id = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(id)
  }, [on, ms])
  return now
}

export function StatusLine({
  botId,
  name,
}: {
  /** The assistant the page shows. */
  botId: number | null
  name: string
}) {
  const t = useTranslations("PersonalAgent.statusLine")
  const tt = useActivityTranslate()
  const { snapshot, dispatchById } = usePersonalAgent()
  const openWork = useOpenWork()
  const live = useBotLive(botId)
  const turnRunning = snapshot?.status.turn != null
  const now = useTick(turnRunning || live?.work === "busy", 1000)
  const view = viewOf(live, now)
  const activity = live && !view.stale ? live.activity : null
  const workActivity =
    !turnRunning && view.busy && activity?.work ? activity : null
  // A state gone stale is nothing running here either, whatever an old
  // snapshot says (principle 14).
  const shown = (turnRunning && !view.stale) || workActivity != null

  // What to say now: a vague step only once it has lasted; meanwhile the
  // last specific one of this turn stays.
  const step = activity?.step ?? null
  const key = step ? `${activity?.turn ?? "w"}:${step.n}:${step.kind}` : "none"
  const vague = step == null || VAGUE_KINDS.has(step.kind)
  const [settled, setSettled] = useState<string | null>(null)
  useEffect(() => {
    if (!shown || !vague) return
    const timer = window.setTimeout(() => setSettled(key), VAGUE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [key, vague, shown])
  const held = usePersonalAgentRoster((s) =>
    botId != null ? s.lastSpecific[botId] : undefined
  )
  const heldOfThisTurn =
    held &&
    held.turn === activity?.turn &&
    held.work?.dispatch_id === activity?.work?.dispatch_id
      ? held
      : null
  let text: string | null = null
  if (shown) {
    if (activity && !vague) {
      text = activityText(tt, activity, now)
    } else if (settled === key) {
      text = activity
        ? activityText(tt, activity, now)
        : doingText(
            tt,
            { n: 0, kind: "think", started_at: new Date(now).toISOString() },
            { turn: snapshot?.status.turn?.batch_id }
          )
    } else if (heldOfThisTurn) {
      text = activityText(tt, heldOfThisTurn, now)
    }
  }

  // The turn's steps, while open — for the turn it was opened in.
  const turnId = snapshot?.status.turn?.batch_id ?? null
  const [openTurn, setOpenTurn] = useState<number | null>(null)
  const open = turnId != null && openTurn === turnId
  const [steps, setSteps] = useState<{
    turn: number
    list: StepLine[]
  } | null>(null)
  const readAt = useRef(0)
  const stamp = live?.updated_at ?? null
  useEffect(() => {
    if (!open || turnId == null) return
    const wait = Math.max(0, readAt.current + STEPS_GAP_MS - Date.now())
    let live = true
    const timer = window.setTimeout(() => {
      readAt.current = Date.now()
      personalAgentTurnSteps(botId)
        .then((list) => {
          if (live) setSteps({ turn: turnId, list })
        })
        .catch(() => {})
    }, wait)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [open, turnId, botId, stamp])
  const shownSteps = steps && steps.turn === turnId ? steps.list : null

  if (!shown) return null
  const click = () => {
    if (workActivity?.work) {
      const info = dispatchById.get(workActivity.work.dispatch_id)
      openWork(
        workTargetOf(info, null) ?? {
          ...workTargetOf(undefined, null),
          dispatchId: workActivity.work.dispatch_id,
        }
      )
      return
    }
    setOpenTurn(open ? null : turnId)
  }
  return (
    <div
      data-pa-status-line
      className="mx-auto w-full chat-content-w shrink-0 px-4 pb-1"
    >
      {open ? (
        <div
          data-pa-status-steps
          className="mb-1 max-h-48 overflow-y-auto rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs"
        >
          <div className="mb-1 font-medium text-muted-foreground">
            {t("steps")}
          </div>
          {shownSteps == null ? (
            <p className="text-muted-foreground">{t("loading")}</p>
          ) : shownSteps.length === 0 ? (
            <p className="text-muted-foreground">{t("empty")}</p>
          ) : (
            <ol className="flex flex-col gap-0.5">
              {shownSteps.map((s) => (
                <li
                  key={s.n}
                  data-pa-status-step={s.kind}
                  className={cn(
                    "truncate",
                    s.status === "failed"
                      ? "text-destructive"
                      : s.status === "completed"
                        ? "text-muted-foreground"
                        : "text-foreground"
                  )}
                >
                  {stepText(tt, s, now)}
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
      <div className="flex max-w-full items-center gap-1">
        <button
          type="button"
          onClick={click}
          aria-expanded={workActivity ? undefined : open}
          title={workActivity ? t("openWork") : open ? t("fold") : t("steps")}
          className="flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-start text-xs text-muted-foreground transition-colors hover:bg-muted"
        >
          {live ? (
            <BotAvatar
              avatar={snapshot?.agent?.avatar ?? null}
              name={name}
              size={16}
              look={view.look}
              dot={null}
            />
          ) : null}
          <span
            data-pa-status-text
            aria-live="polite"
            className={cn("min-w-0 truncate", text ? "activity-shimmer" : "")}
          >
            {text ?? " "}
          </span>
          {workActivity ? null : (
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3 shrink-0 transition-transform",
                open && "rotate-180"
              )}
            />
          )}
        </button>
        {/* The turn can be stopped from here before its reply has a bubble. */}
        {turnRunning && snapshot?.status.engine === "here" ? (
          <StopButton />
        ) : null}
      </div>
    </div>
  )
}
