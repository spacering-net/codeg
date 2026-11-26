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
 * - One round pill, the turn's stop button at its end (while the turn runs
 *   here); no chevron.
 * - Started with nothing to say yet (the owner's message just sent, a vague
 *   first step not lasted yet): three dots rising in turn.
 * - The face in it moves with what it is doing (`bot-avatar`): pondering
 *   while it thinks, bobbing while it works.
 * - Nothing running: the line folds away. A state gone stale (no push for
 *   its 30 s) is nothing running. A turn just ended stays a moment first
 *   (`END_LINGER_MS`), its face showing how it went — a turn round and two
 *   hops, "Replied" ("Work done" for work handed out); a shake, "Didn't
 *   finish" — not for a turn the owner stopped. How it went pushed late
 *   (within `LATE_END_MS` of the fold) brings it back for its moment.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"

import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentTurnSteps } from "@/lib/api"
import type { BotLook, StepLine } from "@/lib/types"
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
/** How long the pill stays once its turn has ended: the face's `done`
 *  motion (a 0.8 s turn, then two 0.64 s hops) and a little after. */
export const END_LINGER_MS = 2600
/** How it went may come this long after the pill folded and still bring
 *  it back for a moment. */
const LATE_END_MS = 10_000
/** The looks that say how it went is still on its way. */
const BUSY_LOOKS: ReadonlySet<BotLook> = new Set<BotLook>([
  "thinking",
  "working",
])
/** The looks the pill stays for once its turn has ended. */
const LINGER_LOOKS: ReadonlySet<BotLook> = new Set<BotLook>([
  "done",
  "failed",
  "thinking",
  "working",
])

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
  const shownAs: "turn" | "work" | null =
    turnRunning && !view.stale ? "turn" : workActivity ? "work" : null
  const shown = shownAs != null

  // Just ended: the pill stays a moment, so its face's motion for how it
  // went (`done`: a turn round and two hops; `failed`: a shake) is seen
  // here too — while the face still says it is busy, the push saying how
  // it went is on its way. Stopped by the owner (no such face), it folds
  // at once. How it went coming late (a while after the pill folded)
  // brings it back for its own moment.
  const [wasShown, setWasShown] = useState(shown)
  // What it showed last: a turn, or work handed out.
  const [lastShownAs, setLastShownAs] = useState(shownAs)
  if (shownAs && shownAs !== lastShownAs) setLastShownAs(shownAs)
  // What the pill showed before it folded, while how it went is still on
  // its way (its face still busy) — for `LATE_END_MS` after at most.
  const [endedFor, setEndedFor] = useState<"turn" | "work" | null>(null)
  // Each stay its own: a new one starts its time over.
  const [stay, setStay] = useState(0)
  const [ending, setEnding] = useState(false)
  const flash = live?.flash
  const flashKey =
    flash && (flash.face === "done" || flash.face === "failed")
      ? `${flash.face}@${flash.until}`
      : null
  const [seenFlash, setSeenFlash] = useState(flashKey)
  if (wasShown !== shown) {
    setWasShown(shown)
    setEnding(!shown)
    setEndedFor(shown ? null : lastShownAs)
    if (!shown) setStay((n) => n + 1)
  }
  if (seenFlash !== flashKey) {
    setSeenFlash(flashKey)
    if (flashKey && !shown && endedFor) {
      setEnding(true)
      setStay((n) => n + 1)
      setEndedFor(null)
    }
  } else if (endedFor && !shown && !BUSY_LOOKS.has(view.look)) {
    // How it went is known — or there is none to come (a stop the owner
    // asked for, which folds it at once): no later face is this one's.
    setEndedFor(null)
    if (!LINGER_LOOKS.has(view.look)) setEnding(false)
  }
  useEffect(() => {
    if (stay === 0) return
    const fold = window.setTimeout(() => setEnding(false), END_LINGER_MS)
    const forget = window.setTimeout(() => setEndedFor(null), LATE_END_MS)
    return () => {
      window.clearTimeout(fold)
      window.clearTimeout(forget)
    }
  }, [stay])
  const lingering = ending && !shown && LINGER_LOOKS.has(view.look)

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

  if (!shown && !lingering) return null
  if (lingering) {
    text =
      view.look === "done"
        ? lastShownAs === "work"
          ? t("workDone")
          : t("replied")
        : view.look === "failed"
          ? t("notFinished")
          : null
  }
  const click = () => {
    if (lingering) return
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
      <div
        data-pa-status-pill
        data-pa-status-ended={lingering ? view.look : undefined}
        className="inline-flex max-w-full items-center gap-0.5 rounded-full px-1 py-0.5 transition-colors hover:bg-muted"
      >
        <button
          type="button"
          onClick={click}
          aria-expanded={workActivity || lingering ? undefined : open}
          title={
            lingering
              ? undefined
              : workActivity
                ? t("openWork")
                : open
                  ? t("fold")
                  : t("steps")
          }
          className="flex min-w-0 max-w-full items-center gap-1.5 rounded-full px-0.5 text-start text-xs text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
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
          {/* Kept in place while empty, so what it says next is read out. */}
          <span
            data-pa-status-text
            aria-live="polite"
            className={cn(
              "min-w-0 truncate",
              text ? (lingering ? null : "activity-shimmer") : "sr-only"
            )}
          >
            {text ?? ""}
          </span>
          {text == null && !lingering ? (
            <span
              data-pa-status-dots
              aria-hidden
              className="motion-typing flex h-4 items-center gap-[3px] px-0.5"
            >
              <span />
              <span />
              <span />
            </span>
          ) : null}
        </button>
        {/* The turn can be stopped from here, in the pill, before its reply
            has a bubble. */}
        {turnRunning && snapshot?.status.engine === "here" ? (
          <StopButton hollow />
        ) : null}
      </div>
    </div>
  )
}
