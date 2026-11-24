"use client"

/** The side panel's reads of an assistant's work — its open matters and
 *  its dispatches, each kept with the assistant it is of — and the clock its
 *  cards share. */

import { useEffect, useMemo, useState } from "react"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentDispatches, personalAgentItems } from "@/lib/api"
import type {
  DispatchInfo,
  DispatchState,
  ItemInfo,
  WaitsFor,
} from "@/lib/types"

/** The dispatches the work tab reads: enough for the ended list. */
const DISPATCH_PAGE = 200

/** Work that has not ended. */
export const MOVING: ReadonlySet<DispatchState> = new Set([
  "queued",
  "running",
  "waiting_input",
  "review",
])

/** The sections of the work tab, in order: who each piece waits on. */
export type Group = WaitsFor | "none"

export const GROUPS: Group[] = ["owner", "external", "agent", "time", "none"]

/** One open thing in the work tab: an entry of the ledger, with its
 *  dispatch when it is handed-out work — or a dispatch still moving that no
 *  open entry covers (its entry dropped). */
export interface Matter {
  key: string
  item: ItemInfo | null
  dispatch: DispatchInfo | null
  group: Group
  at: string
}

/** Work waiting for review or an answer waits on the owner, whatever its
 *  entry says. */
function waitsOwner(state: DispatchState | null | undefined): boolean {
  return state === "waiting_input" || state === "review"
}

/** A read, and the assistant it is of (`null`: the primary). */
export interface Of<T> {
  bot: number | null
  value: T
}

/** What was read for `bot`; `null` while only another one's is held. */
export function ofBot<T>(read: Of<T> | null, bot: number | null): T | null {
  return read != null && read.bot === bot ? read.value : null
}

/** The open matters and the dispatches, loaded for the panel: the work tab
 *  lists them, the rail counts what waits on the owner. */
export function useWork() {
  const { botId, itemVersion, dispatchVersion, dispatchById } =
    usePersonalAgent()
  // Each read kept with the assistant it is of: another one shown waits for
  // its own, never drawing the last one's.
  const [itemsOf, setItemsOf] = useState<Of<ItemInfo[]> | null>(null)
  const [dispatchesOf, setDispatchesOf] = useState<Of<DispatchInfo[]> | null>(
    null
  )
  useEffect(() => {
    let cancelled = false
    personalAgentItems("active", botId)
      .then((list) => {
        if (!cancelled) setItemsOf({ bot: botId, value: list })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [itemVersion, dispatchVersion, botId])
  useEffect(() => {
    let cancelled = false
    personalAgentDispatches(null, DISPATCH_PAGE, null, botId)
      .then((list) => {
        if (!cancelled) setDispatchesOf({ bot: botId, value: list })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [dispatchVersion, botId])
  const items = ofBot(itemsOf, botId)
  const dispatches = ofBot(dispatchesOf, botId)
  return useMemo(() => {
    if (items == null || dispatches == null) return null
    const byId = new Map(dispatches.map((d) => [d.id, d]))
    const covered = new Set<number>()
    const open: Matter[] = []
    for (const item of items) {
      const dispatch =
        item.dispatch_id != null
          ? (byId.get(item.dispatch_id) ??
            dispatchById.get(item.dispatch_id) ??
            null)
          : null
      if (item.dispatch_id != null) covered.add(item.dispatch_id)
      const state = dispatch?.state ?? item.dispatch_state
      open.push({
        key: `i${item.id}`,
        item,
        dispatch,
        group: waitsOwner(state) ? "owner" : (item.waits_for ?? "none"),
        at: dispatch?.updated_at ?? item.updated_at,
      })
    }
    for (const d of dispatches) {
      if (covered.has(d.id) || !MOVING.has(d.state)) continue
      open.push({
        key: `d${d.id}`,
        item: null,
        dispatch: d,
        group: waitsOwner(d.state) ? "owner" : "external",
        at: d.updated_at,
      })
    }
    const newest = (a: string, b: string) => Date.parse(b) - Date.parse(a)
    open.sort((a, b) => newest(a.at, b.at))
    const ended = dispatches
      .filter((d) => !covered.has(d.id) && !MOVING.has(d.state))
      .sort((a, b) =>
        newest(a.finished_at ?? a.updated_at, b.finished_at ?? b.updated_at)
      )
    return { open, ended }
  }, [items, dispatches, dispatchById])
}

/** The current time, a minute at a time: the cards' "3h" all read one
 *  clock, as the task tab's do. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])
  return now
}
