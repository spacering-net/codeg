import { describe, expect, it } from "vitest"

import type { ReplyStep, TimelineRow } from "@/lib/types"

import { replyView, type ReplyViewInput } from "./reply-view"

let nextId = 100

function row(
  kind: TimelineRow["kind"],
  patch: Partial<TimelineRow> = {}
): TimelineRow {
  const id = patch.id ?? nextId++
  return {
    id,
    segment_id: 1,
    batch_id: 7,
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
    created_at: "2026-11-04T10:00:00Z",
    updated_at: "2026-11-04T10:00:00Z",
    ...patch,
  }
}

function reply(
  data: Record<string, unknown> | null,
  body = "",
  patch: Partial<TimelineRow> = {}
): TimelineRow {
  return row("reply", { data, body, ...patch })
}

function view(input: Partial<ReplyViewInput> & { row: TimelineRow | null }) {
  return replyView({ live: undefined, attached: [], owners: [], ...input })
}

const text = (n: number, t: string): ReplyStep => ({ t: "text", n, text: t })
const step = (n: number, title: string, extra = {}): ReplyStep => ({
  t: "step",
  n,
  kind: "edit",
  title,
  ...extra,
})

describe("replyView while the turn runs", () => {
  it("shows the pushed step, text streaming", () => {
    const v = view({
      row: reply({ state: "running" }),
      live: text(1, "Looking"),
    })
    expect(v.running).toBe(true)
    expect(v.slot).toEqual({
      kind: "text",
      key: "t1",
      text: "Looking",
      streaming: true,
    })
    expect(v.ending).toBeNull()
  })

  it("replaces text with the step that follows it", () => {
    const v = view({
      row: reply({ state: "running" }),
      live: step(2, "Edit MEMORY.md"),
    })
    expect(v.slot).toMatchObject({ kind: "step", key: "s2" })
  })

  it("falls back to the row's checkpoint before any push (read-only page, mid-turn open)", () => {
    const v = view({
      row: reply({
        state: "running",
        current: { t: "step", n: 4, kind: "execute", title: "pnpm test" },
      }),
    })
    expect(v.slot).toMatchObject({
      kind: "step",
      key: "s4",
      step: { title: "pnpm test" },
    })
  })

  it("waits when nothing happened yet", () => {
    expect(view({ row: reply({ state: "running" }) }).slot).toEqual({
      kind: "waiting",
      key: "waiting",
    })
    // A push of "no step" wins over an older checkpoint too.
    expect(
      view({
        row: reply({ state: "running", current: text(1, "old") }),
        live: null,
      }).slot?.kind
    ).toBe("waiting")
  })

  it("keeps a step waiting on the owner as it is", () => {
    const v = view({
      row: reply({ state: "running" }),
      live: step(3, "rm -rf build", { awaiting: true }),
    })
    expect(v.slot).toMatchObject({ kind: "step", step: { awaiting: true } })
  })

  it("offers no resend while running", () => {
    const v = view({
      row: reply({ state: "running" }),
      owners: [row("owner", { status: "interrupted" })],
    })
    expect(v.resend).toEqual([])
  })
})

