"use client"

/**
 * The roster (4.14) and every assistant's live state (8.3), held once for
 * the window: the roster, the page's status line, the shortcuts and the
 * settings' lists all read it.
 *
 * Read whole on the first holder and again whenever the roster changes (an
 * assistant made, deleted, renamed, pinned, hidden…: `personal-agent://bots`
 * `roster`, or `personal-agent://changed` `agent`) or the transport comes
 * back; each assistant's state is then replaced as it is pushed
 * (`personal-agent://bots` `live`). States are kept by freshness: a read
 * that was on its way while a newer push came does not undo it, and a push
 * that came before the first read is kept for it. In a process that does
 * not run the assistants nothing is pushed: the roster is read again every
 * few seconds there. One subscription for every holder, dropped with the
 * last; each subscription is a fresh set of callbacks, so one dropped late
 * never touches the next.
 */

import { useEffect } from "react"
import { create } from "zustand"

import { personalAgentBots } from "@/lib/api"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import {
  PERSONAL_AGENT_CHANGED_EVENT,
  type BotActivity,
  type BotLive,
  type BotsChange,
  type PersonalAgentChange,
  type RosterEntry,
} from "@/lib/types"

export const PERSONAL_AGENT_BOTS_EVENT = "personal-agent://bots"

/** Roster reads asked for within this are one read. */
const RELOAD_GAP_MS = 120
/** How often the roster is read where nothing is pushed. */
export const ELSEWHERE_POLL_MS = 5000

interface RosterStore {
  /** `null` until first read. */
  entries: RosterEntry[] | null
  /** Each assistant's last activity that said something specific: what the
   *  status line holds while a vague one waits to show (8.4). */
  lastSpecific: Record<number, BotActivity>
  /** The freshest state seen of each assistant, read or pushed. */
  freshest: Record<number, BotLive>
  setEntries: (entries: RosterEntry[]) => void
  /** One assistant's newer state. */
  applyLive: (live: BotLive) => void
}

/** The kinds too vague to show at once (as `VAGUE_KINDS`). */
const VAGUE = new Set(["think", "other"])

function specific(live: BotLive | null | undefined): BotActivity | null {
  const a = live?.activity
  return a && !VAGUE.has(a.step.kind) ? a : null
}

/** Whether `a` is newer than `b`. */
function newer(a: BotLive | null | undefined, b: BotLive | null | undefined) {
  if (!a) return false
  if (!b) return true
  return Date.parse(a.updated_at) > Date.parse(b.updated_at)
}

export const usePersonalAgentRoster = create<RosterStore>((set) => ({
  entries: null,
  lastSpecific: {},
  freshest: {},
  setEntries: (read) =>
    set((s) => {
      const lastSpecific = { ...s.lastSpecific }
      const freshest = { ...s.freshest }
      const entries = read.map((e) => {
        // A push newer than what this read saw stays.
        const held = freshest[e.id]
        const live = newer(held, e.live) ? held : e.live
        if (live) freshest[e.id] = live
        const a = specific(live)
        if (a) lastSpecific[e.id] = a
        return live === e.live ? e : { ...e, live }
      })
      return { entries, lastSpecific, freshest }
    }),
  applyLive: (live) =>
    set((s) => {
      // An older push arriving late does not undo a newer one.
      if (!newer(live, s.freshest[live.bot_id])) return s
      const freshest = { ...s.freshest, [live.bot_id]: live }
      const a = specific(live)
      const lastSpecific = a
        ? { ...s.lastSpecific, [live.bot_id]: a }
        : s.lastSpecific
      const i = s.entries?.findIndex((e) => e.id === live.bot_id) ?? -1
      if (!s.entries || i < 0) return { freshest, lastSpecific }
      const entries = s.entries.slice()
      entries[i] = { ...entries[i], live }
      return { entries, freshest, lastSpecific }
    }),
}))

let holders = 0
let stop: (() => void) | null = null

/** Read the roster now (coalesced with any read asked for just before). */
let reloadTimer: ReturnType<typeof setTimeout> | null = null
let readSeq = 0
export function reloadRoster(): void {
  if (reloadTimer) return
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    const seq = ++readSeq
    personalAgentBots()
      .then((entries) => {
        if (seq === readSeq)
          usePersonalAgentRoster.getState().setEntries(entries)
      })
      .catch(() => {})
  }, RELOAD_GAP_MS)
}

function start(): () => void {
  let live = true
  const offs: Array<() => void> = []
  const hold = (p: Promise<() => void>) => {
    void p.then((off) => {
      if (live) offs.push(off)
      else off()
    })
  }
  hold(
    subscribe<BotsChange>(PERSONAL_AGENT_BOTS_EVENT, (change) => {
      if (!live) return
      if (change.kind === "live") {
        usePersonalAgentRoster.getState().applyLive(change.live)
      } else {
        reloadRoster()
      }
    })
  )
  hold(
    subscribe<PersonalAgentChange>(PERSONAL_AGENT_CHANGED_EVENT, (change) => {
      if (live && change.kind === "agent") reloadRoster()
    })
  )
  try {
    const off = onTransportReconnect(() => {
      if (live) reloadRoster()
    })
    if (off) offs.push(off)
  } catch {
    // No transport to follow (a test, a page without one).
  }
  // Another process runs the assistants: nothing is pushed here, so the
  // states (and who is on the roster) are read again now and then.
  const poll = setInterval(() => {
    const held = usePersonalAgentRoster.getState().entries
    if (live && held?.some((e) => e.live && !e.live.activity_known)) {
      reloadRoster()
    }
  }, ELSEWHERE_POLL_MS)
  offs.push(() => clearInterval(poll))
  // The first read at once.
  const seq = ++readSeq
  personalAgentBots()
    .then((entries) => {
      if (live && seq === readSeq) {
        usePersonalAgentRoster.getState().setEntries(entries)
      }
    })
    .catch(() => {})
  return () => {
    live = false
    for (const off of offs.splice(0)) off()
  }
}

/** The roster, kept up to date while anything holds it. */
export function useRoster(): RosterEntry[] | null {
  useEffect(() => {
    holders += 1
    if (holders === 1) stop = start()
    return () => {
      holders -= 1
      if (holders === 0) {
        stop?.()
        stop = null
      }
    }
  }, [])
  return usePersonalAgentRoster((s) => s.entries)
}

/** One assistant's live state, while the roster is held. */
export function useBotLive(botId: number | null | undefined): BotLive | null {
  useRoster()
  return usePersonalAgentRoster(
    (s) => s.entries?.find((e) => e.id === botId)?.live ?? null
  )
}

/** Tests: forget what was read. */
export function __resetRosterForTests(): void {
  usePersonalAgentRoster.setState({
    entries: null,
    lastSpecific: {},
    freshest: {},
  })
  readSeq += 1
  if (reloadTimer) {
    clearTimeout(reloadTimer)
    reloadTimer = null
  }
}
