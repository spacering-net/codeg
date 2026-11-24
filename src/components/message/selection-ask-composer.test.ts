import { describe, expect, it } from "vitest"

import { buildAskComposerText } from "./selection-ask-composer"

describe("buildAskComposerText", () => {
  const mention = { conversationId: 42, label: "Fix the parser" }

  it("quotes the selection and mentions the conversation on the next line", () => {
    expect(buildAskComposerText("first\nsecond", mention)).toBe(
      "> first\n> second\n[Fix the parser](codeg://session/42) "
    )
  })

  it("escapes a label that would break the mention link", () => {
    expect(
      buildAskComposerText("x", { conversationId: 3, label: "a [b] c" })
    ).toBe("> x\n[a \\[b\\] c](codeg://session/3) ")
  })

  it("leaves only the mention for a selection with no visible content", () => {
    expect(buildAskComposerText(" \n ", mention)).toBe(
      "[Fix the parser](codeg://session/42) "
    )
  })
})
