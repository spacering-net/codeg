"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import {
  personalAgentDispatches,
  personalAgentGet,
  personalAgentTimeline,
  personalAgentTimelineRows,
  personalAgentTimelineUpdatedSince,
} from "@/lib/api"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import {
  PERSONAL_AGENT_CHANGED_EVENT,
  type DispatchInfo,
  type PersonalAgentChange,
  type PersonalAgentSnapshot,
  type ReplyStep,
  type TimelineCursor,
  type TimelineRow,
} from "@/lib/types"

/** Rows the page loads first, and per "load older". */
const PAGE_SIZE = 60
/** How often a read-only page (the agent runs in another process) re-reads:
 *  that process's broadcasts never reach this one. */
const ELSEWHERE_POLL_MS = 5_000
/** Continuations one read of changed rows may take before the next poll. */
const MAX_CHANGE_PAGES = 20
/** Dispatch states that still move, re-read by a read-only page's poll. */
const LIVE_DISPATCH_STATES = new Set([
  "queued",
  "running",
  "waiting_input",
  "review",
])

interface PersonalAgentContextValue {
  /** The assistant this store holds: `null` is the primary. Every call a
   *  page makes about it passes this on. */
  botId: number | null
  snapshot: PersonalAgentSnapshot | null
  /** Timeline rows held, oldest first. */
  rows: TimelineRow[]
  hasOlder: boolean
  loading: boolean
  loadOlder: () => Promise<void>
  /** Load every row from `id` up to the oldest one held (a jump to an older
   *  message); `too_far` when that is more than one read returns. */
  loadSince: (id: number) => Promise<"loaded" | "too_far">
  refresh: () => Promise<void>
  /** Bumped on every dispatch / item change, for the panels that list them. */
  dispatchVersion: number
  itemVersion: number
  /** The agent waits on the owner (a question or permission request). */
  needsOwner: boolean
  /** The step each reply in flight is on, as last pushed, by reply row id. */
  liveReplies: ReadonlyMap<number, ReplyStep | null>
  /** The dispatches the cards on the page point at, by id. */
  dispatchById: ReadonlyMap<number, DispatchInfo>
  /** Rows quoted from outside what is held, by id; `null` when it does not
   *  exist. */
  quoted: ReadonlyMap<number, TimelineRow | null>
  /** Ask for rows a quote names that are not held. */
  requestQuoted: (ids: number[]) => void
}

const PersonalAgentContext = createContext<PersonalAgentContextValue | null>(
  null
)

/** The assistant the enclosing store holds (`null`: the primary), for the
 *  calls a component makes about it. */
export function useBotId(): number | null {
  return usePersonalAgent().botId
}

export function usePersonalAgent() {
  const ctx = useContext(PersonalAgentContext)
  if (!ctx) {
    throw new Error(
      "usePersonalAgent must be used within PersonalAgentProvider"
    )
  }
  return ctx
}

/**
 * A server timestamp in a form that sorts as text: the fraction padded to
 * nine digits and the zone dropped (they are all UTC). The wire's fraction
 * has as many digits as it needs, so `…:00Z` and `…:00.5Z` would sort the
 * wrong way round as written.
 */
export function stampKey(stamp: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?/.exec(
    stamp
  )
  if (!m) return stamp
  return `${m[1]}T${m[2]}.${(m[3] ?? "").padEnd(9, "0").slice(0, 9)}`
}

