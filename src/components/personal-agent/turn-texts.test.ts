import { describe, expect, it } from "vitest"

import type { TimelineRow } from "@/lib/types"

import { BODY_LAST, conclusionOf, turnTexts } from "./turn-texts"

function row(
  id: number,
  kind: TimelineRow["kind"],
  patch: Partial<TimelineRow> = {}
): TimelineRow {
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
    created_at: "2026-11-25T10:00:00Z",
    updated_at: "2026-11-25T10:00:00Z",
    ...patch,
  }
}

const line = (id: number, n: number, said: [number, string]) =>
  row(id, "exchange", {
    data: { turn: { n, said: { n: said[0], text: said[1] } } },
  })

const runs = (list: { n: number; text: string }[]) =>
  list.map((t) => `${t.n}:${t.text}`)

describe("turnTexts", () => {
  it("keeps every run of a settled turn, its body the conclusion", () => {
    const r = row(1, "reply", {
      body: "C, as said.",
      data: {
        state: "done",
        last_text_n: 5,
        texts: [
          { n: 1, text: "A" },
          { n: 3, text: "B" },
          { n: 5, text: "C" },
        ],
      },
    })
    expect(runs(turnTexts(r, undefined, []))).toEqual([
      "1:A",
      "3:B",
      "5:C, as said.",
    ])
    expect(conclusionOf(r)).toBe(5)
  })

  it("reads an older row's runs off its lines, then its body", () => {
    const r = row(1, "reply", {
      body: "Done.",
      data: { state: "done", last_text_n: 4 },
    })
    const lines = [line(2, 2, [1, "Asking."]), line(3, 3, [1, "Asking."])]
    expect(runs(turnTexts(r, undefined, lines))).toEqual([
      "1:Asking.",
      "4:Done.",
    ])
    // One from before it recorded its run: the body alone, last.
    const old = row(1, "reply", { body: "Hi.", data: { state: "done" } })
    expect(runs(turnTexts(old, undefined, lines))).toEqual([
      "1:Asking.",
      `${BODY_LAST}:Hi.`,
    ])
    expect(conclusionOf(old)).toBe(BODY_LAST)
  })

  it("takes the newer copy of a running turn, never an older one", () => {
    const r = row(1, "reply", {
      data: { state: "running", ver: 10, texts: [{ n: 2, text: "Second" }] },
    })
    // A push newer than the checkpoint: its runs, and the checkpoint's it
    // does not have.
    const newer = {
      current: null,
      texts: [
        { n: 2, text: "Second, longer" },
        { n: 7, text: "Seventh" },
      ],
      ver: 12,
    }
    expect(runs(turnTexts(r, newer, []))).toEqual([
      "2:Second, longer",
      "7:Seventh",
    ])
    // A slow read older than what the row holds takes nothing back.
    const older = { current: null, texts: [{ n: 2, text: "Sec" }], ver: 8 }
    expect(runs(turnTexts(r, older, []))).toEqual(["2:Second"])
  })

  it("fills a run from the line written after it, the longer copy kept", () => {
    const r = row(1, "reply", {
      data: { state: "running", ver: 3, texts: [{ n: 4, text: "Now" }] },
    })
    const lines = [line(2, 3, [2, "The folder is empty…"])]
    expect(runs(turnTexts(r, undefined, lines))).toEqual([
      "2:The folder is empty…",
      "4:Now",
    ])
  })

  it("draws a running row an older codeg wrote from its lines and its step", () => {
    const r = row(1, "reply", {
      data: {
        state: "running",
        last_text: { n: 4, text: "Last so far" },
        current: { t: "text", n: 6, text: "Writ" },
      },
    })
    const lines = [line(2, 3, [2, "Early"])]
    expect(runs(turnTexts(r, undefined, lines))).toEqual([
      "2:Early",
      "4:Last so far",
      "6:Writ",
    ])
    // Settled from such a checkpoint (no runs kept): the same runs.
    const settled = row(1, "reply", {
      body: "Written.",
      data: { state: "done", last_text_n: 6 },
    })
    expect(runs(turnTexts(settled, undefined, lines))).toEqual([
      "2:Early",
      "6:Written.",
    ])
  })

  it("ignores pushes once the row settled", () => {
    const r = row(1, "reply", {
      body: "Final.",
      data: {
        state: "done",
        last_text_n: 1,
        texts: [{ n: 1, text: "Final." }],
      },
    })
    const late = {
      current: null,
      texts: [
        { n: 1, text: "Fin" },
        { n: 3, text: "x" },
      ],
      ver: 99,
    }
    expect(runs(turnTexts(r, late, []))).toEqual(["1:Final."])
  })
})

describe("turnTexts, settled from a checkpoint behind its lines", () => {
  it("keeps the run a line kept that the checkpoint never had", () => {
    // Its connection gone, the reply settled from a checkpoint holding A;
    // the message it sent after B kept B.
    const r = row(1, "reply", {
      body: "A",
      data: {
        state: "interrupted",
        last_text_n: 1,
        texts: [{ n: 1, text: "A" }],
      },
    })
    expect(runs(turnTexts(r, undefined, [line(2, 4, [3, "B"])]))).toEqual([
      "1:A",
      "3:B",
    ])
  })
})
