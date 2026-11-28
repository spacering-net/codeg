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
  type ReplyText,
  type TimelineCursor,
  type TimelineRow,
} from "@/lib/types"

/** A reply in flight, as the page last heard it. */
export interface LiveTurn {
  /** The step it is on. */
  current: ReplyStep | null
  /** Every text run so far, whole. */
  texts: readonly ReplyText[]
  /** The copy's version: a later copy has a greater one. */
  ver: number
}

/** The longest a recovery's reads hold back what is pushed meanwhile. */
const RECOVER_HOLD_MS = 5_000

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
  /** Bumped on every routine change (6.9). */
  routineVersion: number
  /** The agent waits on the owner (a question or permission request). */
  needsOwner: boolean
  /** Each reply in flight as last heard, by reply row id: the step it is
   *  on and every text run so far — the newest copy only (by `ver`), and
   *  none once the row settled. */
  liveReplies: ReadonlyMap<number, LiveTurn>
  /** The dispatches the cards on the page point at, by id. */
  dispatchById: ReadonlyMap<number, DispatchInfo>
  /** Read these dispatches again (a [Stop] that did not see its own write
   *  come back). */
  refetchDispatches: (ids: number[]) => Promise<void>
  /** Rows quoted from outside what is held, by id; `null` when it does not
   *  exist. */
  quoted: ReadonlyMap<number, TimelineRow | null>
  /** Ask for rows a quote names that are not held. */
  requestQuoted: (ids: number[]) => void
}

const PersonalAgentContext = createContext<PersonalAgentContextValue | null>(
  null
)

/** A switch to another assistant under way (`ViewedPersonalAgentProvider`):
 *  the one picked (`to`, `null` the primary) is still being read, and the
 *  store the page reads is the one it showed, drawn as it is but not to act
 *  on. Apart from the store, so marking it re-renders only what shows it,
 *  not everything that reads the store. */
export interface PersonalAgentSwitch {
  switching: boolean
  to: number | null
}

const NOT_SWITCHING: PersonalAgentSwitch = { switching: false, to: null }

const PersonalAgentSwitchContext =
  createContext<PersonalAgentSwitch>(NOT_SWITCHING)

/** Whether the page is switching to another assistant, and to which. */
export function usePersonalAgentSwitch(): PersonalAgentSwitch {
  return useContext(PersonalAgentSwitchContext)
}

/** Read an assistant ahead (its store kept live for a while), so switching
 *  to it is at once: the pointer resting on its row, or pressed on it. */
const PrefetchAssistantContext = createContext<(bot: number) => void>(() => {})

export function usePrefetchAssistant(): (bot: number) => void {
  return useContext(PrefetchAssistantContext)
}

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

/** The board's news of its tasks (`web/event_bridge.rs`). */
const WORK_TASK_CHANGED_EVENT = "task://changed"
/** The board tasks whose work's head can move with the board alone (A4):
 *  in review (queued, taken off the queue) or merging (landed, failed
 *  back). */
const BOARD_MOVES: ReadonlySet<string> = new Set(["review", "merging"])
/** Dispatches asked for in one read: well under what a read takes (500). */
const DISPATCH_READ = 200

