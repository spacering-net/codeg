"use client"

import { useEffect, useState } from "react"
import { listAskConversations } from "@/lib/api"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import {
  CONVERSATION_CHANGED_EVENT,
  type ConversationChange,
  type DbConversationSummary,
} from "@/lib/types"

/** Newest first, id as the tie-break — the backend's `list_ask_children`
 *  order, so a row added live lands where a refetch would put it. */
function byCreatedAtDesc(
  a: DbConversationSummary,
  b: DbConversationSummary
): number {
  if (a.created_at > b.created_at) return -1
  if (a.created_at < b.created_at) return 1
  return b.id - a.id
}

/**
 * Fold one `conversation://changed` event into `parentId`'s ask list.
 *
 * - An upsert naming `parentId` inserts or replaces the row.
 * - An upsert of a listed row that no longer names it — unlinked into an
 *   ordinary conversation — drops it.
 * - A delete drops the row; a status change patches it.
 *
 * Returns `rows` itself when the event doesn't touch the list, so a caller's
 * state setter bails out of the re-render.
 */
export function applyAskConversationChange(
  rows: readonly DbConversationSummary[],
  parentId: number,
  change: ConversationChange
): readonly DbConversationSummary[] {
  if (change.kind === "upsert") {
    const { summary } = change
    const index = rows.findIndex((row) => row.id === summary.id)
    if (summary.kind === "ask" && summary.parent_id === parentId) {
      const next = rows.slice()
      if (index < 0) next.push(summary)
      else next[index] = summary
      return next.sort(byCreatedAtDesc)
    }
    if (index < 0) return rows
    return rows.filter((row) => row.id !== summary.id)
  }
  const index = rows.findIndex((row) => row.id === change.id)
  if (index < 0) return rows
  if (change.kind === "deleted") {
    return rows.filter((row) => row.id !== change.id)
  }
  if (rows[index].status === change.status) return rows
  const next = rows.slice()
  next[index] = { ...rows[index], status: change.status }
  return next
}

interface LoadedAsks {
  parentId: number
  rows: readonly DbConversationSummary[]
}

/**
 * The ask conversations of `parentId` (a persisted conversation's id), newest
 * first, kept live: rows created, renamed, unlinked or deleted anywhere reach
 * the list through `conversation://changed`, and a transport reconnect (which
 * drops the events sent while it was down) re-fetches.
 *
 * `null` while the first fetch is in flight, or when there is no parent.
 */
export function useAskConversations(
  parentId: number | null
): readonly DbConversationSummary[] | null {
  const [loaded, setLoaded] = useState<LoadedAsks | null>(null)

  useEffect(() => {
    if (parentId == null) return
    let disposed = false
    // Events that land before the fetch answers are replayed onto it: the
    // fetch may have read the table before an ask created meanwhile.
    let early: ConversationChange[] | null = []

    const load = () => {
      early = early ?? []
      listAskConversations(parentId)
        .then((fetched) => {
          if (disposed) return
          let rows: readonly DbConversationSummary[] = fetched
          for (const change of early ?? []) {
            rows = applyAskConversationChange(rows, parentId, change)
          }
          early = null
          setLoaded({ parentId, rows })
        })
        .catch((error: unknown) => {
          if (disposed) return
          console.error("[ask-conversations] list failed:", error)
          early = null
          setLoaded((prev) =>
            prev?.parentId === parentId ? prev : { parentId, rows: [] }
          )
        })
    }

    let unlisten: (() => void) | undefined
    void (async () => {
      const dispose = await subscribe<ConversationChange>(
        CONVERSATION_CHANGED_EVENT,
        (change) => {
          if (early) {
            early.push(change)
            return
          }
          setLoaded((prev) => {
            if (prev?.parentId !== parentId) return prev
            const rows = applyAskConversationChange(prev.rows, parentId, change)
            return rows === prev.rows ? prev : { parentId, rows }
          })
        }
      )
      if (disposed) dispose()
      else unlisten = dispose
    })()
    load()
    const offReconnect = onTransportReconnect(load)

    return () => {
      disposed = true
      unlisten?.()
      offReconnect?.()
    }
  }, [parentId])

  if (parentId == null || loaded?.parentId !== parentId) return null
  return loaded.rows
}
