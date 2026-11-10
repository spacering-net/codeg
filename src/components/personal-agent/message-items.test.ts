import { describe, expect, it } from "vitest"

import type { TimelineRow } from "@/lib/types"

import {
  buildMessageItems,
  drawnRowIds,
  isUnseen,
  newLineIndex,
  type MessageItem,
} from "./message-items"

function row(
  id: number,
  kind: TimelineRow["kind"],
  patch: Partial<TimelineRow> = {}
): TimelineRow {
  return {
    id,
    segment_id: 1,
    batch_id: null,
    kind,
    status: null,
    body: "",
    data: null,
    dispatch_id: null,
    ref_id: null,
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: `2026-11-04T10:00:${String(id % 60).padStart(2, "0")}Z`,
    updated_at: "2026-11-04T10:00:00Z",
    ...patch,
  }
}

function shape(items: MessageItem[]): string[] {
  return items.map((i) => {
    switch (i.kind) {
      case "time":
        return "time"
      case "owner":
        return `owner:${i.row.id}`
      case "event":
        return `event:${i.row.id}`
      case "notice":
        return `notice:${i.row.id}`
      case "reply":
        return `reply:${i.anchor.id}[${i.attached.map((a) => a.id).join(",")}]${i.row ? "" : "!"}`
      case "exchange":
        return `exchange:${i.rows.map((r) => r.id).join(",")}`
      case "mirror":
        return `mirror:${i.row.id}`
    }
  })
}

describe("lines between assistants", () => {
  const line = (id: number, patch: Partial<TimelineRow>) =>
    row(id, "exchange", {
      data: { direction: "out", peer: { id: 2, name: "Dev" } },
      ...patch,
    })

  it("puts what a turn wrote to others right before its conclusion", () => {
    const items = buildMessageItems([
      row(1, "owner", { batch_id: 7, status: "answered" }),
      row(2, "reply", { batch_id: 7, data: { state: "done" } }),
      line(3, { batch_id: 7 }),
      line(4, { batch_id: 7 }),
    ])
    expect(shape(items)).toEqual([
      "time",
      "owner:1",
      "exchange:3,4",
      "reply:2[]",
    ])
    // The reply starts a run under the line, as under a time line.
    const reply = items[3] as Extract<MessageItem, { kind: "reply" }>
    expect(reply.gap).toBe("side")
    // What is above the line closes its run.
    const owner = items[1] as Extract<MessageItem, { kind: "owner" }>
    expect(owner.tail).toBe(true)
  })

  it("draws a run of lines as one, and a line on its own in its place", () => {
    const items = buildMessageItems([
      row(1, "reply", { batch_id: 7, data: { state: "done" } }),
      line(2, { data: { direction: "in", peer: { id: 2, name: "Dev" } } }),
      line(3, { data: { direction: "in", peer: { id: 3, name: "Review" } } }),
      row(4, "reply", { batch_id: 8, data: { state: "done" } }),
    ])
    expect(shape(items)).toEqual([
      "time",
      "reply:1[]",
      "exchange:2,3",
      "reply:4[]",
    ])
    expect(drawnRowIds(items).has(3)).toBe(true)
    expect(newLineIndex(items, 3)).toBe(2)
  })

  it("shows another assistant's request on its own", () => {
    const items = buildMessageItems([
      row(1, "owner", { batch_id: 7, status: "answered" }),
      row(2, "question", {
        data: { state: "pending", mirror_of: { bot_id: 2, row_id: 9 } },
      }),
    ])
    expect(shape(items)).toEqual(["time", "owner:1", "mirror:2"])
  })
})

