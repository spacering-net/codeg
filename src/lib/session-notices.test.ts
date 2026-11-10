import { describe, expect, it } from "vitest"

import {
  isCompactionEchoNotice,
  presentSessionNotice,
  splitHeadline,
} from "./session-notices"
import type { SessionNotice } from "@/lib/types"

const notice = (
  severity: string,
  title: string,
  description?: string
): SessionNotice => ({
  severity,
  title,
  ...(description ? { description } : {}),
})

describe("isCompactionEchoNotice", () => {
  it("recognizes codex's post-compaction advisory in both wordings", () => {
    // Current codex core (`core/src/compact.rs`).
    expect(
      isCompactionEchoNotice(
        notice(
          "warning",
          "Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted."
        )
      )
    ).toBe(true)
    // Older releases said "conversations".
    expect(
      isCompactionEchoNotice(
        notice(
          "warning",
          "Heads up: Long conversations and multiple compactions can cause the model to be less accurate."
        )
      )
    ).toBe(true)
  })

  it("recognizes codex-acp's legacy 'Context compacted' notice", () => {
    expect(
      isCompactionEchoNotice(
        notice(
          "info",
          "Context compacted",
          "Conversation compacted to fit the model's context window."
        )
      )
    ).toBe(true)
  })

  it("leaves every other advisory alone", () => {
    for (const other of [
      notice("warning", "Fast mode turned off"),
      notice("warning", "Model fallback", "Switched to claude-sonnet."),
      // Same words, but a real warning rather than the info echo.
      notice("warning", "Context compacted"),
      notice("info", "Model rerouted"),
    ]) {
      expect(isCompactionEchoNotice(other)).toBe(false)
    }
  })
})

describe("presentSessionNotice", () => {
  it("drops compaction echoes entirely", () => {
    expect(
      presentSessionNotice(
        "conn-1",
        notice("warning", "Heads up: multiple compactions hurt accuracy.")
      )
    ).toBeNull()
  })

  it("grades the level, falling back to info for anything unknown", () => {
    expect(presentSessionNotice("c", notice("error", "x"))?.level).toBe("error")
    expect(presentSessionNotice("c", notice("warning", "x"))?.level).toBe(
      "warning"
    )
    expect(presentSessionNotice("c", notice("info", "x"))?.level).toBe("info")
    expect(presentSessionNotice("c", notice("_vendor", "x"))?.level).toBe(
      "info"
    )
  })

  it("keeps a one-line title whole and carries the description", () => {
    expect(
      presentSessionNotice(
        "conn-1",
        notice("warning", "Fast mode turned off", "The model can't serve it.")
      )
    ).toEqual({
      level: "warning",
      title: "Fast mode turned off",
      description: "The model can't serve it.",
      id: "acp-notice:conn-1:warning:Fast mode turned off",
    })
  })

  it("moves the tail of a multi-line title into the description", () => {
    // codex passes some upstream errors through whole — this is the captured
    // transport-fallback notice, JSON body and all.
    const presented = presentSessionNotice(
      "conn-1",
      notice(
        "warning",
        'Falling back from WebSockets to HTTPS transport. unexpected status 401 Unauthorized: {\n  "error": {\n    "message": "bad key"'
      )
    )!
    expect(presented.title).toBe(
      "Falling back from WebSockets to HTTPS transport. unexpected status 401 Unauthorized: {"
    )
    expect(presented.description).toBe('"error": {\n    "message": "bad key"')
  })

  it("puts the title's tail before the notice's own description", () => {
    const presented = presentSessionNotice(
      "c",
      notice("warning", "Blocked by hook:\n[echo nope]", "Original prompt: hi")
    )!
    expect(presented.title).toBe("Blocked by hook:")
    expect(presented.description).toBe("[echo nope]\nOriginal prompt: hi")
  })

  it("omits the description rather than showing an empty line", () => {
    const presented = presentSessionNotice(
      "c",
      notice("info", "Model rerouted", "   ")
    )!
    expect(presented).not.toHaveProperty("description")
  })

  it("dedups per connection, level and title — not per surface or occurrence", () => {
    const a = presentSessionNotice("conn-1", notice("warning", "Same"))!
    const again = presentSessionNotice("conn-1", notice("warning", "Same"))!
    const escalated = presentSessionNotice("conn-1", notice("error", "Same"))!
    const elsewhere = presentSessionNotice("conn-2", notice("warning", "Same"))!
    expect(again.id).toBe(a.id)
    expect(escalated.id).not.toBe(a.id)
    expect(elsewhere.id).not.toBe(a.id)
  })
})

describe("splitHeadline", () => {
  it("keeps one line whole and carries what else was said", () => {
    expect(splitHeadline("Authentication required.")).toEqual({
      title: "Authentication required.",
    })
    expect(
      splitHeadline("Authentication required.", "  Sign in again.  ")
    ).toEqual({
      title: "Authentication required.",
      description: "Sign in again.",
    })
  })

  it("moves a passed-through body below the headline, ahead of the details", () => {
    expect(
      splitHeadline(
        '\nstream disconnected: {\n  "error": "overloaded"\n}',
        "retry later"
      )
    ).toEqual({
      title: "stream disconnected: {",
      description: '"error": "overloaded"\n}\nretry later',
    })
  })

  it("has nothing to say for blank text", () => {
    expect(splitHeadline("  \n ", "details")).toBeNull()
  })
})