/** The dispatches the rows' cards point at. */
function dispatchIdsOf(rows: readonly TimelineRow[]): number[] {
  const ids = new Set<number>()
  for (const r of rows) {
    if ((r.kind === "dispatch" || r.kind === "result") && r.dispatch_id) {
      ids.add(r.dispatch_id)
    } else if (
      // A check of a message (10.3): its card follows the check's work.
      r.kind === "notice" &&
      r.data?.notice === "check" &&
      typeof r.data.dispatch_id === "number"
    ) {
      ids.add(r.data.dispatch_id)
    } else if (
      // A round of acceptance (A4): its check's work, whose session its
      // work's head opens — its rows may be on another page.
      r.kind === "notice" &&
      r.data?.notice === "acceptance" &&
      typeof r.data.check_dispatch_id === "number"
    ) {
      ids.add(r.data.check_dispatch_id)
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
  const value = usePersonalAgentStore(botId)
  return (
    <PersonalAgentContext.Provider value={value}>
      {children}
    </PersonalAgentContext.Provider>
  )
}

/** One assistant's store: its snapshot and timeline, kept current. */
function usePersonalAgentStore(
  botId: number | null
): PersonalAgentContextValue {
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
  const [routineVersion, setRoutineVersion] = useState(0)
  const [liveReplies, setLiveReplies] = useState<ReadonlyMap<number, LiveTurn>>(
    () => new Map()
  )
  const [dispatchById, setDispatchById] = useState<
    ReadonlyMap<number, DispatchInfo>
  >(() => new Map())
  const [quoted, setQuoted] = useState<ReadonlyMap<number, TimelineRow | null>>(
    () => new Map()
  )
  const snapReq = useRef(0)
  /** The read whose snapshot is drawn: an older one never goes over it. */
  const snapShown = useRef(0)
  const rowsRef = useRef<TimelineRow[]>([])
  useEffect(() => {
    rowsRef.current = rows
  }, [rows])
  const publishLive = useCallback((rowId: number, turn: LiveTurn) => {
    setLiveReplies((held) => {
      const had = held.get(rowId)
      if (had && had.ver >= turn.ver) return held
      return new Map(held).set(rowId, turn)
    })
  }, [])
  /** Back from a lost connection, reading: the copies pushed meanwhile wait
   *  for what was read, and are drawn with it. */
  const recovering = useRef({
    /** The latest recovery; only it draws what was read. */
    gen: 0,
    active: false,
    held: new Map<number, LiveTurn>(),
    rows: [] as TimelineRow[],
  })
  /** A copy of reply `rowId` in flight: taken only when newer than the one
   *  held (a slow read never takes text back), and never once the row
   *  settled — the settled row draws it then, alone. */
  const takeLive = useCallback(
    (rowId: number, turn: LiveTurn) => {
      const row = rowsRef.current.find((r) => r.id === rowId)
      if (row && row.kind === "reply" && row.data?.state !== "running") return
      const r = recovering.current
      if (r.active) {
        const had = r.held.get(rowId)
        if (!had || had.ver < turn.ver) r.held.set(rowId, turn)
        return
      }
      publishLive(rowId, turn)
    },
    [publishLive]
  )
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

  /** Read the snapshot, tagged with the order it was asked for; `null`
   *  when it failed. */
  const readSnapshot = useCallback(async () => {
    const id = ++snapReq.current
    try {
      return { id, snap: await personalAgentGet(botId) }
    } catch {
      // keep the last good one; the next nudge recovers
      return { id, snap: null }
    }
  }, [botId])
  /** A snapshot read, drawn unless one read after it is drawn already — a
   *  later read that failed takes nothing from it. */
  const applySnapshot = useCallback(
    ({ id, snap }: { id: number; snap: PersonalAgentSnapshot | null }) => {
      if (!snap || id < snapShown.current) return
      snapShown.current = id
      setSnapshot(snap)
      const live = snap.status.live_reply
      if (live) {
        // A push may be newer than the snapshot: the newer copy stands.
        takeLive(live.row_id, {
          current: live.current,
          texts: live.texts ?? [],
          ver: live.ver ?? 0,
        })
      }
    },
    [takeLive]
  )
  const refreshSnapshot = useCallback(async () => {
    applySnapshot(await readSnapshot())
  }, [readSnapshot, applySnapshot])

  /** Read the newest page; `null` when it failed. */
  const readTimeline = useCallback(async () => {
    try {
      return await personalAgentTimeline(null, PAGE_SIZE, null, botId)
    } catch {
      // ignore — a later event recovers
      return null
    }
  }, [botId])
  /** The newest page, merged over what is held (older pages stay). */
  const applyTimeline = useCallback(
    (page: Awaited<ReturnType<typeof personalAgentTimeline>> | null) => {
      setLoading(false)
      if (!page) return
      if (rowsRef.current.length === 0) setHasOlder(page.has_older)
      // The first rows held are as of now: changes from here on are what
      // a read-only page reconciles.
      if (changedSince.current == null) {
        changedSince.current = newestStamp(page.rows)
      }
      merge(page.rows)
    },
    [merge]
  )

  const refreshTimeline = useCallback(async () => {
    applyTimeline(await readTimeline())
  }, [readTimeline, applyTimeline])

  const refresh = useCallback(async () => {
    await Promise.all([refreshSnapshot(), refreshTimeline()])
  }, [refreshSnapshot, refreshTimeline])

  // Back from a lost connection: both read, then both applied in one
  // update, with the copies of a reply pushed while they were read — what
  // a reply wrote meanwhile and the lines it wrote between are drawn
  // together, never a text drawn first and moved once its line comes.
  /** The status nudge (defined further down), for a recovery's rows. */
  const nudgeStatusRef = useRef<() => void>(() => {})
  // Rows broadcast meanwhile wait too (a reply's checkpoint holds its
  // text); the latest of two recoveries draws, the earlier's reads go. A
  // read that hangs holds nothing past `RECOVER_HOLD_MS`.
  const refreshTogether = useCallback(async () => {
    const r = recovering.current
    const gen = ++r.gen
    r.active = true
    /** What waited, drawn — with what was read, when it came in time. */
    const release = () => {
      r.active = false
      const rows = r.rows
      const held = [...r.held]
      r.rows = []
      r.held.clear()
      merge(rows)
      for (const [rowId, turn] of held) publishLive(rowId, turn)
      if (rows.some(movesUnseen)) nudgeStatusRef.current()
    }
    const timer = setTimeout(() => {
      if (gen === r.gen && r.active) release()
    }, RECOVER_HOLD_MS)
    const [snap, page] = await Promise.all([readSnapshot(), readTimeline()])
    clearTimeout(timer)
    if (gen !== r.gen) return
    applySnapshot(snap)
    applyTimeline(page)
    if (r.active) release()
  }, [
    readSnapshot,
    readTimeline,
    applySnapshot,
    applyTimeline,
    merge,
    publishLive,
  ])

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
  /** What was read, as soon as it lands — what the state shows on the
   *  next render: a read asked for meanwhile (the board's news, A4) sees
   *  it. The only writer of both. */
  const dispatchByIdRef = useRef(dispatchById)
  const fetchDispatches = useCallback(
    async function fetch(ids: number[]) {
      const want: number[] = []
      for (const id of ids) {
        if (fetchingDispatches.current.has(id)) staleDispatches.current.add(id)
        else want.push(id)
      }
      if (want.length === 0) return
      // A read takes so many at most: in turns.
      if (want.length > DISPATCH_READ) {
        await Promise.all(
          Array.from(
            { length: Math.ceil(want.length / DISPATCH_READ) },
            (_, i) =>
              fetch(want.slice(i * DISPATCH_READ, (i + 1) * DISPATCH_READ))
          )
        )
        return
      }
      for (const id of want) fetchingDispatches.current.add(id)
      try {
        const list = await personalAgentDispatches(null, null, want, botId)
        const next = new Map(dispatchByIdRef.current)
        for (const d of list) next.set(d.id, d)
        dispatchByIdRef.current = next
        setDispatchById(next)
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
    nudgeStatusRef.current = nudgeStatus
  }, [nudgeStatus])

  useEffect(() => {
    void refresh()
    const recovery = recovering.current
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
            if (recovering.current.active) {
              recovering.current.rows.push(...change.rows)
              break
            }
            merge(change.rows)
            // The unread count lives in the snapshot.
            if (change.rows.some(movesUnseen)) nudgeStatus()
            break
          case "reply":
            takeLive(change.row_id, {
              current: change.current,
              texts: change.texts ?? [],
              ver: change.ver ?? 0,
            })
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
          case "routine":
            setRoutineVersion((v) => v + 1)
            break
        }
      }
    ).then((u: () => void) => {
      if (cancelled) u()
      else unsub = u
    })
    // A board task queued to merge, or taken off the queue, stays in
    // review and its work does not move; a merge that fails goes back to
    // review the same way: what its head offers next (A4) is read again
    // from the board's own news — every held piece of work on a task not
    // ended, and any being read now (read again once it lands), a burst
    // at once.
    let boardTimer: ReturnType<typeof setTimeout> | null = null
    let unsubBoard: (() => void) | null = null
    void subscribe(WORK_TASK_CHANGED_EVENT, () => {
      if (cancelled || boardTimer != null) return
      boardTimer = setTimeout(() => {
        boardTimer = null
        if (cancelled) return
        const ids = new Set(fetchingDispatches.current)
        for (const d of dispatchByIdRef.current.values()) {
          const status = d.task?.status
          if (status != null && BOARD_MOVES.has(status)) ids.add(d.id)
        }
        if (ids.size > 0) void fetchDispatches([...ids])
      }, 400)
    }).then((u: () => void) => {
      if (cancelled) u()
      else unsubBoard = u
    })
    const offReconnect = onTransportReconnect(() => {
      void refreshTogether()
      setDispatchVersion((v) => v + 1)
      setItemVersion((v) => v + 1)
      setRoutineVersion((v) => v + 1)
      const ids = [...dispatchByIdRef.current.keys()]
      if (ids.length > 0) void fetchDispatches(ids)
    })
    return () => {
      cancelled = true
      // A recovery under way draws nothing into a store let go.
      recovery.gen++
      recovery.active = false
      recovery.rows = []
      recovery.held.clear()
      unsub?.()
      unsubBoard?.()
      if (boardTimer != null) clearTimeout(boardTimer)
      offReconnect?.()
      if (statusTimer.current) clearTimeout(statusTimer.current)
      if (quoteTimer.current) clearTimeout(quoteTimer.current)
    }
  }, [
    refresh,
    refreshTogether,
    nudgeStatus,
    merge,
    fetchDispatches,
    botId,
    takeLive,
  ])

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
      routineVersion,
      needsOwner,
      liveReplies,
      dispatchById,
      refetchDispatches: fetchDispatches,
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
      routineVersion,
      needsOwner,
      liveReplies,
      dispatchById,
      fetchDispatches,
      quoted,
      requestQuoted,
    ]
  )

  return value
}

