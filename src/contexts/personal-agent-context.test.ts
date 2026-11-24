import { describe, expect, it } from "vitest"

import { mergeRows, movesUnseen } from "./personal-agent-context"
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
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
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

describe("stampKey", () => {
  it("sorts server stamps whatever fraction they carry", async () => {
    const { stampKey, newestStamp } = await import("./personal-agent-context")
    // As written, "…:00Z" would sort after "…:00.5Z".
    expect(
      stampKey("2026-11-04T05:10:00Z") < stampKey("2026-11-04T05:10:00.5Z")
    ).toBe(true)
    expect(
      stampKey("2026-11-04T05:10:00.123456Z") <
        stampKey("2026-11-04T05:10:00.1235Z")
    ).toBe(true)
    expect(stampKey("2026-11-04 05:10:00+00:00")).toBe(
      stampKey("2026-11-04T05:10:00Z")
    )
    expect(
      newestStamp([
        row(1, "2026-11-04T05:10:00.5Z"),
        row(2, "2026-11-04T05:10:00Z"),
      ])
    ).toBe("2026-11-04T05:10:00.5Z")
  })

  it("lets a newer write replace a row across fraction lengths", () => {
    const merged = mergeRows(
      [row(1, "2026-11-04T05:10:00Z", "old")],
      [row(1, "2026-11-04T05:10:00.5Z", "new")]
    )
    expect(merged[0].body).toBe("new")
  })
})

describe("movesUnseen", () => {
  const as = (patch: Partial<TimelineRow>): TimelineRow => ({
    ...row(1, "2026-11-04T10:00:00Z"),
    ...patch,
  })

  it("is a result card, or a reply that is no longer running", () => {
    expect(movesUnseen(as({ kind: "result" }))).toBe(true)
    expect(movesUnseen(as({ kind: "reply", data: { state: "done" } }))).toBe(
      true
    )
  })

  it("is not a running reply's progress, nor the owner's own message", () => {
    expect(movesUnseen(as({ kind: "reply", data: { state: "running" } }))).toBe(
      false
    )
    expect(
      movesUnseen(as({ kind: "reply", data: { state: "discarded" } }))
    ).toBe(false)
    expect(movesUnseen(as({ kind: "owner" }))).toBe(false)
  })
})