describe("buildMessageItems", () => {
  it("draws a native card on its own, on the assistants' side, as new", () => {
    const items = buildMessageItems([
      row(1, "owner", { batch_id: 7, status: "answered" }),
      row(2, "reply", { batch_id: 7, data: { state: "done" } }),
      row(3, "notice", {
        batch_id: 8,
        ref_id: "4",
        data: { notice: "proposal", state: "open" },
      }),
    ])
    expect(shape(items)).toEqual(["time", "owner:1", "reply:2[]", "notice:3"])
    const notice = items[3]
    expect(notice.kind === "notice" && notice.gap).toBe("near")
    expect(isUnseen(row(3, "notice"))).toBe(true)
    expect(
      isUnseen(row(3, "notice", { seen_at: "2026-11-07T00:00:00Z" }))
    ).toBe(false)
  })

  it("folds a turn's cards into its reply and leaves markers out", () => {
    const items = buildMessageItems([
      row(1, "owner", { batch_id: 7, status: "answered" }),
      row(2, "reply", { batch_id: 7, data: { state: "done" } }),
      row(3, "dispatch", { batch_id: 7, dispatch_id: 1 }),
      row(4, "permission", { batch_id: 7 }),
      row(5, "marker", { data: { marker: "compaction" } }),
      row(6, "result", { dispatch_id: 1 }),
    ])
    expect(shape(items)).toEqual(["time", "owner:1", "reply:2[3,4]", "event:6"])
    const reply = items.find((i) => i.kind === "reply")
    expect(reply?.kind === "reply" && reply.owners.map((o) => o.id)).toEqual([
      1,
    ])
  })

  it("draws a phase-one turn with no reply at its first card, and one with a reply at the reply", () => {
    const items = buildMessageItems([
      row(10, "dispatch", { batch_id: 3, dispatch_id: 1 }),
      row(11, "dispatch", { batch_id: 3, dispatch_id: 2 }),
      row(12, "dispatch", { batch_id: 4, dispatch_id: 3 }),
      row(13, "reply", { batch_id: 4, body: "Sent it.", data: null }),
    ])
    expect(shape(items)).toEqual(["time", "reply:10[10,11]!", "reply:13[12]"])
  })

  it("treats a discarded reply as absent", () => {
    const items = buildMessageItems([
      row(1, "owner", { batch_id: 9, status: "queued" }),
      row(2, "reply", { batch_id: 9, data: { state: "discarded" } }),
    ])
    expect(shape(items)).toEqual(["time", "owner:1"])
  })

  it("closes each side's run with its last message", () => {
    const items = buildMessageItems([
      row(1, "owner", { status: "answered" }),
      row(2, "owner", { status: "answered" }),
      row(3, "reply", { batch_id: 1, data: { state: "done" } }),
      row(4, "owner", { status: "queued" }),
    ])
    expect(items.flatMap((i) => (i.kind === "time" ? [] : [i.tail]))).toEqual([
      false,
      true,
      true,
      true,
    ])
  })

  it("spaces messages by side, and gives the last on a side its actions", () => {
    const items = buildMessageItems([
      row(1, "owner", { status: "answered" }),
      row(2, "owner", { status: "answered" }),
      row(3, "reply", { batch_id: 1, data: { state: "done" } }),
      row(4, "reply", { batch_id: 2, data: { state: "done" } }),
      row(5, "result", {
        dispatch_id: 5,
        data: { executor_id: 6, executor: "#6" },
      }),
      row(6, "owner", { status: "queued" }),
      row(7, "owner", {
        status: "queued",
        created_at: "2026-11-04T11:00:00Z",
      }),
    ])
    const placed = items.flatMap((i) =>
      i.kind === "time" ? [] : [`${i.gap}${i.tail ? "+tail" : ""}`]
    )
    expect(placed).toEqual([
      "side",
      // The owner's two: only the second floats its actions, over the room
      // the assistant starts below.
      "near+tail",
      "side",
      "near",
      // Another speaker on the same side sits as close: the news card is
      // the last on the side, not the reply above it.
      "near+tail",
      "side+tail",
      // After a time line: its own room, and the last of all.
      "near+tail",
    ])
  })

  it("puts a time line between messages far apart or on another day", () => {
    const items = buildMessageItems([
      row(1, "owner", { created_at: "2026-11-04T10:00:00Z" }),
      row(2, "owner", { created_at: "2026-11-04T10:03:00Z" }),
      row(3, "owner", { created_at: "2026-11-04T10:30:00Z" }),
    ])
    expect(shape(items)).toEqual([
      "time",
      "owner:1",
      "owner:2",
      "time",
      "owner:3",
    ])
    // A time line ends a run: the message above it closes the one before.
    expect(items.flatMap((i) => (i.kind === "time" ? [] : [i.tail]))).toEqual([
      false,
      true,
      true,
    ])
  })

  it("runs news cards and replies on their side together, whoever speaks", () => {
    const card = (id: number, executor: number) =>
      row(id, "result", {
        dispatch_id: id,
        data: { executor_id: executor, executor: `#${executor}` },
      })
    const items = buildMessageItems([
      card(1, 5),
      card(2, 5),
      card(3, 6),
      row(4, "reply", { batch_id: 9, data: { state: "done" } }),
      card(5, 6),
    ])
    // One run: close together, the last one closing it.
    expect(
      items.flatMap((i) =>
        i.kind === "time" ? [] : [`${i.gap}${i.tail ? "+tail" : ""}`]
      )
    ).toEqual(["side", "near", "near", "near", "near+tail"])
  })

  it("leaves out a quote of the message right above, but not the owner's", () => {
    const items = buildMessageItems([
      row(1, "owner", { batch_id: 7, status: "answered" }),
      row(2, "reply", { batch_id: 7, data: { state: "done" } }),
      row(3, "dispatch", { batch_id: 7, dispatch_id: 1 }),
      // News quoting the reply that dispatched it, drawn right under it.
      row(4, "result", { dispatch_id: 1, reply_to: 2 }),
      // The reply to that news, quoting it.
      row(5, "reply", { batch_id: 8, data: { state: "done" }, reply_to: 4 }),
      // The owner quoting the reply right above: drawn anyway.
      row(6, "owner", { reply_to: 5 }),
      // A reply quoting a message further up.
      row(7, "reply", { batch_id: 9, data: { state: "done" }, reply_to: 1 }),
    ])
    const quotes = items.flatMap((i) =>
      i.kind === "time" ? [] : [[i.kind, i.quotesPrevious]]
    )
    expect(quotes).toEqual([
      ["owner", false],
      ["reply", false],
      ["event", true],
      ["reply", true],
      ["owner", false],
      ["reply", false],
    ])
  })

  it("lists every row a jump can land on", () => {
    const items = buildMessageItems([
      row(2, "reply", { batch_id: 7, data: { state: "done" } }),
      row(3, "dispatch", { batch_id: 7, dispatch_id: 1 }),
    ])
    expect([...drawnRowIds(items)].sort()).toEqual([2, 3])
  })
})

