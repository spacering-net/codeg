import { describe, expect, it } from "vitest"

import {
  HANDOFF_BRIEFING_MARKER,
  agentHandoffPayload,
  isAgentHandoffMeta,
  isHandoffBriefingText,
} from "./agent-handoff"

describe("isAgentHandoffMeta", () => {
  it("accepts the versioned marker the backend stamps", () => {
    expect(isAgentHandoffMeta({ "codeg.handoff": { version: 1 } })).toBe(true)
    expect(
      isAgentHandoffMeta({
        "codeg.handoff": { version: 2, from: "claude_code", to: "codex" },
      })
    ).toBe(true)
  })

  it("rejects everything that is not a handoff marker", () => {
    expect(isAgentHandoffMeta(null)).toBe(false)
    expect(isAgentHandoffMeta(undefined)).toBe(false)
    expect(isAgentHandoffMeta("codeg.handoff")).toBe(false)
    expect(isAgentHandoffMeta({})).toBe(false)
    expect(isAgentHandoffMeta({ "codeg.handoff": true })).toBe(false)
    expect(isAgentHandoffMeta({ "codeg.handoff": {} })).toBe(false)
    expect(isAgentHandoffMeta({ "codeg.handoff": { version: 0 } })).toBe(false)
    expect(isAgentHandoffMeta({ "codeg.handoff": { version: "1" } })).toBe(
      false
    )
    // The compaction marker is a different divider and must not be claimed.
    expect(isAgentHandoffMeta({ contextCompaction: { version: 1 } })).toBe(
      false
    )
  })
})

describe("agentHandoffPayload", () => {
  it("reads every field and defaults the optional ones", () => {
    const payload = agentHandoffPayload({
      "codeg.handoff": {
        version: 1,
        from: "claude_code",
        to: "custom:claude-code-2",
        path: "native",
        carried: true,
        truncated: false,
        at: "2026-09-06T10:00:00Z",
        note: "finish the tests",
      },
    })
    expect(payload).toEqual({
      version: 1,
      from: "claude_code",
      to: "custom:claude-code-2",
      path: "native",
      carried: true,
      truncated: false,
      at: "2026-09-06T10:00:00Z",
      note: "finish the tests",
      briefing: null,
    })
  })

  it("degrades an unknown path to summary and blanks to null", () => {
    const payload = agentHandoffPayload({
      "codeg.handoff": { version: 1, path: "teleport", note: "", at: 5 },
    })
    expect(payload?.path).toBe("summary")
    expect(payload?.carried).toBe(false)
    expect(payload?.note).toBeNull()
    expect(payload?.at).toBeNull()
    expect(payload?.from).toBe("")
  })

  it("is null for non-handoff meta", () => {
    expect(agentHandoffPayload({ contextCompaction: true })).toBeNull()
    expect(agentHandoffPayload(null)).toBeNull()
  })
})

describe("isHandoffBriefingText", () => {
  it("matches the seeded briefing, with or without leading whitespace", () => {
    expect(isHandoffBriefingText(`${HANDOFF_BRIEFING_MARKER}\nhello`)).toBe(
      true
    )
    expect(isHandoffBriefingText(`  \n${HANDOFF_BRIEFING_MARKER}`)).toBe(true)
  })

  it("leaves ordinary prompts alone, even ones mentioning the marker", () => {
    expect(isHandoffBriefingText("hello")).toBe(false)
    expect(
      isHandoffBriefingText(`what is ${HANDOFF_BRIEFING_MARKER} for?`)
    ).toBe(false)
    expect(isHandoffBriefingText("")).toBe(false)
  })
})
