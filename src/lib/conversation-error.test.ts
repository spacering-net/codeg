import { describe, expect, it } from "vitest"
import { resolveVisibleConversationError } from "./conversation-error"
import type { DbConversationDetail } from "./types"

const detail = (revision: number, message: string | null) =>
  ({
    last_error_revision: revision,
    last_error: message ? { message, code: null, details: null } : null,
  }) as DbConversationDetail

describe("persisted conversation error recovery", () => {
  it("shows a cold-open error, retires it on prompt, and shows a later error", () => {
    const old = detail(3, "old failure")
    expect(resolveVisibleConversationError(null, "connected", old, null)).toBe(
      "old failure"
    )
    expect(
      resolveVisibleConversationError(null, "prompting", old, 3)
    ).toBeNull()
    expect(
      resolveVisibleConversationError(null, "connected", old, 3)
    ).toBeNull()
    // The reducer clears the old live error at prompt start. A live error
    // observed while prompting therefore belongs to the new turn.
    expect(
      resolveVisibleConversationError("new live failure", "prompting", old, 3)
    ).toBe("new live failure")
    const fresh = detail(5, "new failure on another client")
    expect(resolveVisibleConversationError(null, "connected", fresh, 3)).toBe(
      "new failure on another client"
    )
    expect(
      resolveVisibleConversationError("live failure", "connected", old, 3)
    ).toBe("live failure")
  })
})