/** The primary's store, where the page shows another assistant: the
 *  sidebar and the other places that are about the primary read it. */
const PrimaryAgentContext = createContext<PersonalAgentContextValue | null>(
  null
)

/** The primary assistant's store, whichever assistant the page shows. */
export function usePrimaryAgent() {
  const own = useContext(PrimaryAgentContext)
  const ctx = useContext(PersonalAgentContext)
  const value = own ?? ctx
  if (!value) {
    throw new Error("usePrimaryAgent must be used within PersonalAgentProvider")
  }
  return value
}

/** A store not loaded yet: what the page shows while it is. */
function pendingStore(botId: number): PersonalAgentContextValue {
  return {
    botId,
    snapshot: null,
    rows: [],
    hasOlder: false,
    loading: true,
    loadOlder: async () => {},
    loadSince: async () => "loaded",
    refresh: async () => {},
    dispatchVersion: 0,
    itemVersion: 0,
    routineVersion: 0,
    needsOwner: false,
    liveReplies: new Map(),
    dispatchById: new Map(),
    refetchDispatches: async () => {},
    quoted: new Map(),
    requestQuoted: () => {},
  }
}

/** How long the page keeps showing the assistant it showed while the one
 *  picked is read; then it shows the one picked, read or not. */
export const SWITCH_HOLD_MS = 1500

