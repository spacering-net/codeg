"use client"

/**
 * The way back to the activity (7.6): the owner left it for a row's card,
 * session or work, from the drawer that closed to show it. The page it led
 * to says so at its top — "from the activity · N more wait on you · back"
 * — until they go back, go somewhere else, ten minutes pass, or nothing
 * waits on them any more.
 */

import { create } from "zustand"

/** How long the way back is offered. */
export const RETURN_MAX_MS = 10 * 60_000

export interface ReturnFrom {
  /** The assistant whose activity it was (`null`: the primary's). */
  bot: number | null
  /** When they left it (epoch ms). */
  at: number
}

export const useActivityReturn = create<{ from: ReturnFrom | null }>(() => ({
  from: null,
}))

/** The owner left the activity of `bot` for a row's own place. */
export function markReturn(bot: number | null) {
  useActivityReturn.setState({ from: { bot, at: Date.now() } })
}

/** The way back offered no more. */
export function clearReturn() {
  if (useActivityReturn.getState().from != null) {
    useActivityReturn.setState({ from: null })
  }
}

/** Whether `from` is still to offer at `now`. */
export function returnStands(from: ReturnFrom | null, now: number): boolean {
  return from != null && now - from.at < RETURN_MAX_MS
}
