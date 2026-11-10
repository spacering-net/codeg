/**
 * The roster's order and each assistant's look, from the live states (8.3,
 * 4.14, 10.6) — pure, so every rule is a unit test.
 *
 * - **Stale.** A busy state not renewed by its expiry is taken as at rest:
 *   no working face, no activity (principle 14).
 * - **Look.** A turn or a piece of work just done (or failed) shows for its
 *   few seconds; waiting on the owner past two minutes is `stuck`; else the
 *   face the backend computed.
 * - **Dot.** Orange while it waits on the owner, blue while something it
 *   said is unseen (or the owner marked it unread); none otherwise.
 * - **Order.** The primary first; then the pinned ones in the owner's
 *   order; then the owner's groups, by name; then the rest. Within a group:
 *   waiting on the owner, then working, then idle, then done — the most
 *   recently active first in each. Hidden ones are left out, counted.
 */

import type { BotLive, BotLook, RosterEntry } from "@/lib/types"

/** Waiting on the owner this long is `stuck`. */
export const STUCK_AFTER_MS = 120_000

export type RosterDot = "waiting" | "unread" | null

export interface BotView {
  look: BotLook
  /** Its busy state expired unrenewed. */
  stale: boolean
  dot: RosterDot
  /** Working now (not stale). */
  busy: boolean
}

export function isStale(live: BotLive, now: number): boolean {
  return live.expires_at != null && Date.parse(live.expires_at) <= now
}

/** How an assistant looks at `now`. `unreadMark`: the owner marked it. */
export function viewOf(
  live: BotLive | null | undefined,
  now: number,
  unreadMark = false
): BotView {
  if (!live) {
    return {
      look: "idle",
      stale: false,
      dot: unreadMark ? "unread" : null,
      busy: false,
    }
  }
  const stale = isStale(live, now)
  const dot: RosterDot =
    live.attention === "needs_you"
      ? "waiting"
      : live.attention === "unread" || unreadMark
        ? "unread"
        : null
  const busy = live.work === "busy" && !stale
  let look: BotLook = live.face
  if (live.flash && Date.parse(live.flash.until) > now) {
    look = live.flash.face
  } else if (stale && (look === "working" || look === "thinking")) {
    look = "idle"
  } else if (
    look === "waiting" &&
    live.needs &&
    now - Date.parse(live.needs.since) >= STUCK_AFTER_MS
  ) {
    look = "stuck"
  }
  return { look, stale, dot, busy }
}

/** The tier an assistant sorts in: waiting on the owner, working, idle,
 *  done. */
export function tierOf(live: BotLive | null | undefined, now: number): number {
  if (!live) return 3
  if (live.attention === "needs_you") return 0
  if (live.work === "busy" && !isStale(live, now)) return 1
  if (live.work === "done") return 3
  return 2
}

function activeAt(e: RosterEntry): number {
  const at = e.live?.last_activity_at ?? e.created_at
  const t = Date.parse(at)
  return Number.isFinite(t) ? t : 0
}

function byTierThenRecent(now: number) {
  return (a: RosterEntry, b: RosterEntry) =>
    tierOf(a.live, now) - tierOf(b.live, now) ||
    activeAt(b) - activeAt(a) ||
    a.id - b.id
}

export interface RosterGroups {
  primary: RosterEntry | null
  pinned: RosterEntry[]
  sections: { name: string; entries: RosterEntry[] }[]
  rest: RosterEntry[]
  hidden: RosterEntry[]
}

/** The roster as it is drawn, at `now`. */
export function groupRoster(
  entries: readonly RosterEntry[],
  now: number,
  locale?: string
): RosterGroups {
  const primary = entries.find((e) => e.kind === "primary") ?? null
  const workers = entries.filter((e) => e.kind !== "primary")
  const shown = workers.filter((e) => !e.roster?.hidden)
  const hidden = workers
    .filter((e) => e.roster?.hidden)
    .sort(byTierThenRecent(now))
  const pinned = shown
    .filter((e) => e.roster?.pinned_at)
    .sort(
      (a, b) =>
        a.roster.sort_order - b.roster.sort_order ||
        Date.parse(a.roster.pinned_at ?? "") -
          Date.parse(b.roster.pinned_at ?? "") ||
        a.id - b.id
    )
  const unpinned = shown.filter((e) => !e.roster?.pinned_at)
  const bySection = new Map<string, RosterEntry[]>()
  const rest: RosterEntry[] = []
  for (const e of unpinned) {
    const name = e.roster?.section?.trim()
    if (name) {
      const list = bySection.get(name) ?? []
      list.push(e)
      bySection.set(name, list)
    } else {
      rest.push(e)
    }
  }
  const sections = [...bySection.entries()]
    .sort(([a], [b]) => a.localeCompare(b, locale))
    .map(([name, list]) => ({
      name,
      entries: list.sort(byTierThenRecent(now)),
    }))
  rest.sort(byTierThenRecent(now))
  return { primary, pinned, sections, rest, hidden }
}

/** Every assistant shown, in the roster's order (the primary first, the
 *  hidden ones left out): what ⌘1–⌘9 and ⌥↑/⌥↓ walk. */
export function rosterOrder(
  entries: readonly RosterEntry[],
  now: number,
  locale?: string
): RosterEntry[] {
  const g = groupRoster(entries, now, locale)
  return [
    ...(g.primary ? [g.primary] : []),
    ...g.pinned,
    ...g.sections.flatMap((s) => s.entries),
    ...g.rest,
  ]
}

/** The groups the owner made, by name: what "Move to group" offers. */
export function sectionNames(
  entries: readonly RosterEntry[],
  locale?: string
): string[] {
  const names = new Set<string>()
  for (const e of entries) {
    const n = e.roster?.section?.trim()
    if (n) names.add(n)
  }
  return [...names].sort((a, b) => a.localeCompare(b, locale))
}
