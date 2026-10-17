import { describe, expect, beforeEach } from "vitest"
import {
  rememberRecentConversation,
  forgetRecentConversation,
  nextRecentConversation,
  readRecentSessionDepth,
  writeRecentSessionDepth,
  DEFAULT_RECENT_SESSION_DEPTH,
} from "./recent-sessions-prefs"

describe("recent-sessions-prefs", () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it("rememberRecentConversation dedupes and puts most recent first", () => {
    rememberRecentConversation(1)
    rememberRecentConversation(2)
    rememberRecentConversation(1)
    expect(nextRecentConversation(null, 4, () => true)).toBe(1)
    // After re-remembering 1, the next candidate (not active) is 2.
    rememberRecentConversation(1)
    expect(nextRecentConversation(1, 4, () => true)).toBe(2)
  })

  it("caps the queue at 8 entries", () => {
    for (let i = 1; i <= 12; i++) rememberRecentConversation(i)
    // Only ids 5..12 survive.
    for (let i = 1; i <= 4; i++) {
      expect(nextRecentConversation(null, 8, (id) => id === i)).toBeNull()
    }
    expect(nextRecentConversation(null, 8, (id) => id === 5)).toBe(5)
  })

  it("nextRecentConversation respects depth - 1 candidates", () => {
    rememberRecentConversation(1)
    rememberRecentConversation(2)
    rememberRecentConversation(3)
    // Queue is [3,2,1]. Depth 2 → one candidate (3). Excluding active 3 → 2.
    expect(nextRecentConversation(3, 2, () => true)).toBe(2)
    // Depth 4 → candidates [3,2,1]; excluding active 2 → first is 3.
    expect(nextRecentConversation(2, 4, () => true)).toBe(3)
  })

  it("nextRecentConversation filters unavailable ids", () => {
    rememberRecentConversation(1)
    rememberRecentConversation(2)
    expect(nextRecentConversation(null, 4, (id) => id !== 2)).toBe(1)
    expect(nextRecentConversation(null, 4, () => false)).toBeNull()
  })

  it("forgetRecentConversation removes a deleted conversation", () => {
    rememberRecentConversation(1)
    rememberRecentConversation(2)
    forgetRecentConversation(1)
    expect(nextRecentConversation(2, 4, () => true)).toBeNull()
    expect(nextRecentConversation(1, 4, () => true)).toBe(2)
  })

  it("depth defaults to 2 and only accepts 3/4 overrides", () => {
    expect(readRecentSessionDepth()).toBe(DEFAULT_RECENT_SESSION_DEPTH)
    writeRecentSessionDepth(4)
    expect(readRecentSessionDepth()).toBe(4)
    writeRecentSessionDepth(3)
    expect(readRecentSessionDepth()).toBe(3)
  })

  it("survives corrupted storage", () => {
    window.localStorage.setItem("codeg:recent-conversations", "not-json{")
    expect(nextRecentConversation(null, 4, () => true)).toBeNull()
    window.localStorage.setItem(
      "codeg:recent-conversations",
      JSON.stringify(["a", 5, null, 7])
    )
    expect(nextRecentConversation(null, 4, () => true)).toBe(5)
  })
})
