"use client"

/**
 * "Today" (6.3, 1.14) for the window: what waits on the owner anywhere in
 * codeg, what the assistants keep an eye on, the rest of the day and what
 * was done today — read whole on the first holder, and again whenever
 * something it lists may have moved:
 * - an assistant's change that can touch it (a card, an ask, handed-out
 *   work, a matter, its settings) — not the text of a reply streaming in;
 * - an assistant's live state, when what waits on the owner or the work it
 *   has on hand changed — not each step of its activity;
 * - a board task;
 * - the transport coming back, or another one taking over;
 * - and every few seconds while the window is shown: the sessions waiting
 *   anywhere in codeg push nothing here.
 *
 * One read at a time. The first ask goes out after a short gap, so a burst
 * is one read; asks while a read is on its way make one more read after it.
 * A later ask never pushes a waiting read back, so a busy stretch still
 * reads once a gap. One subscription for every holder, dropped with the
 * last; each is a fresh set of callbacks, so one dropped late never touches
 * the next.
 */

import { useEffect } from "react"
import { create } from "zustand"

import { personalAgentToday } from "@/lib/api"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import { onActiveTransportChange } from "@/lib/transport"
import {
  PERSONAL_AGENT_CHANGED_EVENT,
  type BotLive,
  type BotsChange,
  type PersonalAgentChange,
  type PersonalAgentToday,
  type TimelineKind,
} from "@/lib/types"

import { PERSONAL_AGENT_BOTS_EVENT } from "./personal-agent-roster-store"

/** Asks within this are one read. */
export const TODAY_GAP_MS = 400
/** How often it is read while the window is shown. */
export const TODAY_POLL_MS = 10_000
const WORK_TASK_CHANGED_EVENT = "task://changed"

/** The rows of a timeline change that can be in "Today": cards, asks,
 *  handed-out work and its results. */
const TODAY_ROWS: ReadonlySet<TimelineKind> = new Set([
  "question",
  "permission",
  "dispatch",
  "result",
  "notice",
])

interface TodayStore {
  /** `null` until first read. */
  today: PersonalAgentToday | null
  setToday: (today: PersonalAgentToday | null) => void
}

export const usePersonalAgentToday = create<TodayStore>((set) => ({
  today: null,
  setToday: (today) => set({ today }),
}))

/** What of an assistant's live state "Today" lists. */
function liveMark(live: BotLive): string {
  const n = live.needs
  return [
    live.attention,
    n ? `${n.kind}:${n.row_id ?? ""}:${n.count}` : "",
    live.work_on_hand.map((w) => `${w.dispatch_id}:${w.state}`).join(","),
  ].join("|")
}

let holders = 0
let session: { request: () => void; stop: () => void } | null = null

/** Read "Today" again soon (nothing while no one holds it). */
export function refreshToday(): void {
  session?.request()
}

function start(): { request: () => void; stop: () => void } {
  let live = true
  let timer: ReturnType<typeof setTimeout> | null = null
  let reading = false
  let again = false
  const marks = new Map<number, string>()
  const offs: Array<() => void> = []

  const read = () => {
    timer = null
    if (!live) return
    reading = true
    personalAgentToday()
      .then((today) => {
        if (live) usePersonalAgentToday.getState().setToday(today)
      })
      .catch(() => {})
      .finally(() => {
        reading = false
        if (live && again) {
          again = false
          request()
        }
      })
  }
  const request = () => {
    if (!live) return
    if (reading) {
      again = true
      return
    }
    if (timer == null) timer = setTimeout(read, TODAY_GAP_MS)
  }
  const hold = (p: Promise<() => void>) => {
    void p
      .then((off) => {
        if (live) offs.push(off)
        else off()
      })
      .catch(() => {})
  }

  hold(
    subscribe<PersonalAgentChange>(PERSONAL_AGENT_CHANGED_EVENT, (change) => {
      if (!live || change.kind === "reply") return
      if (
        change.kind === "timeline" &&
        !change.rows.some((r) => TODAY_ROWS.has(r.kind))
      ) {
        return
      }
      request()
    })
  )
  hold(
    subscribe<BotsChange>(PERSONAL_AGENT_BOTS_EVENT, (change) => {
      if (!live) return
      if (change.kind === "live") {
        const mark = liveMark(change.live)
        if (marks.get(change.bot_id) === mark) return
        marks.set(change.bot_id, mark)
      }
      request()
    })
  )
  hold(subscribe(WORK_TASK_CHANGED_EVENT, () => request()))
  try {
    const off = onTransportReconnect(() => request())
    if (off) offs.push(off)
  } catch {
    // No transport to follow (a test, a page without one).
  }
  const poll = setInterval(() => {
    if (typeof document === "undefined" || !document.hidden) request()
  }, TODAY_POLL_MS)
  offs.push(() => clearInterval(poll))
  const onShown = () => {
    if (!document.hidden) request()
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onShown)
    offs.push(() => document.removeEventListener("visibilitychange", onShown))
  }
  // The first read at once.
  read()

  return {
    request,
    stop: () => {
      live = false
      if (timer != null) clearTimeout(timer)
      timer = null
      for (const off of offs.splice(0)) off()
    },
  }
}

/** Another transport took over: what was read is another backend's. */
let offTransport: (() => void) | null = null

function begin() {
  session = start()
  offTransport = onActiveTransportChange(() => {
    session?.stop()
    usePersonalAgentToday.getState().setToday(null)
    session = start()
  })
}

function end() {
  offTransport?.()
  offTransport = null
  session?.stop()
  session = null
}

/** "Today", kept up to date while anything holds it — this caller only
 *  while `active` (the page holds it on the primary). */
export function useToday(active = true): PersonalAgentToday | null {
  useEffect(() => {
    if (!active) return
    holders += 1
    if (holders === 1) begin()
    return () => {
      holders -= 1
      if (holders === 0) end()
    }
  }, [active])
  const today = usePersonalAgentToday((s) => s.today)
  return active ? today : null
}

/** Tests: forget every holder and what was read. */
export function __resetTodayForTests(): void {
  end()
  holders = 0
  usePersonalAgentToday.setState({ today: null })
}
