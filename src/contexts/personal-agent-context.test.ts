import { describe, expect, it } from "vitest"

import { mergeRows } from "./personal-agent-context"
import type { TimelineRow } from "@/lib/types"

function row(id: number, updated: string, body = `r${id}`): TimelineRow {
  return {
    id,
    segment_id: 1,
    batch_id: null,
    kind: "owner",
    status: "queued",
    body,
    data: null,
    dispatch_id: null,
    ref_id: null,
    created_at: "2026-11-03T00:00:00Z",
    updated_at: updated,
  }
}

describe("mergeRows", () => {
  it("keeps id order whatever order rows arrive in", () => {
    const merged = mergeRows(
      [row(3, "2026-11-03T00:00:03Z")],
      [row(1, "2026-11-03T00:00:01Z"), row(2, "2026-11-03T00:00:02Z")]
    )
    expect(merged.map((r) => r.id)).toEqual([1, 2, 3])
  })

  it("takes the newer copy of a row", () => {
    const merged = mergeRows(
      [row(1, "2026-11-03T00:00:01Z", "old")],
      [row(1, "2026-11-03T00:00:05Z", "new")]
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].body).toBe("new")
  })

  it("never rolls a row back to an older broadcast", () => {
    const merged = mergeRows(
      [row(1, "2026-11-03T00:00:05Z", "answered")],
      [row(1, "2026-11-03T00:00:01Z", "queued")]
    )
    expect(merged[0].body).toBe("answered")
  })

  it("returns the held rows unchanged when nothing arrives", () => {
    const held = [row(1, "2026-11-03T00:00:01Z")]
    expect(mergeRows(held, [])).toBe(held)
  })
})
