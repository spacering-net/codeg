"use client"

/**
 * The activity's rows on their way out (7.4): a row whose main button was
 * pressed leaves its group at once — the group's count with it — instead of
 * staying until the list is read again. It comes back if the act fails;
 * once a read has it in its group no more (gone, or moved on to another
 * group, where it shows), it is forgotten; one still read there after a
 * while (the act took, but nothing moved it) comes back by itself, so no
 * row is ever lost to a press.
 *
 * For a moment after a row leaves, every row's buttons are cool to a
 * double-click's second click: the row that moves up into its place is not
 * pressed by the click meant for the one that left.
 */

import { create } from "zustand"

/** How long after a row leaves the rows' buttons do not answer. */
export const LEAVE_COOL_MS = 300
/** How long a row that left and is still read in its group stays away. */
export const LEAVE_RESTORE_MS = 8_000

interface Left {
  /** When it left (epoch ms): what brings this leaving back, and only it. */
  at: number
  /** The group it left. */
  group: string
}

interface LeavingStore {
  /** The rows that left, by list (whose activity: [`listOf`]) and key. */
  hidden: Record<string, Left>
  /** Until when the rows' buttons are cool (epoch ms). */
  coolUntil: number
}

export const useActivityLeaving = create<LeavingStore>(() => ({
  hidden: {},
  coolUntil: 0,
}))

/** Whose activity list it is: the page's assistant (`null`: the primary).
 *  A row left one list; another's list read meanwhile says nothing of it. */
export function listOf(bot: number | null): string {
  return bot == null ? "primary" : String(bot)
}

const slot = (list: string, key: string) => `${list}\u0000${key}`

/** One row's leaving: what brings it back, and only it — in the list it
 *  left, whichever is shown when it comes back. */
export interface LeaveToken {
  list: string
  key: string
  at: number
}

/** Row `key` leaves group `group` of `list` (the list it is drawn in,
 *  [`listOf`]) as its act is pressed. What brings it back if the act fails:
 *  [`returnRow`] with the token returned. */
export function leaveRow(key: string, group: string, list: string): LeaveToken {
  const at = Date.now()
  const token = { list, key, at }
  // Where it was pressed: what moves up into that place is cool there.
  coolRect = lastPress && at - lastPress.at < PRESS_MS ? lastPress : null
  useActivityLeaving.setState((s) => ({
    hidden: { ...s.hidden, [slot(list, key)]: { at, group } },
    coolUntil: at + LEAVE_COOL_MS,
  }))
  // Still read there a while after: back, whatever kept it.
  setTimeout(() => returnRow(token), LEAVE_RESTORE_MS)
  return token
}

/** A row back (its act failed, or was taken back) — only the leaving of
 *  `token`: one that left again since stays away. */
export function returnRow(token: LeaveToken) {
  useActivityLeaving.setState((s) => {
    const k = slot(token.list, token.key)
    const left = s.hidden[k]
    if (!left || left.at !== token.at) return s
    const hidden = { ...s.hidden }
    delete hidden[k]
    return { hidden }
  })
}

/** A read of `list` (`placed`: each row's key, the group it is in): a row
 *  of it that left and is in its group no more is forgotten. Another
 *  list's rows are not this read's to tell. */
export function settleLeaving(
  list: string,
  placed: ReadonlyMap<string, string>
) {
  const prefix = slot(list, "")
  useActivityLeaving.setState((s) => {
    const gone = Object.entries(s.hidden)
      .filter(([k]) => k.startsWith(prefix))
      .filter(([k, left]) => placed.get(k.slice(prefix.length)) !== left.group)
      .map(([k]) => k)
    if (gone.length === 0) return s
    const hidden = { ...s.hidden }
    for (const k of gone) delete hidden[k]
    return { hidden }
  })
}

/** Whether row `key` of `list` is away from group `group`. */
export function isAway(
  hidden: Record<string, Left>,
  list: string,
  key: string,
  group: string
): boolean {
  return hidden[slot(list, key)]?.group === group
}

/** The row just pressed, and where on the screen (its top and bottom). */
let lastPress: { at: number; top: number; bottom: number } | null = null
/** Where the row that just left was. */
let coolRect: { top: number; bottom: number } | null = null
/** A leaving within this of a press is that press's. */
const PRESS_MS = 200

/** A click on a row (the list hears it first): where it was. */
export function notePress(top: number, bottom: number) {
  lastPress = { at: Date.now(), top, bottom }
}

/** Whether the list lets a click on a row go by (7.4): the row that just
 *  left left its place to the one moved up, which a second click — of a
 *  double-click, or a quick second tap — lands on. */
export function pressCool(click: { detail: number; clientY: number }): boolean {
  if (Date.now() >= useActivityLeaving.getState().coolUntil) return false
  if (click.detail > 1) return true
  return (
    coolRect != null &&
    click.clientY >= coolRect.top &&
    click.clientY < coolRect.bottom
  )
}

/** Whether a click is to be let go: the second (or later) click of a
 *  double-click (`detail`, the click's count) while the rows are cool —
 *  meant for a row that just left, landing on the one moved up. */
export function rowsCool(detail: number): boolean {
  return detail > 1 && Date.now() < useActivityLeaving.getState().coolUntil
}

/** Forget everything (tests). */
export function __resetLeavingForTests() {
  useActivityLeaving.setState({ hidden: {}, coolUntil: 0 })
  lastPress = null
  coolRect = null
}