/** How many work assistants besides the one shown stay read and live — the
 *  last ones shown, and those read ahead — so going back to one, or to one
 *  the pointer rested on, is at once. */
export const WARM_STORES = 3

/** Holds a work assistant's store and hands it up; renders nothing. */
function ViewedStore({
  botId,
  onValue,
  onGone,
}: {
  botId: number
  onValue: (v: { bot: number; value: PersonalAgentContextValue }) => void
  onGone: (bot: number) => void
}) {
  const value = usePersonalAgentStore(botId)
  useEffect(() => onValue({ bot: botId, value }), [botId, value, onValue])
  useEffect(() => () => onGone(botId), [botId, onGone])
  return null
}

/** Read enough to draw the page: its snapshot and its newest rows. */
function isReady(value: PersonalAgentContextValue | null): boolean {
  return value != null && !value.loading && value.snapshot != null
}

/**
 * Inside the primary's provider: the assistant the page shows (`viewBot`,
 * picked in the roster) is what `usePersonalAgent` reads below — its own
 * store, made afresh for each assistant — while `usePrimaryAgent` keeps
 * reading the primary's. The tree under it never changes shape, so
 * switching assistants remounts nothing of the workspace.
 *
 * Switching, the page goes on showing the assistant it showed — its store
 * kept, live, and marked switching (`usePersonalAgentSwitch`), so the page
 * draws it but takes no action on it — until the one picked is read
 * (`SWITCH_HOLD_MS` at most), and then shows that one whole: never a page
 * emptied while it loads. The last few shown, and those read ahead
 * (`usePrefetchAssistant`), stay read and live (`WARM_STORES`): switching
 * to one of them is at once.
 */
