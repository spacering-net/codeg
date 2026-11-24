import { describe, expect, it } from "vitest"
import { taskMatchesTimeRange } from "./tasks-time-filter"

const NOW = Date.parse("2026-11-16T12:00:00Z")
const HOUR_MS = 60 * 60 * 1000

describe("taskMatchesTimeRange", () => {
  it.each([
    ["24h", 24],
    ["7d", 7 * 24],
    ["30d", 30 * 24],
  ] as const)("includes the exact rolling %s boundary", (range, hours) => {
    const cutoff = NOW - hours * HOUR_MS
    for (const [offset, expected] of [
      [-1, false],
      [0, true],
      [1, true],
    ] as const) {
      const task = { updated_at: new Date(cutoff + offset).toISOString() }
      expect(taskMatchesTimeRange(task, range, NOW)).toBe(expected)
    }
  })

  it("compares instants across time zones", () => {
    expect(
      taskMatchesTimeRange(
        { updated_at: "2026-11-15T20:00:00+08:00" },
        "24h",
        NOW
      )
    ).toBe(true)
    expect(
      taskMatchesTimeRange(
        { updated_at: "2026-11-15T19:59:59+08:00" },
        "24h",
        NOW
      )
    ).toBe(false)
  })

  it("excludes invalid dates from recent windows, while all time keeps every task", () => {
    expect(taskMatchesTimeRange({ updated_at: "invalid" }, "24h", NOW)).toBe(
      false
    )
    expect(taskMatchesTimeRange({ updated_at: "invalid" }, "all", NOW)).toBe(
      true
    )
    expect(
      taskMatchesTimeRange({ updated_at: "2020-01-01T00:00:00Z" }, "all", NOW)
    ).toBe(true)
  })
})