/** Merge rows into the held set by id, keeping id order. */
export function mergeRows(
  held: readonly TimelineRow[],
  incoming: readonly TimelineRow[]
): TimelineRow[] {
  if (incoming.length === 0) return held as TimelineRow[]
  const byId = new Map<number, TimelineRow>()
  for (const r of held) byId.set(r.id, r)
  let changed = false
  for (const r of incoming) {
    const prev = byId.get(r.id)
    // A late broadcast must not roll a row back to an older state.
    if (!prev || stampKey(prev.updated_at) <= stampKey(r.updated_at)) {
      if (prev !== r) changed = true
      byId.set(r.id, r)
    }
  }
  if (!changed) return held as TimelineRow[]
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

/** The newest `updated_at` among `rows`, as the server wrote it. */
export function newestStamp(rows: readonly TimelineRow[]): string | null {
  let best: string | null = null
  for (const r of rows) {
    if (best == null || stampKey(r.updated_at) > stampKey(best)) {
      best = r.updated_at
    }
  }
  return best
}

/**
 * Whether a row can move the count of what the owner has not seen (in the
 * snapshot): a result card, or a reply once it is no longer running — it
 * settled, or the owner saw it. A running reply's progress cannot.
 */
export function movesUnseen(row: TimelineRow): boolean {
  if (row.kind === "result") return true
  if (row.kind !== "reply") return false
  const state = row.data?.state
  return state !== "running" && state !== "discarded"
}

/**
 * Whether a broadcast is about the assistant a store holds: `botId` itself,
 * or — for the primary's store (`botId` null) — the primary's id once known,
 * and 0 (the primary before it is set up). `unknown` when the store does not
 * know the primary's id yet and the broadcast names another: it may be the
 * primary's, so the store reads itself again rather than take it.
 */
export function changeBelongs(
  change: { bot_id?: number },
  botId: number | null,
  primaryId: number | null
): "yes" | "no" | "unknown" {
  const of = change.bot_id
  if (of == null) return botId == null ? "yes" : "no"
  if (botId != null) return of === botId ? "yes" : "no"
  if (of === 0) return "yes"
  if (primaryId == null) return "unknown"
  return of === primaryId ? "yes" : "no"
}

/** The dispatches the rows' cards point at. */
function dispatchIdsOf(rows: readonly TimelineRow[]): number[] {
  const ids = new Set<number>()
  for (const r of rows) {
    if ((r.kind === "dispatch" || r.kind === "result") && r.dispatch_id) {
      ids.add(r.dispatch_id)
    }
  }
  return [...ids]
}

/**
 * Data layer of the personal agent: its snapshot and timeline, kept mounted
 * for the whole workspace so the sidebar can show when the agent waits on the
 * owner, and so the page — remounted on every visit, like any route — paints
 * at once. Broadcasts carry timeline rows whole, and the step the reply in
 * flight is on; everything else is a nudge to refetch. A page that cannot
 * hear the engine (it runs in another process) polls instead: the newest page,
 * then every row changed since the last poll wherever it sits.
 */
export function PersonalAgentProvider({
  children,
  botId = null,
}: {
  children: ReactNode
  /** The assistant to hold (`null`: the primary). Mount one store per
   *  assistant — keyed by it, so another assistant starts afresh. */
  botId?: number | null
}) {
  const [snapshot, setSnapshot] = useState<PersonalAgentSnapshot | null>(null)
  /** The primary's id, once its snapshot says (for the primary's store). */
  const primaryId = useRef<number | null>(null)
  useEffect(() => {
    if (botId == null && snapshot?.agent) primaryId.current = snapshot.agent.id
  }, [botId, snapshot])
  const [rows, setRows] = useState<TimelineRow[]>([])
  const [hasOlder, setHasOlder] = useState(false)
  const [loading, setLoading] = useState(true)
  const [dispatchVersion, setDispatchVersion] = useState(0)
  const [itemVersion, setItemVersion] = useState(0)
  const [liveReplies, setLiveReplies] = useState<
    ReadonlyMap<number, ReplyStep | null>
  >(() => new Map())
  const [dispatchById, setDispatchById] = useState<
    ReadonlyMap<number, DispatchInfo>
  >(() => new Map())
  const [quoted, setQuoted] = useState<ReadonlyMap<number, TimelineRow | null>>(
    () => new Map()
  )
  const snapReq = useRef(0)
  const rowsRef = useRef<TimelineRow[]>([])
  useEffect(() => {
    rowsRef.current = rows
  }, [rows])
  /** A read-only page's reconciliation mark: every change before it to a
   *  row held has been read. Advanced only by a read of changed rows that
   *  went through to the end — never by the newest page, which says nothing
   *  about the older rows held. */
  const changedSince = useRef<string | null>(null)
  /** Where an unfinished read of changed rows goes on from next poll. */
  const changedCursor = useRef<TimelineCursor | null>(null)

  const merge = useCallback((incoming: readonly TimelineRow[]) => {
    if (incoming.length === 0) return
    setRows((held) => mergeRows(held, incoming))
  }, [])

  const refreshSnapshot = useCallback(async () => {
    const id = ++snapReq.current
    try {
      const snap = await personalAgentGet(botId)
      if (id !== snapReq.current) return
      setSnapshot(snap)
      const live = snap.status.live_reply
      if (live) {
        // A push may be newer than the snapshot: it wins.
        setLiveReplies((held) =>
          held.has(live.row_id)
            ? held
            : new Map(held).set(live.row_id, live.current)
        )
      }
    } catch {
      // keep the last good one; the next nudge recovers
    }
  }, [botId])

  /** The newest page, merged over what is held (older pages stay). */
  const refreshTimeline = useCallback(async () => {
    try {
      const page = await personalAgentTimeline(null, PAGE_SIZE, null, botId)
      if (rowsRef.current.length === 0) setHasOlder(page.has_older)
      // The first rows held are as of now: changes from here on are what
      // a read-only page reconciles.
      if (changedSince.current == null) {
        changedSince.current = newestStamp(page.rows)
      }
      merge(page.rows)
    } catch {
      // ignore — a later event recovers
    } finally {
      setLoading(false)
    }
  }, [merge, botId])

  const refresh = useCallback(async () => {
    await Promise.all([refreshSnapshot(), refreshTimeline()])
  }, [refreshSnapshot, refreshTimeline])

  const loadOlder = useCallback(async () => {
    const oldest = rowsRef.current[0]?.id
    if (oldest == null) return
    const page = await personalAgentTimeline(oldest, PAGE_SIZE, null, botId)
    merge(page.rows)
    setHasOlder(page.has_older)
  }, [merge, botId])

  const loadSince = useCallback(
    async (id: number): Promise<"loaded" | "too_far"> => {
      const oldest = rowsRef.current[0]?.id ?? null
      if (oldest != null && id >= oldest) return "loaded"
      const page = await personalAgentTimeline(oldest, undefined, id, botId)
      if (page.too_far) return "too_far"
      merge(page.rows)
      setHasOlder(page.has_older)
      return "loaded"
    },
    [merge, botId]
  )

  // ── dispatches the cards point at ───────────────────────────────────────
  const fetchingDispatches = useRef(new Set<number>())
  /** Asked for again while a read of them was out: that read may predate
   *  the change, so they are read once more when it lands. */
  const staleDispatches = useRef(new Set<number>())
  const fetchDispatches = useCallback(
    async function fetch(ids: number[]) {
      const want: number[] = []
      for (const id of ids) {
        if (fetchingDispatches.current.has(id)) staleDispatches.current.add(id)
        else want.push(id)
      }
      if (want.length === 0) return
      for (const id of want) fetchingDispatches.current.add(id)
      try {
        const list = await personalAgentDispatches(null, null, want, botId)
        setDispatchById((held) => {
          const next = new Map(held)
          for (const d of list) next.set(d.id, d)
          return next
        })
      } catch {
        // the row's own data draws the card meanwhile
      } finally {
        for (const id of want) fetchingDispatches.current.delete(id)
        const again = want.filter((id) => staleDispatches.current.delete(id))
        if (again.length > 0) void fetch(again)
      }
    },
    [botId]
  )
  const dispatchByIdRef = useRef(dispatchById)
  useEffect(() => {
    dispatchByIdRef.current = dispatchById
  }, [dispatchById])
  useEffect(() => {
    const missing = dispatchIdsOf(rows).filter(
      (id) => !dispatchByIdRef.current.has(id)
    )
    if (missing.length > 0) void fetchDispatches(missing)
  }, [rows, fetchDispatches])

  // ── quoted rows outside what is held ────────────────────────────────────
  const quotedRef = useRef(quoted)
  useEffect(() => {
    quotedRef.current = quoted
  }, [quoted])
  const pendingQuotes = useRef(new Set<number>())
  const quoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestQuoted = useCallback(
    (ids: number[]) => {
      const held = new Set(rowsRef.current.map((r) => r.id))
      for (const id of ids) {
        if (!held.has(id) && !quotedRef.current.has(id)) {
          pendingQuotes.current.add(id)
        }
      }
      if (pendingQuotes.current.size === 0 || quoteTimer.current) return
      // Coalesce: a page renders many quote bars in one pass.
      quoteTimer.current = setTimeout(() => {
        quoteTimer.current = null
        const want = [...pendingQuotes.current].slice(0, 100)
        for (const id of want) pendingQuotes.current.delete(id)
        personalAgentTimelineRows(want, botId)
          .then((found) => {
            setQuoted((held) => {
              const next = new Map(held)
              for (const id of want) next.set(id, null)
              for (const r of found) next.set(r.id, r)
              return next
            })
          })
          .catch(() => {})
      }, 30)
    },
    [botId]
  )

  // Coalesce status nudges: a turn sends several in a burst.
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nudgeStatus = useCallback(() => {
    if (statusTimer.current) return
    statusTimer.current = setTimeout(() => {
      statusTimer.current = null
      void refreshSnapshot()
    }, 150)
  }, [refreshSnapshot])

  useEffect(() => {
    void refresh()
    let unsub: (() => void) | undefined
    let cancelled = false
    void subscribe<PersonalAgentChange>(
      PERSONAL_AGENT_CHANGED_EVENT,
      (change) => {
        const belongs = changeBelongs(change, botId, primaryId.current)
        if (belongs === "no") return
        if (belongs === "unknown") {
          // Not sure it is ours — the primary's store before it has read
          // the primary's id, and a broadcast naming an assistant. What it
          // carried is not taken; everything of ours is read again instead,
          // so a row written meanwhile (a card, say) is not lost: this
          // store never polls once the engine runs here.
          void refresh()
          setDispatchVersion((v) => v + 1)
          setItemVersion((v) => v + 1)
          return
        }
        switch (change.kind) {
          case "timeline":
            merge(change.rows)
            // The unread count lives in the snapshot.
            if (change.rows.some(movesUnseen)) nudgeStatus()
            break
          case "reply":
            setLiveReplies((held) =>
              new Map(held).set(change.row_id, change.current)
            )
            break
          case "status":
          case "agent":
            nudgeStatus()
            break
          case "dispatch":
            setDispatchVersion((v) => v + 1)
            void fetchDispatches([change.id])
            break
          case "item":
            setItemVersion((v) => v + 1)
            break
        }
      }
    ).then((u: () => void) => {
      if (cancelled) u()
      else unsub = u
    })
    const offReconnect = onTransportReconnect(() => {
      void refresh()
      setDispatchVersion((v) => v + 1)
      setItemVersion((v) => v + 1)
      const ids = [...dispatchByIdRef.current.keys()]
      if (ids.length > 0) void fetchDispatches(ids)
    })
    return () => {
      cancelled = true
      unsub?.()
      offReconnect?.()
      if (statusTimer.current) clearTimeout(statusTimer.current)
      if (quoteTimer.current) clearTimeout(quoteTimer.current)
    }
  }, [refresh, nudgeStatus, merge, fetchDispatches, botId])

  // Read-only elsewhere: poll, since the running process's broadcasts stay
  // in that process. The newest page brings new rows; the changed rows bring
  // every later change to a row held, wherever it sits — read marks, a reply
  // settling, a card's state — not only those on the newest page.
  const elsewhere = snapshot?.status.engine === "elsewhere"
  useEffect(() => {
    if (!elsewhere) return
    let running = false
    const poll = async () => {
      if (running) return
      running = true
      try {
        const since = changedSince.current
        const cursor = changedCursor.current
        await refresh()
        const minId = rowsRef.current[0]?.id ?? null
        if (since != null) {
          // Inclusive of the mark: a row written later in the same instant
          // as the last one read is read again, not missed.
          let newest = since
          let page = cursor
            ? await personalAgentTimelineUpdatedSince(
                null,
                cursor,
                minId,
                botId
              )
            : await personalAgentTimelineUpdatedSince(since, null, minId, botId)
          const take = (rows: readonly TimelineRow[]) => {
            merge(rows)
            const n = newestStamp(rows)
            if (n && stampKey(n) > stampKey(newest)) newest = n
          }
          take(page.rows)
          for (let i = 0; page.next && i < MAX_CHANGE_PAGES; i++) {
            page = await personalAgentTimelineUpdatedSince(
              null,
              page.next,
              minId,
              botId
            )
            take(page.rows)
          }
          // Only a read that reached the end moves the mark; one cut short
          // goes on from where it stopped. A failure anywhere moves
          // neither, so the next poll reads the same stretch again.
          if (page.next) {
            changedCursor.current = page.next
          } else {
            changedCursor.current = null
            changedSince.current = newest
          }
        }
        const moving = [...dispatchByIdRef.current.values()]
          .filter((d) => LIVE_DISPATCH_STATES.has(d.state))
          .map((d) => d.id)
        if (moving.length > 0) void fetchDispatches(moving)
        setDispatchVersion((v) => v + 1)
        setItemVersion((v) => v + 1)
      } catch {
        // the next poll tries again
      } finally {
        running = false
      }
    }
    const timer = setInterval(() => void poll(), ELSEWHERE_POLL_MS)
    return () => clearInterval(timer)
  }, [elsewhere, refresh, merge, fetchDispatches, botId])

  const needsOwner =
    (snapshot?.status.pending_permission ?? false) ||
    (snapshot?.status.pending_question ?? false)

  const value = useMemo<PersonalAgentContextValue>(
    () => ({
      botId,
      snapshot,
      rows,
      hasOlder,
      loading,
      loadOlder,
      loadSince,
      refresh,
      dispatchVersion,
      itemVersion,
      needsOwner,
      liveReplies,
      dispatchById,
      quoted,
      requestQuoted,
    }),
    [
      botId,
      snapshot,
      rows,
      hasOlder,
      loading,
      loadOlder,
      loadSince,
      refresh,
      dispatchVersion,
      itemVersion,
      needsOwner,
      liveReplies,
      dispatchById,
      quoted,
      requestQuoted,
    ]
  )

  return (
    <PersonalAgentContext.Provider value={value}>
      {children}
    </PersonalAgentContext.Provider>
  )
}
