/**
 * The "N items need you" pill (10.7, 1.14): on the primary it counts what
 * waits on the owner anywhere and opens "Today"; elsewhere, or with nothing
 * there, the cards waiting in the conversation.
 */
import { describe, expect, it } from "vitest"

import { attentionPill } from "./message-list"

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
