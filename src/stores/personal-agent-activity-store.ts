"use client"

/**
 * The activity (C1) for the page: one read of the page's assistant's list —
 * four groups, what waits on the owner, the pill's count and first row —
 * that the activity tab, the tab's badge and the conversation's pill all
 * draw from, so the pill's row is always in the list. Read whole on the
 * first holder, and again whenever something it lists may have moved:
 * - an assistant's change that can touch it (a card, an ask, handed-out
 *   work, a matter, a routine, its settings) — not the text of a reply
 *   streaming in;
 * - an assistant's live state, when what waits on the owner or the work it
 *   has on hand changed — not each step of its activity;
 * - a board task (queued to merge, taken off the queue: the work's own
 *   state does not move then);
 * - the page's matters, work or routines read again (`refreshActivity`);
 * - the transport coming back, or another one taking over;
 * - another assistant shown;
 * - and every few seconds while the window is shown: the sessions waiting
 *   anywhere in codeg push nothing here.
 *
 * One read at a time. The first ask goes out after a short gap, so a burst
 * is one read; asks while a read is on its way make one more read after it.
 * A later ask never pushes a waiting read back, so a busy stretch still
 * reads once a gap. A read that fails keeps what was read before — never an
 * empty list in its place. One subscription for every holder, dropped with
 * the last; each is a fresh set of callbacks, so one dropped late never
 * touches the next.
 */

import { useEffect, useRef } from "react"
import { create } from "zustand"

import { personalAgentActivity } from "@/lib/api"
import { stamp } from "@/lib/stamp"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import { onActiveTransportChange } from "@/lib/transport"
import {
  PERSONAL_AGENT_CHANGED_EVENT,
  type BotLive,
  type BotsChange,
  type PersonalAgentActivity,
  type PersonalAgentChange,
  type TimelineKind,
} from "@/lib/types"

import { PERSONAL_AGENT_BOTS_EVENT } from "./personal-agent-roster-store"

/** Asks within this are one read. */
export const ACTIVITY_GAP_MS = 400
/** How often it is read while the window is shown. */
export const ACTIVITY_POLL_MS = 10_000
const WORK_TASK_CHANGED_EVENT = "task://changed"

/** The rows of a timeline change that can be in the activity: cards, asks,
 *  handed-out work and its results. */
const ACTIVITY_ROWS: ReadonlySet<TimelineKind> = new Set([
  "question",
  "permission",
  "dispatch",
  "result",
  "notice",
])

/** What was read, and the assistant it is of (`null`: the primary). */
export interface ActivityRead {
  bot: number | null
  /** `null`: its first read failed — nothing to show, nothing to wait on. */
  view: PersonalAgentActivity | null
  /** When the read `view` came from was asked for (`stamp`). */
  at: number
  /** When the latest read that failed was asked for, if it failed after
   *  `view`'s: what waits on a fresh read does not wait forever. */
  failedAt?: number
}

interface ActivityStore {
  /** What was read, by assistant (`botKey`): each kept apart, so a late
   *  answer for one shown before never takes the place of this one's. */
  reads: Record<string, ActivityRead>
  setRead: (read: ActivityRead) => void
  clear: () => void
}

/** An assistant's place in `reads`. */
export function botKey(bot: number | null): string {
  return bot == null ? "primary" : String(bot)
}

export const usePersonalAgentActivity = create<ActivityStore>((set) => ({
  reads: {},
  setRead: (read) =>
    set((s) => ({ reads: { ...s.reads, [botKey(read.bot)]: read } })),
  clear: () => set({ reads: {} }),
}))

/** What of an assistant's live state the activity lists. */
function liveMark(live: BotLive): string {
  const n = live.needs
  return [
    live.attention,
    n ? `${n.kind}:${n.row_id ?? ""}:${n.count}` : "",
    live.work_on_hand.map((w) => `${w.dispatch_id}:${w.state}`).join(","),
  ].join("|")
}

interface Session {
  request: () => void
  /** Read for `bot` from now on: at once, when it is another one. */
  show: (bot: number | null) => void
  stop: () => void
}

let holders = 0
let session: Session | null = null
/** The assistant the page shows: whose activity is read. */
let shown: number | null = null

/** Read the activity again soon (nothing while no one holds it). */
export function refreshActivity(): void {
  session?.request()
}

function start(): Session {
  let live = true
  let timer: ReturnType<typeof setTimeout> | null = null
  let reading = false
  let again = false
  const marks = new Map<number, string>()
  const offs: Array<() => void> = []

  const read = () => {
    if (timer != null) clearTimeout(timer)
    timer = null
    if (!live) return
    reading = true
    const bot = shown
    const at = stamp()
    // A call that throws as it is made fails as one that answers so.
    Promise.resolve()
      .then(() => personalAgentActivity(bot))
      .then((view) => {
        if (live) usePersonalAgentActivity.getState().setRead({ bot, view, at })
      })
      .catch(() => {
        // Kept as it was; one never read for this assistant says it failed,
        // so what waits on it (a routine asked for) does not wait forever.
        if (!live) return
        const store = usePersonalAgentActivity.getState()
        const before = store.reads[botKey(bot)]
        store.setRead(
          before?.view != null
            ? { ...before, failedAt: at }
            : { bot, view: null, at, failedAt: at }
        )
      })
      .finally(() => {
        reading = false
        if (live && (again || bot !== shown)) {
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
    if (timer == null) timer = setTimeout(read, ACTIVITY_GAP_MS)
  }
  const show = (bot: number | null) => {
    if (bot === shown) return
    shown = bot
    if (!live) return
    if (reading) again = true
    else read()
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
        !change.rows.some((r) => ACTIVITY_ROWS.has(r.kind))
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
  }, ACTIVITY_POLL_MS)
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
    show,
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
    usePersonalAgentActivity.getState().clear()
    session = start()
  })
}

function end() {
  offTransport?.()
  offTransport = null
  session?.stop()
  session = null
}

/** The activity of `bot` (`null`: the primary), kept up to date while
 *  anything holds it — this caller only while `active`. `versions` are the
 *  page's own reads of its matters, work and routines: one moved, it is
 *  read again. `null` until read, and when its first read failed (see
 *  `useActivityRead`). */
export function useActivity(
  bot: number | null,
  versions: readonly number[] = [],
  active = true
): PersonalAgentActivity | null {
  const read = useActivityRead(bot, versions, active)
  return read?.view ?? null
}

/** What was read for `bot`, the way `useActivity` holds it: `null` while
 *  none is; its `view` `null` when its first read failed. */
export function useActivityRead(
  bot: number | null,
  versions: readonly number[] = [],
  active = true
): ActivityRead | null {
  useEffect(() => {
    if (!active) return
    holders += 1
    // The first holder starts reading its assistant's; a later one shows
    // its own below, read at once when it is another.
    if (holders === 1) {
      shown = bot
      begin()
    }
    return () => {
      holders -= 1
      if (holders === 0) end()
    }
    // Held once per caller; the assistant shown follows below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  useEffect(() => {
    if (active) session?.show(bot)
  }, [active, bot])
  const mark = versions.join(",")
  const seen = useRef(mark)
  useEffect(() => {
    // Not as it mounts: the first read is under way.
    if (seen.current === mark) return
    seen.current = mark
    if (active) refreshActivity()
  }, [active, mark])
  const read = usePersonalAgentActivity((s) => s.reads[botKey(bot)])
  return active && read != null ? read : null
}

/** Tests: forget every holder and what was read. */
export function __resetActivityForTests(): void {
  end()
  holders = 0
  shown = null
  usePersonalAgentActivity.setState({ reads: {} })
}