describe("isUnseen", () => {
  const SEEN = "2026-11-04T10:05:00Z"

  it("counts a result card and a reply once it settled, as the server does", () => {
    expect(isUnseen(row(1, "result"))).toBe(true)
    for (const state of ["done", "canceled", "interrupted"]) {
      expect(isUnseen(row(2, "reply", { data: { state } }))).toBe(true)
    }
    // A phase-one reply, with no state.
    expect(isUnseen(row(3, "reply", { body: "hi" }))).toBe(true)
  })

  it("leaves out a reply still running or never sent, the owner's own, and what was seen", () => {
    expect(isUnseen(row(1, "reply", { data: { state: "running" } }))).toBe(
      false
    )
    expect(isUnseen(row(2, "reply", { data: { state: "discarded" } }))).toBe(
      false
    )
    expect(isUnseen(row(3, "owner"))).toBe(false)
    expect(isUnseen(row(4, "dispatch"))).toBe(false)
    expect(isUnseen(row(5, "result", { seen_at: SEEN }))).toBe(false)
    expect(
      isUnseen(row(6, "reply", { data: { state: "done" }, seen_at: SEEN }))
    ).toBe(false)
  })
})

describe("newLineIndex", () => {
  it("goes above the time line that heads the first new message", () => {
    const items = buildMessageItems([
      row(1, "owner", { created_at: "2026-11-04T09:00:00Z" }),
      // Later than the time gap: a time line of its own.
      row(2, "reply", {
        batch_id: 7,
        data: { state: "done" },
        created_at: "2026-11-04T10:00:00Z",
      }),
    ])
    const at = newLineIndex(items, 2)
    expect(items[at]).toMatchObject({ kind: "time" })
    expect(items[at + 1]).toMatchObject({ kind: "reply" })
  })

  it("goes right above the message when no time line heads it", () => {
    const items = buildMessageItems([
      row(1, "owner"),
      row(2, "reply", { batch_id: 7, data: { state: "done" } }),
      row(3, "result", { dispatch_id: 1 }),
    ])
    const at = newLineIndex(items, 3)
    expect(items[at]).toMatchObject({ kind: "event" })
    expect(items[at - 1]).toMatchObject({ kind: "reply" })
  })

  it("finds nothing for a row no item draws", () => {
    const items = buildMessageItems([row(1, "owner")])
    expect(newLineIndex(items, 9)).toBe(-1)
  })
})
