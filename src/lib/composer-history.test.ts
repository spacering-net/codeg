import { describe, expect, it } from "vitest"

import {
  stepComposerHistory,
  userPromptHistory,
  type HistoryStep,
} from "./composer-history"
import type { ContentBlock, MessageTurn, TurnRole } from "./types"

function turn(role: TurnRole, blocks: ContentBlock[]): MessageTurn {
  return { id: `${role}-${blocks.length}`, role, blocks, timestamp: "t" }
}

const text = (value: string): ContentBlock => ({ type: "text", text: value })
const image: ContentBlock = { type: "image", data: "", mime_type: "image/png" }

/** The step a caller would apply, for a terse assertion. */
function step(
  history: readonly string[],
  index: number | null,
  direction: "older" | "newer"
): HistoryStep {
  return stepComposerHistory(history, index, direction)
}

describe("userPromptHistory", () => {
  it("returns user prompts oldest first and ignores the agent's replies", () => {
    const turns = [
      turn("user", [text("first")]),
      turn("assistant", [text("sure")]),
      turn("user", [text("second")]),
    ]
    expect(userPromptHistory(turns)).toEqual(["first", "second"])
  })

  it("joins a multi-block prompt and trims it", () => {
    expect(
      userPromptHistory([
        turn("user", [text("  line one"), text("line two  ")]),
      ])
    ).toEqual(["line one\nline two"])
  })

  it("skips image-only and blank turns — there is nothing to recall", () => {
    const turns = [
      turn("user", [image]),
      turn("user", [text("   ")]),
      turn("user", [text("real")]),
    ]
    expect(userPromptHistory(turns)).toEqual(["real"])
  })

  it("collapses consecutive duplicates but keeps a non-adjacent repeat", () => {
    const turns = [
      turn("user", [text("a")]),
      turn("user", [text("a")]),
      turn("user", [text("b")]),
      turn("user", [text("a")]),
    ]
    expect(userPromptHistory(turns)).toEqual(["a", "b", "a"])
  })

  it("has no history without turns — a new session recalls nothing", () => {
    expect(userPromptHistory(undefined)).toEqual([])
    expect(userPromptHistory([])).toEqual([])
  })
})

describe("stepComposerHistory", () => {
  const history = ["one", "two", "three"]

  it("enters at the newest entry and asks the caller to stash the draft", () => {
    expect(step(history, null, "older")).toEqual({
      action: "show",
      text: "three",
      index: 2,
      enters: true,
    })
  })

  it("walks older and stops at the oldest", () => {
    expect(step(history, 2, "older")).toEqual({
      action: "show",
      text: "two",
      index: 1,
      enters: false,
    })
    expect(step(history, 1, "older")).toEqual({
      action: "show",
      text: "one",
      index: 0,
      enters: false,
    })
    // At the oldest there is nothing further: stay put, keep consuming the key.
    expect(step(history, 0, "older")).toEqual({
      action: "none",
      index: 0,
      enters: false,
    })
  })

  it("walks newer and restores the draft past the newest", () => {
    expect(step(history, 0, "newer")).toEqual({
      action: "show",
      text: "two",
      index: 1,
      enters: false,
    })
    expect(step(history, 1, "newer")).toEqual({
      action: "show",
      text: "three",
      index: 2,
      enters: false,
    })
    expect(step(history, 2, "newer")).toEqual({
      action: "restore",
      index: null,
      enters: false,
    })
  })

  it("falls through while not navigating", () => {
    // Down with nothing recalled belongs to the caret, not the history.
    expect(step(history, null, "newer")).toEqual({
      action: "none",
      index: null,
      enters: false,
    })
    // Up with no history at all must also fall through.
    expect(step([], null, "older")).toEqual({
      action: "none",
      index: null,
      enters: false,
    })
    expect(step([], 0, "newer")).toEqual({
      action: "none",
      index: null,
      enters: false,
    })
  })
})
