"use client"

import { useEffect, useState } from "react"
import { forgeIssueDetail } from "@/lib/api"
import type { ForgeIssueRow } from "@/lib/types"

/**
 * The description of an issue whose LIST row carries none.
 *
 * CNB's issue list omits `body` entirely (its pull list carries one), so the
 * first paint has nothing to draw where the description goes. One read, paid
 * when the panel (or the trigger dialog) opens — the same trade the comment
 * thread makes, and for the same reason: a list page holds thirty items whose
 * reader opens at most one. Scoped to that forge by the caller; every other
 * one ships the body on the row and never asks.
 *
 * `pending` is its own state rather than "body is null", because the two
 * answer different questions — "the forge has not said yet" and "the forge
 * says there is nothing" — and only the second may draw the empty-state line.
 */
export function useIssueBody(
  folderId: number | null,
  row: ForgeIssueRow | null,
  enabled: boolean
): { body: string | null; pending: boolean } {
  const [read, setRead] = useState<{ key: string; body: string | null } | null>(
    null
  )
  // The folder is part of the key: issue #42 of one repository is not #42 of
  // another, and a read held for the first must not answer for the second.
  const key =
    row != null
      ? `${folderId ?? "none"}:${row.is_pr ? "pr" : "issue"}-${row.number}`
      : null
  const onRow = row?.body ?? null
  const wanted = enabled && row != null && !row.is_pr && onRow == null
  const number = row?.number ?? null

  useEffect(() => {
    if (!wanted || key == null || number == null || folderId == null) return
    let live = true
    forgeIssueDetail(folderId, number)
      .then((full) => {
        if (live) setRead({ key, body: full.body ?? null })
      })
      .catch(() => {
        // The caller keeps drawing — the thread reports its own failures.
        // Falling back to "no description" is the honest cost of one failed
        // read: the alternative is an empty slot that never fills.
        if (live) setRead({ key, body: null })
      })
    return () => {
      live = false
    }
    // `onRow` is a dependency so a row that ARRIVES with a body — a list
    // refresh, or a write the page adopted — retires the read instead of
    // leaving a second copy to disagree with it.
  }, [wanted, folderId, key, number, onRow])

  if (!wanted) return { body: onRow, pending: false }
  // No folder, no read — and so nothing to wait for. Saying "pending" here
  // would leave an empty slot that never fills.
  if (folderId == null) return { body: null, pending: false }
  if (read?.key !== key) return { body: null, pending: true }
  return { body: read.body, pending: false }
}
