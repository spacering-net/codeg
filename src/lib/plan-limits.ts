import type { PlanLimitWindow } from "@/lib/types"

/**
 * Subscription plan usage windows, as the agents report them (see
 * `PlanLimitWindow`). Shared by the connection store, which folds live reports
 * in, and the composer's plan-limits indicator, which picks what to show.
 */

function sameWindow(a: PlanLimitWindow, b: PlanLimitWindow): boolean {
  return (
    a.kind === b.kind &&
    (a.used_percent ?? null) === (b.used_percent ?? null) &&
    (a.resets_at ?? null) === (b.resets_at ?? null) &&
    (a.window_minutes ?? null) === (b.window_minutes ?? null) &&
    (a.status ?? null) === (b.status ?? null) &&
    (a.observed_at ?? null) === (b.observed_at ?? null)
  )
}

/**
 * Whether `incoming` should replace `held`, a window of the same kind — the
 * backend's rule (`supersedes` in `acp::plan_limits`). A later reset time is a
 * newer window; within one window usage only grows, so the higher share is the
 * later report. Anything else is stale and ignored.
 */
function supersedes(incoming: PlanLimitWindow, held: PlanLimitWindow): boolean {
  if (sameWindow(incoming, held)) return false
  const resets = (w: PlanLimitWindow) => w.resets_at ?? Number.NEGATIVE_INFINITY
  const used = (w: PlanLimitWindow) =>
    w.used_percent ?? Number.NEGATIVE_INFINITY
  if (resets(incoming) !== resets(held)) {
    return resets(incoming) > resets(held)
  }
  return used(incoming) >= used(held)
}

/** Shortest window first (5-hour, then weekly), unknown lengths last, then by
 *  name — the backend's order. */
export function sortPlanLimits(windows: PlanLimitWindow[]): PlanLimitWindow[] {
  return [...windows].sort(
    (a, b) =>
      (a.window_minutes ?? Number.MAX_SAFE_INTEGER) -
        (b.window_minutes ?? Number.MAX_SAFE_INTEGER) ||
      a.kind.localeCompare(b.kind)
  )
}

/**
 * Folds reported windows into the held set: each replaces the held window of
 * its kind when it supersedes it, the rest stay. Returns `held` itself when
 * nothing changed, so a store can skip the update.
 */
export function mergePlanLimits(
  held: PlanLimitWindow[],
  incoming: PlanLimitWindow[] | null | undefined
): PlanLimitWindow[] {
  if (!incoming || incoming.length === 0) return held
  let next: PlanLimitWindow[] | null = null
  for (const window of incoming) {
    const base: PlanLimitWindow[] = next ?? held
    const index = base.findIndex((w) => w.kind === window.kind)
    if (index !== -1 && !supersedes(window, base[index])) continue
    next =
      index === -1
        ? [...base, window]
        : base.map((w, i) => (i === index ? window : w))
  }
  return next ? sortPlanLimits(next) : held
}

/** How old recorded figures may be before the plan may have moved on without
 *  them — Codex's own threshold for calling its limits stale. */
export const PLAN_LIMITS_STALE_AFTER_SECONDS = 15 * 60

/**
 * When the figures were recorded, if that is long enough ago that other
 * sessions may have used the plan since: Codex's figures come from this
 * conversation's own transcript, so a conversation opened long after its last
 * turn shows that turn's. `null` when they are recent or carry no time
 * (Claude's live reports).
 */
export function planLimitsStaleSince(
  windows: PlanLimitWindow[],
  nowSeconds: number
): number | null {
  let latest: number | null = null
  for (const window of windows) {
    const observed = window.observed_at ?? null
    if (observed != null && (latest == null || observed > latest)) {
      latest = observed
    }
  }
  return latest != null && nowSeconds - latest > PLAN_LIMITS_STALE_AFTER_SECONDS
    ? latest
    : null
}

/** A window whose reset time has passed: its usage figure no longer holds. */
export function isPlanLimitReset(
  window: PlanLimitWindow,
  nowSeconds: number
): boolean {
  return window.resets_at != null && window.resets_at <= nowSeconds
}

export type PlanLimitTone = "normal" | "warning" | "reached"

/** `reached` at the limit, `warning` close to it (Claude says so, or 80%+). */
export function planLimitTone(window: PlanLimitWindow): PlanLimitTone {
  const used = window.used_percent ?? null
  if (window.status === "rejected" || (used != null && used >= 100)) {
    return "reached"
  }
  if (window.status === "allowed_warning" || (used != null && used >= 80)) {
    return "warning"
  }
  return "normal"
}

const TONE_RANK: Record<PlanLimitTone, number> = {
  reached: 2,
  warning: 1,
  normal: 0,
}

/**
 * The window worth showing at a glance: among those still current and with a
 * reset time, the one closest to its limit — a reached limit first, then the
 * highest share used — ties going to the sooner reset. `null` when nothing
 * current has a reset time.
 */
export function headlinePlanLimit(
  windows: PlanLimitWindow[],
  nowSeconds: number
): PlanLimitWindow | null {
  let best: PlanLimitWindow | null = null
  for (const window of windows) {
    if (window.resets_at == null || isPlanLimitReset(window, nowSeconds)) {
      continue
    }
    if (best == null) {
      best = window
      continue
    }
    const byTone =
      TONE_RANK[planLimitTone(window)] - TONE_RANK[planLimitTone(best)]
    const byUse = (window.used_percent ?? -1) - (best.used_percent ?? -1)
    const bySooner = (best.resets_at ?? 0) - window.resets_at
    if (byTone !== 0 ? byTone > 0 : byUse !== 0 ? byUse > 0 : bySooner > 0) {
      best = window
    }
  }
  return best
}

/** Whole days, hours and minutes until `resetsAt` (never negative). */
export function timeUntil(
  resetsAt: number,
  nowSeconds: number
): { days: number; hours: number; minutes: number } {
  const total = Math.max(0, Math.floor((resetsAt - nowSeconds) / 60))
  return {
    days: Math.floor(total / (24 * 60)),
    hours: Math.floor((total % (24 * 60)) / 60),
    minutes: total % 60,
  }
}