export function ViewedPersonalAgentProvider({
  viewBot,
  children,
}: {
  /** The work assistant shown; `null` (or the primary's id) is the primary. */
  viewBot: number | null
  children: ReactNode
}) {
  const primary = useContext(PersonalAgentContext)
  const [stores, setStores] = useState<
    ReadonlyMap<number, PersonalAgentContextValue>
  >(() => new Map())
  const onValue = useCallback(
    ({ bot, value }: { bot: number; value: PersonalAgentContextValue }) =>
      setStores((held) => new Map(held).set(bot, value)),
    []
  )
  const onGone = useCallback(
    (bot: number) =>
      setStores((held) => {
        if (!held.has(bot)) return held
        const next = new Map(held)
        next.delete(bot)
        return next
      }),
    []
  )
  const primaryId = primary?.snapshot?.agent?.id ?? null
  const other = viewBot != null && viewBot !== primaryId ? viewBot : null
  // The work assistants kept read besides the one picked, the latest
  // first: the last ones shown, and those read ahead.
  const [warm, setWarm] = useState<readonly number[]>([])
  const [warmFor, setWarmFor] = useState<number | null>(other)
  if (warmFor !== other) {
    setWarmFor(other)
    if (warmFor != null) setWarm((held) => warmFirst(held, warmFor))
  }
  const prefetch = useCallback(
    (bot: number) => {
      if (bot === primaryId) return
      setWarm((held) => (held[0] === bot ? held : warmFirst(held, bot)))
    },
    [primaryId]
  )
  // The store picked (`null`: the primary's), and the one the page shows.
  const [shown, setShown] = useState<number | null>(other)
  // Waiting for the one picked given up, this switch: a new pick waits
  // afresh, the same assistant picked again included.
  const [gaveUp, setGaveUp] = useState<number | null>(null)
  const [picked, setPicked] = useState<number | null>(other)
  if (picked !== other) {
    setPicked(other)
    setGaveUp(null)
  }
  const storeOf = (bot: number | null) =>
    bot == null ? primary : (stores.get(bot) ?? null)
  const wanted = storeOf(other)
  if (shown !== other && (isReady(wanted) || gaveUp === other)) {
    setShown(other)
  }
  const switching = shown !== other
  useEffect(() => {
    if (!switching) return
    const timer = window.setTimeout(() => setGaveUp(other), SWITCH_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [switching, other])
  const held = switching ? storeOf(shown) : null
  // The store the page showed, as it is, while another is read: marking it
  // switching apart from it re-renders nothing that only reads the store.
  const value = held ?? storeOf(other)
  const pending = useMemo(() => pendingStore(other ?? 0), [other])
  const switchState = useMemo<PersonalAgentSwitch>(
    () => (switching ? { switching: true, to: other } : NOT_SWITCHING),
    [switching, other]
  )
  // The store picked, the one still shown while it is read, and those kept
  // warm.
  const mounted = [other, switching ? shown : null, ...warm].filter(
    (b, i, all): b is number =>
      b != null && b !== primaryId && all.indexOf(b) === i
  )
  return (
    <PrimaryAgentContext.Provider value={primary}>
      {mounted.map((bot) => (
        <ViewedStore key={bot} botId={bot} onValue={onValue} onGone={onGone} />
      ))}
      <PrefetchAssistantContext.Provider value={prefetch}>
        <PersonalAgentSwitchContext.Provider value={switchState}>
          <PersonalAgentContext.Provider value={value ?? pending}>
            {children}
          </PersonalAgentContext.Provider>
        </PersonalAgentSwitchContext.Provider>
      </PrefetchAssistantContext.Provider>
    </PrimaryAgentContext.Provider>
  )
}

/** `bot` first among those kept warm, the oldest let go past
 *  `WARM_STORES`. */
function warmFirst(held: readonly number[], bot: number): number[] {
  return [bot, ...held.filter((b) => b !== bot)].slice(0, WARM_STORES)
}
