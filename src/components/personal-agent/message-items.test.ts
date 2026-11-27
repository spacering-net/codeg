import { describe, expect, it } from "vitest"

import type { TimelineRow } from "@/lib/types"

import {
  buildMessageItems,
  drawnRowIds,
  listRowsOf,
  isUnseen,
  itemRowIds,
  newLineIndex,
  partEntries,
  type MessageItem,
} from "./message-items"
import { textsIn, turnTexts } from "./turn-texts"

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

/** What a part of a turn draws of its texts, as the page would from rows
 *  alone. */
function saidText(i: Extract<MessageItem, { kind: "said" }>): string {
  return textsIn(turnTexts(i.reply, undefined, i.part.lines), i.part)
    .map((t) => t.text)
    .join(" / ")
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
        return `said:${i.row.id}(${saidText(i)})`
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
    // The reply draws its own part only: what came after the line.
    expect(reply.part.lo).toBe(3)
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
      (running[4] as Extract<MessageItem, { kind: "reply" }>).part.lo
    ).toBe(3)
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
    expect(reply.part.hi).toBe(2)
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

describe("pills make way for their work's news (P6.3 5)", () => {
  // The owner asks to have something checked; the turn dispatches the check
  // (8); its news (9) comes later — reported in this reply, another, or
  // none. Pill and news are one piece of work: the news draws it.
  const owner = row(5, "owner", { batch_id: 1, status: "answered" })
  const reply = (covers: number[] | undefined, state = "done") =>
    row(7, "reply", {
      batch_id: 1,
      body: "Not accepted: nothing was changed.",
      data: { state, ...(covers === undefined ? {} : { covers }) },
    })
  const pill = (patch: Partial<TimelineRow> = {}) =>
    row(8, "dispatch", {
      batch_id: 1,
      dispatch_id: 1,
      body: "Check task #3",
      data: { mode: "session", done_when: "Say whether it passes." },
      ...patch,
    })
  const news = (id = 9, patch: Partial<TimelineRow> = {}) =>
    row(id, "result", {
      dispatch_id: 1,
      reply_to: 7,
      data: { state: "completed", excerpt: "Not accepted." },
      ...patch,
    })
  const replyItem = (items: MessageItem[]) =>
    items.find((i) => i.kind === "reply") as Extract<
      MessageItem,
      { kind: "reply" }
    >
  const eventItem = (items: MessageItem[], id = 9) =>
    items.find((i) => i.kind === "event" && i.row.id === id) as Extract<
      MessageItem,
      { kind: "event" }
    >

  it("draws the work once: its news, with the pill's criteria", () => {
    const items = buildMessageItems([owner, reply([9]), pill(), news()])
    expect(replyItem(items).pills).toEqual([])
    const card = eventItem(items)
    expect(card.covered).toBe(true)
    expect(card.pills.map((p) => p.id)).toEqual([8])
    // A jump to the pill lands on the news that draws it.
    const ids = items.map((i) =>
      i.kind === "time" ? [] : [...drawnRowIds([i])]
    )
    expect(ids.find((l) => l.includes(8))).toEqual([9, 8])
  })

  it("makes way whoever reported the news, or none did", () => {
    const later = row(10, "reply", {
      batch_id: 2,
      body: "Not accepted.",
      data: { state: "done", covers: [9] },
    })
    for (const rows of [
      [owner, reply([]), pill(), news(), later],
      [owner, reply(undefined, "running"), pill(), news()],
      [owner, reply([9], "canceled"), pill(), news()],
    ]) {
      const items = buildMessageItems(rows)
      expect(replyItem(items).pills).toEqual([])
      expect(eventItem(items).pills.map((p) => p.id)).toEqual([8])
    }
  })

  it("keeps the newest pill of work under way", () => {
    // Run again since its news (a follow-up queued, the board, a retry).
    const items = buildMessageItems(
      [owner, reply([9]), pill(), news()],
      new Set([1])
    )
    expect(replyItem(items).pills.map((p) => p.id)).toEqual([8])
    expect(eventItem(items).pills).toEqual([])
    // A follow-up's pill after the news: it stays, the first makes way.
    const follow = row(12, "dispatch", {
      batch_id: 3,
      dispatch_id: 1,
      data: { mode: "session", followup: true },
    })
    const going = buildMessageItems(
      [owner, reply([9]), pill(), news(), follow],
      new Set([1])
    )
    expect(eventItem(going).pills.map((p) => p.id)).toEqual([8])
    expect(drawnRowIds(going).has(12)).toBe(true)
    const pills = going.flatMap((i) =>
      i.kind === "reply" ? i.pills.map((p) => p.id) : []
    )
    expect(pills).toEqual([12])
  })

  it("keeps a pill that says more than the news, or never went out", () => {
    for (const p of [
      pill({ data: { mode: "session", check_for: 3, check_round: 1 } }),
      pill({
        data: { mode: "task", pr_fix: { label: "#12", cause: "checks", n: 1 } },
      }),
      pill({ data: { mode: "session", failed: true } }),
    ]) {
      const items = buildMessageItems([owner, reply([9]), p, news()])
      expect(eventItem(items).pills).toEqual([])
    }
  })

  it("keeps a pill of other work, and a follow-up's after the news", () => {
    const other = row(11, "result", { dispatch_id: 2 })
    const items = buildMessageItems([owner, reply([11]), pill(), other])
    expect(replyItem(items).pills.map((p) => p.id)).toEqual([8])
    expect(eventItem(items, 11).pills).toEqual([])
    const follow = row(12, "dispatch", {
      batch_id: 3,
      dispatch_id: 1,
      data: { mode: "session", followup: true },
    })
    const after = buildMessageItems([owner, reply([9]), pill(), news(), follow])
    expect(eventItem(after).pills.map((p) => p.id)).toEqual([8])
    expect(
      after.some((i) => i.kind === "reply" && i.pills.some((p) => p.id === 12))
    ).toBe(true)
  })

  it("lets the latest news of the work draw it", () => {
    const items = buildMessageItems([
      owner,
      reply([9, 12]),
      pill(),
      news(9, { data: { state: "review" } }),
      news(12),
    ])
    expect(eventItem(items, 9).pills).toEqual([])
    expect(eventItem(items, 12).pills.map((p) => p.id)).toEqual([8])
  })

  it("leaves no empty bubble for a turn whose only pill made way", () => {
    // A follow-up no turn wrote (an automatic retry while idle), then its
    // news: nothing is left of the follow-up's own item.
    const lone = row(12, "dispatch", {
      dispatch_id: 1,
      data: { mode: "session", followup: true },
    })
    const items = buildMessageItems([lone, news(13)])
    expect(shape(items)).toEqual(["time", "event:13"])
    // A turn with no reply whose pill made way keeps its question, as the
    // same item: drawn at what is left.
    const asked = row(15, "question", { batch_id: 4 })
    const p = row(14, "dispatch", { batch_id: 4, dispatch_id: 1 })
    const kept = buildMessageItems([p, asked, news(16)])
    const item = kept.find((i) => i.kind === "reply") as Extract<
      MessageItem,
      { kind: "reply" }
    >
    expect(item.key).toBe("r14")
    expect(item.anchor.id).toBe(15)
    expect(itemRowIds(item)).toEqual([15])
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

describe("a turn cut into parts by the lines it wrote (P6)", () => {
  const at = (m: number) => `2026-11-25T10:${String(m).padStart(2, "0")}:00Z`
  /** A line of turn `batch` at step `n`, after the run `said`. */
  const line = (
    id: number,
    n: number | null,
    said: [number, string] | null = null,
    patch: Partial<TimelineRow> = {}
  ) =>
    row(id, "exchange", {
      batch_id: 44,
      ref_id: `m${id}`,
      data: {
        direction: "out",
        peer: { id: 2, name: "Dev" },
        ...(n == null
          ? {}
          : {
              turn: {
                n,
                said: said ? { n: said[0], text: said[1] } : null,
              },
            }),
      },
      ...patch,
    })
  const pill = (
    id: number,
    n: number,
    said: [number, string] | null = null,
    work = id
  ) =>
    row(id, "dispatch", {
      batch_id: 44,
      dispatch_id: work,
      body: `Work ${work}`,
      data: {
        mode: "chat",
        turn: { n, said: said ? { n: said[0], text: said[1] } : null },
      },
    })
  /** The turn's reply: running, or settled on its run `last`. */
  const reply = (
    texts: [number, string][] | null,
    last: number | null,
    patch: Partial<TimelineRow> = {}
  ) => {
    const runs = texts?.map(([n, text]) => ({ n, text }))
    const body =
      last != null ? (texts?.find(([n]) => n === last)?.[1] ?? "") : ""
    return row(40, "reply", {
      batch_id: 44,
      body,
      data:
        last == null
          ? { state: "running", ...(runs ? { texts: runs, ver: 9 } : {}) }
          : {
              state: "done",
              last_text_n: last,
              ...(runs ? { texts: runs } : {}),
            },
      ...patch,
    })
  }
  const owner = row(39, "owner", { batch_id: 44, status: "answered" })
  const ofKind = <K extends MessageItem["kind"]>(
    items: MessageItem[],
    kind: K
  ) =>
    items.filter((i) => i.kind === kind) as Extract<MessageItem, { kind: K }>[]

  it("draws the stretch of #145–#150: each piece of work once, the turn in its parts", () => {
    const rows = [
      row(144, "owner", {
        batch_id: 43,
        status: "answered",
        created_at: at(0),
      }),
      row(145, "reply", {
        batch_id: 43,
        body: "已启动 codeg-ios 的审查。",
        data: { state: "done", last_text_n: 5 },
        created_at: at(0),
      }),
      row(147, "dispatch", {
        batch_id: 43,
        dispatch_id: 15,
        body: "审查 codeg-ios",
        data: { mode: "session", done_when: "列出问题" },
        created_at: at(0),
      }),
      row(148, "result", {
        dispatch_id: 15,
        reply_to: 145,
        data: { state: "completed", title: "审查 codeg-ios", excerpt: "…" },
        created_at: at(2),
      }),
      row(149, "reply", {
        batch_id: 44,
        reply_to: 148,
        body: "审查完了：两处要改。",
        data: { state: "done", last_text_n: 7, covers: [148] },
        created_at: at(2),
      }),
      line(150, 6, [2, "登记的目录是空的…"], { created_at: at(3) }),
    ]
    const items = buildMessageItems(rows)
    expect(shape(items)).toEqual([
      "time",
      "owner:144",
      "reply:145[147]",
      "event:148",
      "said:150(登记的目录是空的…)",
      "exchange:150",
      "reply:149[]",
    ])
    // #145 draws no pill: its work's news (#148) draws it, reported.
    const [first, second] = ofKind(items, "reply")
    expect(first.pills).toEqual([])
    const [news] = ofKind(items, "event")
    expect(news.covered).toBe(true)
    expect(news.pills.map((p) => p.id)).toEqual([147])
    // The turn's quote is on its first part, and left out: what it quotes
    // (#148) is right above the turn.
    const [said] = ofKind(items, "said")
    expect([said.quote, said.quotesPrevious]).toEqual([true, true])
    expect(second.quote).toBe(false)
  })

  it("cuts a turn with talk between two messages into three", () => {
    const texts: [number, string][] = [
      [1, "Asking Dev."],
      [3, "Now Review."],
      [5, "Both asked."],
    ]
    const rows = [
      owner,
      reply(texts, 5),
      line(41, 2, [1, "Asking Dev."]),
      line(42, 4, [3, "Now Review."]),
    ]
    expect(shape(buildMessageItems(rows))).toEqual([
      "time",
      "owner:39",
      "said:41(Asking Dev.)",
      "exchange:41",
      "said:42(Now Review.)",
      "exchange:42",
      "reply:40[]",
    ])
    // While it runs: the same parts, the last the reply's.
    const running = buildMessageItems([
      owner,
      reply(texts, null),
      rows[2],
      rows[3],
    ])
    expect(shape(running)).toEqual(shape(buildMessageItems(rows)))
  })

  it("joins two messages sent one after the other into one line", () => {
    const items = buildMessageItems([
      owner,
      reply(
        [
          [1, "Asking both."],
          [4, "Done."],
        ],
        4
      ),
      line(41, 2, [1, "Asking both."]),
      line(42, 3, [1, "Asking both."]),
    ])
    expect(shape(items)).toEqual([
      "time",
      "owner:39",
      "said:41(Asking both.)",
      "exchange:41,42",
      "reply:40[]",
    ])
  })

  it("draws no bubble before a message the turn opened with", () => {
    const items = buildMessageItems([
      owner,
      reply([[2, "Sent it."]], 2),
      line(41, 1),
    ])
    expect(shape(items)).toEqual([
      "time",
      "owner:39",
      "exchange:41",
      "reply:40[]",
    ])
    // Running, nothing written yet after it: no bubble either (the reply
    // item draws nothing while it has no text).
    const running = buildMessageItems([owner, reply(null, null), line(41, 1)])
    expect(shape(running)).toEqual([
      "time",
      "owner:39",
      "exchange:41",
      "reply:40[]",
    ])
  })

  it("puts a message sent after the conclusion under the reply", () => {
    const items = buildMessageItems([
      owner,
      reply([[1, "Told Dev."]], 1),
      line(41, 2, [1, "Told Dev."]),
    ])
    expect(shape(items)).toEqual([
      "time",
      "owner:39",
      "reply:40[]",
      "exchange:41",
    ])
  })

  it("draws a silent turn's lines on their own, and nothing it said", () => {
    const items = buildMessageItems([
      owner,
      reply([[1, "Checking."]], null, {
        data: { state: "silent", texts: [{ n: 1, text: "Checking." }] },
      }),
      line(41, 2, [1, "Checking."]),
    ])
    expect(shape(items)).toEqual(["time", "owner:39", "exchange:41"])
  })

  it("puts work handed out before a message in the part above the line", () => {
    const items = buildMessageItems([
      owner,
      reply(
        [
          [1, "Handing it out."],
          [4, "Dev has it too."],
        ],
        4
      ),
      pill(41, 2, [1, "Handing it out."]),
      line(42, 3, [1, "Handing it out."]),
    ])
    expect(shape(items)).toEqual([
      "time",
      "owner:39",
      "said:42(Handing it out.)",
      "exchange:42",
      "reply:40[41]",
    ])
    const [said] = ofKind(items, "said")
    expect(said.pills.map((p) => p.id)).toEqual([41])
    expect(ofKind(items, "reply")[0].pills).toEqual([])
    expect(itemRowIds(said)).toEqual([41])
  })

  it("keeps A / X / P in order, running and settled, the reply where A is", () => {
    const rows = (settled: boolean) => [
      owner,
      reply([[1, "A: the plan."]], settled ? 1 : null),
      line(41, 2, [1, "A: the plan."]),
      // Handed out at the same step as the message (tools side by side):
      // after it, by which was written first.
      pill(42, 2, [1, "A: the plan."]),
    ]
    const running = buildMessageItems(rows(false))
    expect(shape(running)).toEqual([
      "time",
      "owner:39",
      "said:41(A: the plan.)",
      "exchange:41",
      "reply:40[42]",
    ])
    expect(ofKind(running, "reply")[0].pills.map((p) => p.id)).toEqual([42])
    const settled = buildMessageItems(rows(true))
    expect(shape(settled)).toEqual([
      "time",
      "owner:39",
      "reply:40[42]",
      "exchange:41",
      "said:41()",
    ])
    const [r] = ofKind(settled, "reply")
    const [s] = ofKind(settled, "said")
    // A jump to the reply lands on A; the work is the last part's.
    expect(itemRowIds(r)).toContain(40)
    expect(r.pills).toEqual([])
    expect([s.key, s.pills.map((p) => p.id)]).toEqual(["sa41", [42]])
  })

  it('keeps a group\'s "N more" with its pills as they move to another part', () => {
    const pills = [41, 42, 43, 44].map((id) =>
      pill(id, 2, [1, "Four at once."])
    )
    const before = buildMessageItems([
      owner,
      reply([[1, "Four at once."]], null),
      ...pills,
    ])
    const after = buildMessageItems([
      owner,
      reply([[1, "Four at once."]], null),
      ...pills,
      line(45, 3, [1, "Four at once."]),
    ])
    const [r] = ofKind(before, "reply")
    const [said] = ofKind(after, "said")
    expect(said.pills.map((p) => p.id)).toEqual([41, 42, 43, 44])
    // One group, by its first pill, in either part.
    const groups = (i: typeof r | typeof said) =>
      partEntries([{ n: 1, text: "Four at once." }], i.partPills, i.pills).map(
        (e) => (e.kind === "pills" ? `p${e.group}` : "t")
      )
    expect(groups(r)).toEqual(["t", "p41"])
    expect(groups(said)).toEqual(["t", "p41"])
  })

  it("keeps a part whose pills made way, empty, so the lines round it stay apart", () => {
    const rows = [
      owner,
      reply(null, null),
      line(41, 1),
      pill(42, 2, null, 7),
      line(43, 3),
    ]
    const going = buildMessageItems(rows)
    const done = buildMessageItems([
      ...rows,
      row(50, "result", { dispatch_id: 7, data: { state: "completed" } }),
    ])
    for (const items of [going, done]) {
      expect(ofKind(items, "exchange").map((x) => x.key)).toEqual([
        "x41",
        "x43",
      ])
    }
    expect(ofKind(going, "said")[0].shown).toBe(true)
    const [empty] = ofKind(done, "said")
    expect([empty.key, empty.shown, empty.pills]).toEqual(["s43", false, []])
    // Run again: its pill back where it was.
    const again = buildMessageItems(
      [
        ...rows,
        row(50, "result", { dispatch_id: 7, data: { state: "completed" } }),
      ],
      new Set([7])
    )
    expect(ofKind(again, "said")[0].pills.map((p) => p.id)).toEqual([42])
  })

  it("puts the turn's quote on its first part drawn", () => {
    // P handed out, then X; the conclusion quotes an older message.
    const old = row(30, "owner", { status: "answered" })
    const rows = [
      old,
      owner,
      reply([[3, "Done."]], 3, { reply_to: 30 }),
      pill(41, 1, null, 7),
      line(42, 2),
    ]
    const going = buildMessageItems(rows)
    const [said] = ofKind(going, "said")
    expect([said.quote, said.quotesPrevious]).toEqual([true, false])
    expect(ofKind(going, "reply")[0].quote).toBe(false)
    // P's news came: its part draws nothing, the reply the quote.
    const done = buildMessageItems([
      ...rows,
      row(50, "result", { dispatch_id: 7, data: { state: "completed" } }),
    ])
    expect(ofKind(done, "said")[0].quote).toBe(false)
    const [r] = ofKind(done, "reply")
    expect([r.quote, r.quotesPrevious]).toEqual([true, false])
  })

  it("puts the new-messages line over the whole turn", () => {
    const items = buildMessageItems([
      owner,
      reply(
        [
          [1, "Asking."],
          [3, "Asked."],
        ],
        3
      ),
      line(41, 2, [1, "Asking."]),
    ])
    const at = newLineIndex(items, 40)
    expect(items[at]).toMatchObject({ kind: "said" })
    // Five minutes and more between its two messages: a time line between
    // them; and the message that woke the turn joined its first line.
    const woke = row(38, "exchange", {
      batch_id: 12,
      data: { direction: "in", peer: { id: 2, name: "Dev" } },
      created_at: "2026-11-04T10:00:00Z",
    })
    const far = buildMessageItems([
      woke,
      reply(null, 5, {
        body: "Both done.",
        data: { state: "done", last_text_n: 5 },
        created_at: "2026-11-04T10:00:01Z",
      }),
      line(41, 1, null, { created_at: "2026-11-04T10:00:02Z" }),
      line(42, 3, null, { created_at: "2026-11-04T10:09:00Z" }),
    ])
    expect(shape(far)).toEqual([
      "time",
      "exchange:38,41",
      "time",
      "exchange:42",
      "reply:40[]",
    ])
    expect(newLineIndex(far, 40)).toBe(0)
  })

  it("lands every row a jump can reach on one item only", () => {
    const fixtures: TimelineRow[][] = [
      [
        owner,
        reply(
          [
            [1, "A."],
            [4, "C."],
          ],
          4
        ),
        pill(41, 2, [1, "A."]),
        line(42, 3, [1, "A."]),
        pill(43, 5, [4, "C."], 41),
        row(50, "result", { dispatch_id: 41, data: { state: "completed" } }),
      ],
      [
        owner,
        reply([[1, "A."]], 1),
        line(42, 2, [1, "A."]),
        pill(43, 3, [1, "A."]),
        pill(44, 3, [1, "A."]),
        row(50, "result", { dispatch_id: 43, data: { state: "completed" } }),
      ],
    ]
    for (const rows of fixtures) {
      const seen = new Map<number, string>()
      for (const item of buildMessageItems(rows, new Set([44]))) {
        for (const id of itemRowIds(item)) {
          expect(seen.get(id), `row ${id} in ${item.key}`).toBeUndefined()
          seen.set(id, "key" in item ? item.key : "")
        }
      }
    }
  })
})

describe("partEntries", () => {
  const p = (id: number, n: number | null) =>
    row(id, "dispatch", {
      dispatch_id: id,
      data: n == null ? {} : { turn: { n, said: null } },
    })
  it("draws runs and the work between them in the order they came", () => {
    // A, then P handed out, then C: A, P, C — not A, C, P.
    const order = partEntries(
      [
        { n: 1, text: "A" },
        { n: 3, text: "C" },
      ],
      [p(10, 2), p(11, 4), p(12, 4), p(13, null)],
      [p(10, 2), p(12, 4), p(13, null)]
    ).map((e) =>
      e.kind === "text" ? e.run.text : `${e.group}:${e.rows.map((r) => r.id)}`
    )
    // The second group keyed by its first pill, though that one made way.
    expect(order).toEqual(["A", "10:10", "C", "11:12,13"])
    // A group whose pills all made way: nothing.
    expect(
      partEntries([{ n: 1, text: "A" }], [p(10, 2)], []).map((e) => e.kind)
    ).toEqual(["text"])
  })
})
