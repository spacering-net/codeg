"use client"

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { create } from "zustand"

import { refreshActivity } from "@/stores/personal-agent-activity-store"

/** How long a row's buttons stay off after an act, waiting for the row to
 *  be read again showing it. */
export const ACT_SETTLE_MS = 10_000

/** An RFC 3339 instant as a string that sorts as the instant does: its
 *  fraction padded to nanoseconds (the backend writes as many digits as it
 *  needs), a UTC offset as `Z`. */
function sortable(at: string): string {
  const m = /^(.+T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]00:00)$/i.exec(at)
  if (!m) return at
  return `${m[1]}.${(m[2] ?? "").padEnd(9, "0").slice(0, 9)}Z`
}

/** Whether version `a` (a row's `updated_at`) is `b` or later. */
export function atLeast(a: string, b: string): boolean {
  return sortable(a) >= sortable(b)
}

/** What a row's act waits to see on the row as read again: its version at
 *  `atLeast` the one the act wrote, or `differs` from what it was. */
export type SettleTarget = { atLeast: string } | { differs: string }

type Waiting = SettleTarget & { n: number }

/** The rows waiting to be read again, by the row's key: kept apart from the
 *  rows' buttons, so a row drawn again (the panel closed and opened, its
 *  group folded and unfolded) or an [Undo] on a toast still waits. */
const useSettling = create<{ waits: Record<string, Waiting> }>(() => ({
  waits: {},
}))

let lastWait = 0

/** How many of each row's buttons are drawn now, by the row's key. */
const drawn = new Map<string, number>()

/** Forget every wait (tests: a row of one case is not another's). */
export function clearSettling() {
  useSettling.setState({ waits: {} })
}

function clearWait(key: string, n: number) {
  useSettling.setState((s) => {
    if (s.waits[key]?.n !== n) return s
    const waits = { ...s.waits }
    delete waits[key]
    return { waits }
  })
}

/** Row `key`'s act succeeded: its buttons stay off until the row as read
 *  shows `target`. Not seen within {@link ACT_SETTLE_MS} while the row is
 *  still drawn: the activity is read again, the owner told
 *  (`notRefreshed`), the buttons back on — pressed again, they carry the
 *  old version and the backend refuses them (`changed`), so nothing is done
 *  twice. A row no longer drawn by then (it left its group: the act showed)
 *  just stops waiting. */
export function waitForSettle(
  key: string,
  target: SettleTarget,
  notRefreshed: string,
  /** What reads the row again (the activity, by default). */
  reread: () => void = refreshActivity
) {
  const n = ++lastWait
  useSettling.setState((s) => ({
    waits: { ...s.waits, [key]: { ...target, n } },
  }))
  setTimeout(() => {
    if (useSettling.getState().waits[key]?.n !== n) return
    clearWait(key, n)
    if (!drawn.get(key)) return
    reread()
    toast.message(notRefreshed)
  }, ACT_SETTLE_MS)
}

function caughtUp(now: string, w: Waiting): boolean {
  return "atLeast" in w ? atLeast(now, w.atLeast) : now !== w.differs
}

/**
 * Whether row `key` — as the store holds it, `now` its version — is still
 * waiting for its act to show, and how to make it wait. A push that came
 * before the act's return counts: the version is compared, not the order.
 * A row that leaves its group goes with its buttons.
 */
export function useActSettle(
  key: string,
  now: string,
  reread?: () => void
): {
  waiting: boolean
  waitFor: (target: SettleTarget) => void
} {
  const t = useTranslations("PersonalAgent.matter.toast")
  const wait = useSettling((s) => s.waits[key])
  const done = wait != null && caughtUp(now, wait)
  useEffect(() => {
    drawn.set(key, (drawn.get(key) ?? 0) + 1)
    return () => {
      const left = (drawn.get(key) ?? 1) - 1
      if (left > 0) drawn.set(key, left)
      else drawn.delete(key)
    }
  }, [key])
  useEffect(() => {
    if (wait && done) clearWait(key, wait.n)
  }, [key, wait, done])
  return {
    waiting: wait != null && !done,
    waitFor: (target) => waitForSettle(key, target, t("notRefreshed"), reread),
  }
}
