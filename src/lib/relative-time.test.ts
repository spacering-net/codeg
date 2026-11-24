import { describe, expect, it } from "vitest"

import { formatTimeAgo } from "./relative-time"

const NOW = Date.parse("2026-06-12T12:00:00.000Z")
const MIN = 60_000

describe("formatTimeAgo", () => {
  it("counts in the largest whole unit", () => {
    expect(formatTimeAgo(NOW - 6 * MIN - 20_000, NOW, "en")).toBe(
      "6 minutes ago"
    )
    expect(formatTimeAgo(NOW - 3 * 60 * MIN, NOW, "en")).toBe("3 hours ago")
    expect(formatTimeAgo(NOW - 24 * 60 * MIN, NOW, "en")).toBe("yesterday")
    expect(formatTimeAgo(NOW - 400 * 24 * 60 * MIN, NOW, "en")).toBe(
      "last year"
    )
  })

  it("reads under a minute, or a time ahead, as now", () => {
    expect(formatTimeAgo(NOW - 59_000, NOW, "en")).toBe("now")
    expect(formatTimeAgo(NOW + 5 * MIN, NOW, "en")).toBe("now")
  })

  it("speaks the locale's words", () => {
    expect(formatTimeAgo(NOW - 6 * MIN, NOW, "zh-CN")).toBe("6分钟前")
  })
})