describe("replyView once the turn ended", () => {
  it("shows only the last text, keyed like the step it streamed in", () => {
    const v = view({
      row: reply(
        { state: "done", last_text_n: 3, step_count: 4, duration_ms: 4200 },
        "Nothing new since Monday."
      ),
      // A late push never overrides a settled row.
      live: step(4, "Edit MEMORY.md"),
    })
    expect(v.running).toBe(false)
    expect(v.slot).toEqual({
      kind: "text",
      key: "t3",
      text: "Nothing new since Monday.",
      streaming: false,
    })
    expect(v.ending).toBeNull()
    expect(v.durationMs).toBe(4200)
  })

  it("says it dispatched work when it wrote nothing", () => {
    const v = view({
      row: reply({ state: "done", step_count: 2 }),
      attached: [
        row("dispatch", { dispatch_id: 5 }),
        row("dispatch", { dispatch_id: 6 }),
      ],
    })
    expect(v.slot).toEqual({
      kind: "note",
      key: "note",
      note: "dispatched",
      count: 2,
    })
    expect(v.dispatches).toHaveLength(2)
  })

  it("says it continued work when all it did was follow up", () => {
    const v = view({
      row: reply({ state: "done" }),
      attached: [row("dispatch", { dispatch_id: 5, data: { followup: true } })],
    })
    expect(v.slot).toMatchObject({ note: "continued", count: 1 })
  })

  it("says it did nothing to show when it wrote and dispatched nothing", () => {
    expect(view({ row: reply({ state: "done" }) }).slot).toMatchObject({
      note: "nothing",
    })
  })

  it("keeps half a text with the stop, and only the stop without text", () => {
    const half = view({
      row: reply({ state: "canceled", last_text_n: 1 }, "First half of"),
    })
    expect(half.slot).toMatchObject({ kind: "text", text: "First half of" })
    expect(half.ending).toEqual({ kind: "stopped" })
    const none = view({ row: reply({ state: "canceled" }) })
    expect(none.slot).toBeNull()
    expect(none.ending).toEqual({ kind: "stopped" })
  })

  it("adds the error under text it still wrote", () => {
    const v = view({
      row: reply({ state: "done", error: "rate limited" }, "Partial answer"),
    })
    expect(v.ending).toEqual({ kind: "error", detail: "rate limited" })
  })

  it("marks a truncated reply", () => {
    const v = view({
      row: reply({ state: "done", stop_reason: "max_tokens" }, "Long…"),
    })
    expect(v.ending).toEqual({ kind: "truncated" })
  })

  it("explains an interrupted reply and offers its messages again", () => {
    const lost = row("owner", { status: "interrupted" })
    const resent = row("owner", {
      status: "interrupted",
      data: { resent_as: 999 },
    })
    const v = view({
      row: reply(
        { state: "interrupted", why: "restart", last_text_n: 2 },
        "Half an answ"
      ),
      owners: [lost, resent, row("owner", { status: "answered" })],
    })
    expect(v.slot).toMatchObject({ kind: "text", text: "Half an answ" })
    expect(v.ending).toEqual({
      kind: "interrupted",
      why: "restart",
      detail: null,
    })
    expect(v.resend).toEqual([lost.id])
    expect(view({ row: reply({ state: "interrupted" }) }).slot).toBeNull()
  })

  it("keeps the owner's answers as lines, and nothing of a withdrawn request", () => {
    const v = view({
      row: reply({ state: "done" }, "Done."),
      attached: [
        row("permission", {
          data: {
            state: "answered",
            option_id: "allow",
            options: [{ option_id: "allow", name: "Allow once" }],
          },
        }),
        row("permission", { data: { state: "withdrawn" } }),
        row("question", {
          data: {
            kind: "ask",
            state: "answered",
            answer: { answers: [{ selected: ["Friday"] }] },
          },
        }),
        row("question", {
          data: {
            kind: "plan_approval",
            state: "answered",
            answer: { decision: "approve" },
          },
        }),
        row("question", { data: { kind: "ask", state: "resolved" } }),
      ],
    })
    expect(v.answered.map((a) => [a.kind, a.text])).toEqual([
      ["permission", "Allow once"],
      ["question", "Friday"],
      ["plan", "approve"],
    ])
  })

  it("draws a phase-one reply as it was stored", () => {
    const v = view({
      row: reply({ stop_reason: "end_turn" }, "All of it.\n\nEvery run."),
    })
    expect(v.slot).toMatchObject({
      kind: "text",
      key: "body",
      text: "All of it.\n\nEvery run.",
    })
    expect(view({ row: reply({ interrupted: true }, "x") }).ending?.kind).toBe(
      "interrupted"
    )
    expect(view({ row: reply({ canceled: true }, "x") }).ending?.kind).toBe(
      "stopped"
    )
  })

  it("gives a phase-one turn with no reply row a bubble with no body", () => {
    const v = view({
      row: null,
      attached: [row("dispatch", { dispatch_id: 3 })],
    })
    expect(v.running).toBe(false)
    expect(v.slot).toMatchObject({ note: "dispatched", count: 1 })
  })

  it("is the same whether it came live or from history", () => {
    const settled = reply(
      { state: "done", last_text_n: 3, step_count: 3 },
      "Answer."
    )
    const live = view({ row: settled, live: text(3, "Answer.") })
    const history = view({ row: settled })
    expect(live).toEqual(history)
  })
})
