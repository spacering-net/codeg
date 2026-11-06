"use client"

/**
 * What the assistants said that is new to the owner, for the message list.
 *
 * While the owner watches (the list at its bottom in a window that has
 * focus), everything up to the newest row held is marked seen as it lands:
 * the server marks every unseen message up to that row — older ones than
 * what is held too, which the count it keeps covers — and a reply still
 * running stays new until it settles, to be marked then.
 *
 * When the owner comes to the list with something new waiting — the page
 * opening, the window coming back, a scroll back down — the first of it is
 * kept, for a "new messages" line above it, until they leave the page or
 * clear it (they sent a message).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { personalAgentMarkSeen } from "@/lib/api"
import type { TimelineRow } from "@/lib/types"

import { isUnseen } from "./message-items"

export function useOwnerSeen({
  rows,
  watching,
  unseenCount,
}: {
  /** The rows held, oldest first. */
  rows: readonly TimelineRow[]
  watching: boolean
  /** What the server counts as unseen, held or not. */
  unseenCount: number
}): { newFrom: number | null; clearNewFrom: () => void } {
  const unseenRows = useMemo(() => rows.filter(isUnseen), [rows])

  // Read as the owner comes (in render, before marking changes the rows).
  const [newFrom, setNewFrom] = useState<number | null>(null)
  const [wasWatching, setWasWatching] = useState(watching)
  if (watching !== wasWatching) {
    setWasWatching(watching)
    if (watching && newFrom == null && unseenRows.length > 0) {
      setNewFrom(unseenRows[0].id)
    }
  }

  // One request per state of what is new, so a mark that changes nothing
  // (it raced the broadcast) is not sent again and again.
  const newestId = rows.length > 0 ? rows[rows.length - 1].id : null
  const markKey =
    watching && newestId != null && (unseenRows.length > 0 || unseenCount > 0)
      ? `${newestId}:${unseenRows.map((r) => r.id).join(",")}:${unseenCount > 0}`
      : null
  const lastMark = useRef<string | null>(null)
  useEffect(() => {
    if (markKey == null || newestId == null || markKey === lastMark.current)
      return
    lastMark.current = markKey
    personalAgentMarkSeen(newestId).catch(() => {
      // Tried again on the next change.
      if (lastMark.current === markKey) lastMark.current = null
    })
  }, [markKey, newestId])

  const clearNewFrom = useCallback(() => setNewFrom(null), [])
  return { newFrom, clearNewFrom }
}
