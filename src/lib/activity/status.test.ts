import { describe, expect, it } from "vitest"

import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"
import { combineStatuses, toolCallStatus } from "./status"

function call(overrides: Partial<AdaptedToolCallPart>): AdaptedToolCallPart {
  return {
    type: "tool-call",
    toolCallId: "c1",
    toolName: "Bash",
    input: '{"command":"ls"}',
    state: "output-available",
    ...overrides,
  }
}

describe("toolCallStatus", () => {
  it("maps the adapter's lifecycle states", () => {
    expect(toolCallStatus(call({}))).toBe("succeeded")
    expect(toolCallStatus(call({ state: "input-available" }))).toBe("running")
    expect(toolCallStatus(call({ state: "input-streaming" }))).toBe("pending")
    expect(
      toolCallStatus(call({ state: "output-error", errorText: "boom" }))
    ).toBe("failed")
  })

  it("keeps a promoted call with an unsettled ACP status running", () => {
    expect(toolCallStatus(call({ toolStatus: "in_progress" }))).toBe("running")
  })

  it("tells a declined call and an interrupted one apart from a failure", () => {
    expect(
      toolCallStatus(
        call({
          state: "output-error",
          errorText:
            "The user doesn't want to proceed with this tool use. The tool use was rejected",
        })
      )
    ).toBe("rejected")
    expect(
      toolCallStatus(
        call({
          state: "output-error",
          errorText: "[Request interrupted by user for tool use]",
        })
      )
    ).toBe("cancelled")
  })

  it("lets a pending permission win", () => {
    expect(toolCallStatus(call({}), { awaiting: true })).toBe("awaiting")
  })
})

describe("combineStatuses", () => {
  it("ranks live over waiting over failed over done", () => {
    expect(combineStatuses(["succeeded", "running", "failed"])).toBe("running")
    expect(combineStatuses(["failed", "awaiting"])).toBe("awaiting")
    expect(combineStatuses(["succeeded", "rejected"])).toBe("failed")
    expect(combineStatuses(["succeeded", "cancelled"])).toBe("succeeded")
    expect(combineStatuses(["cancelled", "cancelled"])).toBe("cancelled")
  })
})
