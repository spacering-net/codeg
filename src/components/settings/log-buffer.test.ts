import { describe, expect, it } from "vitest"

import { applyLogBatch, PendingLogBatch } from "./log-buffer"
import type { LogRecord } from "@/lib/types"

function rec(seq: number, message = "m"): LogRecord {
  return {
    seq,
    timestamp_ms: seq,
    level: "INFO",
    target: "t",
    message,
    fields: {},
    spans: [],
  }
}

describe("PendingLogBatch", () => {
  it("keeps the newest unique records in sequence after wrapping", () => {
    const pending = new PendingLogBatch(3)
    for (const seq of [1, 2, 3, 4, 4, 2, 5]) pending.append(rec(seq))

    expect(pending.drain().map((r) => r.seq)).toEqual([3, 4, 5])
    expect(pending.drain()).toEqual([])
    pending.append(rec(6))
    expect(pending.drain().map((r) => r.seq)).toEqual([6])
  })
})

describe("applyLogBatch", () => {
  it("appends fresh records in order", () => {
    const prev = [rec(1), rec(2)]
    const next = applyLogBatch(prev, [rec(3), rec(4)], 100)
    expect(next.map((r) => r.seq)).toEqual([1, 2, 3, 4])
  })

  it("fills from an empty list", () => {
    const next = applyLogBatch([], [rec(1), rec(2)], 100)
    expect(next.map((r) => r.seq)).toEqual([1, 2])
  })

  it("drops records at or below the newest held seq (snapshot/live overlap)", () => {
    const prev = [rec(1), rec(2), rec(3)]
    const next = applyLogBatch(prev, [rec(2), rec(3), rec(4)], 100)
    expect(next.map((r) => r.seq)).toEqual([1, 2, 3, 4])
  })

  it("dedups within a single batch", () => {
    const next = applyLogBatch([], [rec(1), rec(1), rec(2)], 100)
    expect(next.map((r) => r.seq)).toEqual([1, 2])
  })

  it("trims the oldest records beyond the limit", () => {
    const prev = [rec(1), rec(2), rec(3)]
    const next = applyLogBatch(prev, [rec(4), rec(5)], 3)
    expect(next.map((r) => r.seq)).toEqual([3, 4, 5])
  })

  it("returns the same reference when nothing fresh is added", () => {
    const prev = [rec(5)]
    expect(applyLogBatch(prev, [rec(3), rec(5)], 100)).toBe(prev)
    expect(applyLogBatch(prev, [], 100)).toBe(prev)
  })
})
