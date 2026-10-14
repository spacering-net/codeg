import { describe, expect, it } from "vitest"

import {
  headlinePlanLimit,
  isPlanLimitReset,
  mergePlanLimits,
  PLAN_LIMITS_STALE_AFTER_SECONDS,
  planLimitTone,
  planLimitsStaleSince,
  timeUntil,
} from "./plan-limits"
import type { PlanLimitWindow } from "@/lib/types"

const NOW = 1_791_000_000

function fiveHour(over: Partial<PlanLimitWindow> = {}): PlanLimitWindow {
  return {
    kind: "five_hour",
    used_percent: 40,
    resets_at: NOW + 2 * 3600,
    window_minutes: 300,
    ...over,
  }
}

function weekly(over: Partial<PlanLimitWindow> = {}): PlanLimitWindow {
  return {
    kind: "seven_day",
    used_percent: 20,
    resets_at: NOW + 3 * 86_400,
    window_minutes: 10_080,
    ...over,
  }
}

describe("mergePlanLimits", () => {
  it("adds windows it did not have, shortest first", () => {
    const merged = mergePlanLimits([weekly()], [fiveHour()])
    expect(merged.map((w) => w.kind)).toEqual(["five_hour", "seven_day"])
  })

  it("keeps the later report of a window and ignores an earlier one", () => {
    const held = [fiveHour({ used_percent: 40 })]
    // Usage only grows within one window: a lower share is an older report.
    expect(mergePlanLimits(held, [fiveHour({ used_percent: 30 })])).toBe(held)
    expect(mergePlanLimits(held, [fiveHour({ used_percent: 55 })])).toEqual([
      fiveHour({ used_percent: 55 }),
    ])
  })

  it("takes a status change at the same share", () => {
    const held = [fiveHour({ used_percent: 80, status: "allowed" })]
    expect(
      mergePlanLimits(held, [
        fiveHour({ used_percent: 80, status: "allowed_warning" }),
      ])[0].status
    ).toBe("allowed_warning")
  })

  it("lets a new window replace the old one even at a lower share", () => {
    const held = [fiveHour({ used_percent: 95 })]
    const next = fiveHour({ used_percent: 3, resets_at: NOW + 5 * 3600 })
    expect(mergePlanLimits(held, [next])).toEqual([next])
    // …and never lets the previous window come back.
    expect(mergePlanLimits([next], held)).toEqual([next])
  })

  it("returns what it held when nothing changes", () => {
    const held = [fiveHour(), weekly()]
    expect(mergePlanLimits(held, [fiveHour()])).toBe(held)
    expect(mergePlanLimits(held, [])).toBe(held)
    expect(mergePlanLimits(held, undefined)).toBe(held)
  })
})

describe("planLimitTone", () => {
  it("warns from 80% and stops at the limit", () => {
    expect(planLimitTone(fiveHour({ used_percent: 79.9 }))).toBe("normal")
    expect(planLimitTone(fiveHour({ used_percent: 80 }))).toBe("warning")
    expect(planLimitTone(fiveHour({ used_percent: 100 }))).toBe("reached")
  })

  it("follows the agent's own verdict when it gives one", () => {
    expect(
      planLimitTone(fiveHour({ used_percent: 50, status: "allowed_warning" }))
    ).toBe("warning")
    expect(planLimitTone(fiveHour({ status: "rejected" }))).toBe("reached")
    expect(planLimitTone({ kind: "overage" })).toBe("normal")
  })
})

describe("headlinePlanLimit", () => {
  it("shows the window closest to its limit", () => {
    const busyWeek = weekly({ used_percent: 85 })
    expect(headlinePlanLimit([fiveHour(), busyWeek], NOW)).toBe(busyWeek)

    const blocked = fiveHour({ used_percent: 100, status: "rejected" })
    expect(headlinePlanLimit([blocked, busyWeek], NOW)).toBe(blocked)
  })

  it("breaks a tie on the sooner reset", () => {
    const soon = fiveHour({ used_percent: 20 })
    expect(headlinePlanLimit([weekly({ used_percent: 20 }), soon], NOW)).toBe(
      soon
    )
  })

  it("skips windows that have reset or have no reset time", () => {
    const over = fiveHour({ used_percent: 99, resets_at: NOW - 60 })
    const timeless = { kind: "overage", used_percent: 90 }
    const week = weekly()
    expect(isPlanLimitReset(over, NOW)).toBe(true)
    expect(headlinePlanLimit([over, timeless, week], NOW)).toBe(week)
    expect(headlinePlanLimit([over, timeless], NOW)).toBeNull()
  })
})

describe("planLimitsStaleSince", () => {
  it("says nothing for figures without a recording time (Claude's live ones)", () => {
    expect(planLimitsStaleSince([fiveHour(), weekly()], NOW)).toBeNull()
    expect(planLimitsStaleSince([], NOW)).toBeNull()
  })

  it("waits as long as Codex does before calling figures stale", () => {
    expect(PLAN_LIMITS_STALE_AFTER_SECONDS).toBe(15 * 60)
  })

  it("stays quiet while the figures are recent", () => {
    const recorded = NOW - PLAN_LIMITS_STALE_AFTER_SECONDS
    expect(
      planLimitsStaleSince([fiveHour({ observed_at: recorded })], NOW)
    ).toBeNull()
  })

  it("names when older figures were recorded", () => {
    const recorded = NOW - PLAN_LIMITS_STALE_AFTER_SECONDS - 1
    expect(
      planLimitsStaleSince(
        [
          fiveHour({ observed_at: recorded - 600 }),
          weekly({ observed_at: recorded }),
        ],
        NOW
      )
    ).toBe(recorded)
  })
})

describe("timeUntil", () => {
  it("splits the wait into whole days, hours and minutes", () => {
    expect(timeUntil(NOW + 2 * 86_400 + 5 * 3600 + 7 * 60 + 59, NOW)).toEqual({
      days: 2,
      hours: 5,
      minutes: 7,
    })
  })

  it("never goes negative", () => {
    expect(timeUntil(NOW - 600, NOW)).toEqual({
      days: 0,
      hours: 0,
      minutes: 0,
    })
  })
})
