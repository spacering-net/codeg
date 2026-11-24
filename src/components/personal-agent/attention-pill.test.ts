/**
 * The "N items need you" pill (10.7, C6): on the primary it counts what
 * waits on the owner anywhere — from the activity's read — and opens the
 * activity there; elsewhere, or with nothing there, the cards waiting in
 * the conversation.
 */
import { describe, expect, it } from "vitest"

import { attentionKeys, attentionPill, attentionShown } from "./message-list"

describe("the attention pill", () => {
  it("counts Today's first group and opens it when anything waits there", () => {
    expect(attentionPill(3, 1)).toEqual({ count: 3, today: true })
  })

  it("falls back to the cards in the conversation", () => {
    expect(attentionPill(0, 2)).toEqual({ count: 2, today: false })
  })

  it("is not shown when nothing waits", () => {
    expect(attentionPill(0, 0)).toBeNull()
  })
})

describe("closing the attention pill", () => {
  const today = { count: 2, today: true }
  const here = { count: 2, today: false }

  it("stands for Today's rows, or for the cards here", () => {
    expect(attentionKeys(today, ["a", "b"], [7])).toEqual(["a", "b"])
    expect(attentionKeys(here, [], [7, 9])).toEqual(["row:7", "row:9"])
    expect(attentionKeys(today, [], [])).toEqual(["count:2"])
    expect(attentionKeys(null, ["a"], [7])).toEqual([])
  })

  it("stays closed while nothing new needs the owner", () => {
    expect(attentionShown(["a", "b"], undefined)).toBe(true)
    expect(attentionShown(["a", "b"], ["a", "b"])).toBe(false)
    // One of them settled: still closed.
    expect(attentionShown(["b"], ["a", "b"])).toBe(false)
    // Something new: open again.
    expect(attentionShown(["b", "c"], ["a", "b"])).toBe(true)
    expect(attentionShown([], undefined)).toBe(false)
  })
})
