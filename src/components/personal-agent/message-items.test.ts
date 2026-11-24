import { describe, expect, it } from "vitest"

import type { TimelineRow } from "@/lib/types"

import {
  buildMessageItems,
  drawnRowIds,
  listRowsOf,
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
      case "said":
        return `said:${i.row.id}(${i.text})`
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

  /** A line the turn wrote at step `n`, after the text `said` (step
   *  `saidN`). */
  const sent = (id: number, n: number, said?: [number, string]) =>
    line(id, {
      batch_id: 7,
      data: {
        direction: "out",
        peer: { id: 2, name: "Dev" },
        turn: {
          n,
          said: said ? { n: said[0], text: said[1] } : null,
        },
      },
    })

  it("puts a line after the text the turn wrote before sending it", () => {
    // "I'll hand it to Dev." (step 1), a read (2), the message (3), then
    // the reply's body (step 4).
    const done = row(2, "reply", {
      batch_id: 7,
      body: "Dev has it.\n\nIt will report back.",
      data: { state: "done", last_text_n: 4 },
    })
    const items = buildMessageItems([
      row(1, "owner", { batch_id: 7, status: "answered" }),
      done,
      sent(3, 3, [1, "I'll hand it to Dev."]),
    ])
    expect(shape(items)).toEqual([
      "time",
      "owner:1",
      "said:3(I'll hand it to Dev.)",
      "exchange:3",
      "reply:2[]",
    ])
    const said = items[2] as Extract<MessageItem, { kind: "said" }>
    // Its own side's run starts under the owner's message, and closes
    // round over the line.
    expect(said.gap).toBe("side")
    expect(said.tail).toBe(true)
    // It is no row of its own: the line draws row 3, and jumps land there.
    expect(drawnRowIds(items).has(3)).toBe(true)
    expect(newLineIndex(items, 3)).toBe(3)
    const reply = items[4] as Extract<MessageItem, { kind: "reply" }>
    expect(reply.saidNs).toEqual([1])
    expect(reply.gap).toBe("side")

    // While the turn runs it is the same: the text, the line, the bubble —
    // which does not draw that text again.
    const running = buildMessageItems([
      row(1, "owner", { batch_id: 7, status: "answered" }),
      row(2, "reply", { batch_id: 7, data: { state: "running" } }),
      sent(3, 3, [1, "I'll hand it to Dev."]),
    ])
    expect(shape(running)).toEqual(shape(items))
    expect(
      (running[4] as Extract<MessageItem, { kind: "reply" }>).saidNs
    ).toEqual([1])
  })

  it("draws the text once for a run of lines, and a new text before the next", () => {
    const items = buildMessageItems([
      row(2, "reply", {
        batch_id: 7,
        body: "All sent.",
        data: { state: "done", last_text_n: 7 },
      }),
      sent(3, 2, [1, "Asking both."]),
      sent(4, 3, [1, "Asking both."]),
      sent(5, 6, [5, "And one more thing."]),
    ])
    expect(shape(items)).toEqual([
      "time",
      "said:3(Asking both.)",
      "exchange:3,4",
      "said:5(And one more thing.)",
      "exchange:5",
      "reply:2[]",
    ])
    expect(
      (items[5] as Extract<MessageItem, { kind: "reply" }>).saidNs
    ).toEqual([1, 5])
  })

  it("puts a message sent after the last word under the reply", () => {
    // "Sent." (step 1) is the body; the message went at step 2.
    const items = buildMessageItems([
      row(1, "owner", { batch_id: 7, status: "answered" }),
      row(2, "reply", {
        batch_id: 7,
        body: "Sent.",
        data: { state: "done", last_text_n: 1 },
      }),
      sent(3, 2, [1, "Sent."]),
    ])
    expect(shape(items)).toEqual(["time", "owner:1", "reply:2[]", "exchange:3"])
    const reply = items[2] as Extract<MessageItem, { kind: "reply" }>
    // The body is not drawn twice, and closes its run over the line.
    expect(reply.saidNs).toEqual([])
    expect(reply.tail).toBe(true)
  })

  it("keeps a line that cannot say where it was written before the reply", () => {
    const items = buildMessageItems([
      row(2, "reply", {
        batch_id: 7,
        body: "Done.",
        data: { state: "done", last_text_n: 2 },
      }),
      line(3, { batch_id: 7 }),
      // A message sent before the turn wrote anything.
      sent(4, 1),
    ])
    expect(shape(items)).toEqual(["time", "exchange:3,4", "reply:2[]"])
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
    // A card of its own: room enough over it not to join the bubble above.
    expect(notice.kind === "notice" && notice.gap).toBe("card")
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
      // The news card is the last on the side, not the reply above it;
      // a card of its own, it keeps a little more room over it.
      "card+tail",
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
    ).toEqual(["side", "card", "card", "card", "card+tail"])
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

describe("listRowsOf", () => {
  const line = (id: number, patch: Partial<TimelineRow>) =>
    row(id, "exchange", {
      data: { direction: "out", peer: { id: 2, name: "Dev" } },
      ...patch,
    })
  const shapeOf = (rows: ReturnType<typeof listRowsOf>) =>
    rows.map((r) => [
      shape([r.item])[0],
      r.key === r.item.key,
      r.newLine,
      r.underLine,
    ])

  it("draws each item a row, keyed as the item, saying what is under a line", () => {
    const items = buildMessageItems([
      row(1, "owner", { batch_id: 7, status: "answered" }),
      row(2, "reply", { batch_id: 7, data: { state: "done" } }),
      line(3, { batch_id: 7 }),
      line(4, { batch_id: 7 }),
    ])
    expect(shapeOf(listRowsOf(items, -1))).toEqual([
      ["time", true, false, false],
      ["owner:1", true, false, true],
      ["exchange:3,4", true, false, false],
      ["reply:2[]", true, false, true],
    ])
  })

  it("keeps an item's row when older messages take the time line over it", () => {
    // Its key is its own, not the time line's: what is in it (an answer
    // being typed into a card) stays.
    const reply = (more: TimelineRow[]) =>
      listRowsOf(
        buildMessageItems([
          ...more,
          row(100, "reply", {
            batch_id: 7,
            data: { state: "done" },
            created_at: "2026-11-04T10:00:40Z",
          }),
        ]),
        -1
      ).find((r) => r.item.kind === "reply")!
    const alone = reply([])
    const after = reply([
      row(99, "owner", { created_at: "2026-11-04T10:00:39Z" }),
    ])
    expect(alone.underLine).toBe(true)
    expect(after.underLine).toBe(false)
    expect(after.key).toBe(alone.key)
  })

  it("puts the new-messages line in the row of the item it goes over", () => {
    const items = buildMessageItems([
      row(1, "owner", { created_at: "2026-11-04T09:00:00Z" }),
      row(2, "reply", {
        batch_id: 7,
        data: { state: "done" },
        created_at: "2026-11-04T10:00:00Z",
      }),
    ])
    // time, owner:1, time, reply:2 — new from the reply: over its time line.
    const rows = listRowsOf(items, newLineIndex(items, 2))
    expect(rows.map((r) => r.newLine)).toEqual([false, false, true, false])
    expect(rows[2].item.kind).toBe("time")
  })
})

describe("the news of a piece of work", () => {
  it("marks the latest news of each piece of work, wherever it sits", () => {
    const items = buildMessageItems([
      row(1, "result", { dispatch_id: 5 }),
      row(2, "result", { dispatch_id: 6 }),
      row(3, "owner", { body: "ok" }),
      row(4, "result", { dispatch_id: 5 }),
      row(5, "result", {}),
    ])
    const latest = Object.fromEntries(
      items.flatMap((i) => (i.kind === "event" ? [[i.row.id, i.latest]] : []))
    )
    // #5's second card carries its task card; #6's only one does; a card of
    // no dispatch carries none.
    expect(latest).toEqual({ 1: false, 2: true, 4: true, 5: false })
  })
})

describe("an executor's question (7.3.1)", () => {
  it("stands as a card of its own after its work's news, and is not news itself", () => {
    const result = row(1, "result", { dispatch_id: 5 })
    const asked = row(2, "notice", {
      dispatch_id: 5,
      data: { notice: "ask", state: "asking", dispatch_id: 5 },
    })
    const mirrored = row(3, "notice", {
      data: {
        notice: "ask",
        state: "forwarded",
        dispatch_id: 5,
        mirror_of: { bot_id: 4, row_id: 2, ask_id: 12 },
      },
    })
    const items = buildMessageItems([result, asked, mirrored])
    expect(shape(items)).toEqual(["time", "event:1", "notice:2", "notice:3"])
    // The work's news stays the latest news of it: the card is not news.
    const news = items.find((i) => i.kind === "event")
    expect(news?.kind === "event" && news.latest).toBe(true)
  })
})

describe("result cards a reply reported (A1)", () => {
  const reply = (
    id: number,
    state: string,
    covers: unknown,
    body = "It is done."
  ) =>
    row(id, "reply", {
      batch_id: id,
      body,
      data: { state, ...(covers === undefined ? {} : { covers }) },
    })
  const covered = (rows: TimelineRow[]) =>
    Object.fromEntries(
      buildMessageItems(rows)
        .filter((i) => i.kind === "event")
        .map((i) => [i.row.id, i.kind === "event" && i.covered])
    )

  it("folds what a reply said in full reported, one reply many cards", () => {
    expect(
      covered([
        row(1, "result"),
        row(2, "result"),
        row(3, "result"),
        reply(4, "done", [1, 2]),
      ])
    ).toEqual({ 1: true, 2: true, 3: false })
  })

  it("keeps what an unfinished, unshown or older reply came after", () => {
    for (const r of [
      reply(4, "running", [1]),
      reply(4, "interrupted", [1]),
      reply(4, "canceled", [1]),
      reply(4, "silent", [1]),
      reply(4, "discarded", [1]),
      reply(4, "done", [1], "  "),
      // Written before replies said what they reported.
      reply(4, "done", undefined),
    ]) {
      expect(covered([row(1, "result"), r])).toEqual({ 1: false })
    }
  })
})

describe("the acceptance chain on its work's head (A4)", () => {
  const accepted = {
    notice: "acceptance",
    state: "acted",
    superseded: false,
    phase: "accepted",
    decided_by: "assistant",
    verdict: "pass",
    unchecked: false,
    dispatch_id: 3,
    round: 1,
  }
  const chain = (card: Record<string, unknown> = accepted) => [
    row(20, "result", { dispatch_id: 3, data: { state: "review" } }),
    row(21, "dispatch", {
      dispatch_id: 4,
      data: { check_for: 3, check_round: 1 },
    }),
    row(22, "result", {
      dispatch_id: 4,
      data: { check_for: 3, check_round: 1, verdict: "pass", evidence: "ok" },
    }),
    row(23, "reply", { batch_id: 9, data: { state: "done" }, body: "Passed." }),
    row(24, "notice", { data: card }),
  ]

  it("folds the check, what it found and a passed round's card into the head", () => {
    const items = buildMessageItems(chain())
    expect(shape(items).filter((s) => s !== "time")).toEqual([
      "event:20",
      "reply:23[]",
    ])
    const head = items.find((i) => i.kind === "event")!
    if (head.kind !== "event") throw new Error()
    expect(head.acceptance?.check?.id).toBe(21)
    expect(head.acceptance?.result?.id).toBe(22)
    expect(head.acceptance?.card?.id).toBe(24)
    // A jump to any of them lands on the head.
    const drawn = drawnRowIds(items)
    for (const id of [20, 21, 22, 24]) expect(drawn.has(id)).toBe(true)
  })

  it("keeps a card that asks the owner, one passed unverified or theirs to check again", () => {
    for (const card of [
      { ...accepted, state: "open", phase: "asked" },
      { ...accepted, unchecked: true },
      { ...accepted, state: "changed", phase: "changed" },
      { ...accepted, decided_by: "owner" },
      { ...accepted, superseded: true },
    ]) {
      const items = buildMessageItems(chain(card))
      expect(shape(items)).toContain("notice:24")
      // The check still folds.
      expect(shape(items)).not.toContain("event:22")
    }
  })

  it("stands on its own with its work's head on another page; a check of a message is not folded", () => {
    const [, check, result, reply, card] = chain()
    expect(
      shape(buildMessageItems([check, result, reply, card])).filter(
        (s) => s !== "time"
      )
    ).toEqual(["reply:21[21]!", "event:22", "reply:23[]", "notice:24"])
    const fact = row(30, "result", {
      dispatch_id: 8,
      data: { verdict: "pass" },
    })
    expect(shape(buildMessageItems([fact]))).toContain("event:30")
  })

  it("shows a later round's check under way without the last one's finding", () => {
    const items = buildMessageItems([
      ...chain(),
      row(25, "dispatch", {
        dispatch_id: 5,
        data: { check_for: 3, check_round: 2 },
      }),
    ])
    const head = items.find((i) => i.kind === "event")!
    if (head.kind !== "event") throw new Error()
    expect(head.acceptance?.check?.id).toBe(25)
    expect(head.acceptance?.result).toBeNull()
  })

  it("does not take a check run again in the same round for the one that passed", () => {
    // Checked again (the worktree changed): the same round, another check.
    const items = buildMessageItems([
      ...chain(),
      row(26, "dispatch", {
        dispatch_id: 6,
        data: { check_for: 3, check_round: 1 },
      }),
    ])
    const head = items.find((i) => i.kind === "event")!
    if (head.kind !== "event") throw new Error()
    expect(head.acceptance?.check?.id).toBe(26)
    expect(head.acceptance?.result).toBeNull()
  })

  it("marks the new-messages line at a work's head for what folded into it", () => {
    const items = buildMessageItems(chain())
    const at = newLineIndex(items, 22)
    expect(at).toBeGreaterThanOrEqual(0)
    const item = items[at].kind === "time" ? items[at + 1] : items[at]
    expect(item.kind === "event" && item.row.id).toBe(20)
  })
})
