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

import { personalAgentGet, personalAgentTimeline } from "@/lib/api"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import {
  PERSONAL_AGENT_CHANGED_EVENT,
  type PersonalAgentChange,
  type PersonalAgentSnapshot,
  type TimelineRow,
} from "@/lib/types"

/** Rows the page loads first, and per "load older". */
const PAGE_SIZE = 60
/** How often a read-only page (the agent runs in another process) re-reads:
 *  that process's broadcasts never reach this one. */
const ELSEWHERE_POLL_MS = 5_000

interface PersonalAgentContextValue {
  snapshot: PersonalAgentSnapshot | null
  /** Timeline rows held, oldest first. */
  rows: TimelineRow[]
  hasOlder: boolean
  loading: boolean
  loadOlder: () => Promise<void>
  refresh: () => Promise<void>
  /** Bumped on every dispatch / item change, for the panels that list them. */
  dispatchVersion: number
  itemVersion: number
  /** The agent waits on the owner (a question or permission request). */
  needsOwner: boolean
}

const PersonalAgentContext = createContext<PersonalAgentContextValue | null>(
  null
)

export function usePersonalAgent() {
  const ctx = useContext(PersonalAgentContext)
  if (!ctx) {
    throw new Error(
      "usePersonalAgent must be used within PersonalAgentProvider"
    )
  }
  return ctx
}

/** Merge rows into the held set by id, keeping id order. */
export function mergeRows(
  held: readonly TimelineRow[],
  incoming: readonly TimelineRow[]
): TimelineRow[] {
  if (incoming.length === 0) return held as TimelineRow[]
  const byId = new Map<number, TimelineRow>()
  for (const r of held) byId.set(r.id, r)
  for (const r of incoming) {
    const prev = byId.get(r.id)
    // A late broadcast must not roll a row back to an older state.
    if (!prev || prev.updated_at <= r.updated_at) byId.set(r.id, r)
  }
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

/**
 * Data layer of the personal agent: its snapshot and timeline, kept mounted
 * for the whole workspace so the sidebar can show when the agent waits on the
 * owner, and so the page — remounted on every visit, like any route — paints
 * at once. Broadcasts carry timeline rows whole; everything else is a nudge to
 * refetch.
 */
export function PersonalAgentProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<PersonalAgentSnapshot | null>(null)
  const [rows, setRows] = useState<TimelineRow[]>([])
  const [hasOlder, setHasOlder] = useState(false)
  const [loading, setLoading] = useState(true)
  const [dispatchVersion, setDispatchVersion] = useState(0)
  const [itemVersion, setItemVersion] = useState(0)
  const snapReq = useRef(0)
  const rowsRef = useRef<TimelineRow[]>([])
  useEffect(() => {
    rowsRef.current = rows
  }, [rows])

  const refreshSnapshot = useCallback(async () => {
    const id = ++snapReq.current
    try {
      const snap = await personalAgentGet()
      if (id === snapReq.current) setSnapshot(snap)
    } catch {
      // keep the last good one; the next nudge recovers
    }
  }, [])

  /** The newest page, merged over what is held (older pages stay). */
  const refreshTimeline = useCallback(async () => {
    try {
      const page = await personalAgentTimeline(null, PAGE_SIZE)
      setRows((held) => mergeRows(held, page.rows))
      if (rowsRef.current.length === 0) setHasOlder(page.has_older)
    } catch {
      // ignore — a later event recovers
    } finally {
      setLoading(false)
    }
  }, [])

  const refresh = useCallback(async () => {
    await Promise.all([refreshSnapshot(), refreshTimeline()])
  }, [refreshSnapshot, refreshTimeline])

  const loadOlder = useCallback(async () => {
    const oldest = rowsRef.current[0]?.id
    if (oldest == null) return
    const page = await personalAgentTimeline(oldest, PAGE_SIZE)
    setRows((held) => mergeRows(held, page.rows))
    setHasOlder(page.has_older)
  }, [])

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
        switch (change.kind) {
          case "timeline":
            setRows((held) => mergeRows(held, change.rows))
            break
          case "status":
          case "agent":
            nudgeStatus()
            break
          case "dispatch":
            setDispatchVersion((v) => v + 1)
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
    })
    return () => {
      cancelled = true
      unsub?.()
      offReconnect?.()
      if (statusTimer.current) clearTimeout(statusTimer.current)
    }
  }, [refresh, nudgeStatus])

  // Read-only elsewhere: poll, since the running process's broadcasts stay
  // in that process.
  const elsewhere = snapshot?.status.engine === "elsewhere"
  useEffect(() => {
    if (!elsewhere) return
    const timer = setInterval(() => {
      void refresh()
      setDispatchVersion((v) => v + 1)
      setItemVersion((v) => v + 1)
    }, ELSEWHERE_POLL_MS)
    return () => clearInterval(timer)
  }, [elsewhere, refresh])

  const needsOwner =
    (snapshot?.status.pending_permission ?? false) ||
    (snapshot?.status.pending_question ?? false)

  const value = useMemo<PersonalAgentContextValue>(
    () => ({
      snapshot,
      rows,
      hasOlder,
      loading,
      loadOlder,
      refresh,
      dispatchVersion,
      itemVersion,
      needsOwner,
    }),
    [
      snapshot,
      rows,
      hasOlder,
      loading,
      loadOlder,
      refresh,
      dispatchVersion,
      itemVersion,
      needsOwner,
    ]
  )

  return (
    <PersonalAgentContext.Provider value={value}>
      {children}
    </PersonalAgentContext.Provider>
  )
}
