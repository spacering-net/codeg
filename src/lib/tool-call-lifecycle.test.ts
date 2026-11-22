import { describe, expect, it } from "vitest"

import {
  isToolStatusCancelled,
  isUnsettledToolCall,
  toolStatusUnsettled,
} from "./tool-call-lifecycle"
import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"

function part(over: Partial<AdaptedToolCallPart> = {}): AdaptedToolCallPart {
  return {
    type: "tool-call",
    toolCallId: "t",
    toolName: "bash",
    input: "{}",
    state: "output-available",
    ...over,
  }
}

describe("toolStatusUnsettled", () => {
  it("treats absent status as settled (DB-persisted rows)", () => {
    expect(toolStatusUnsettled(undefined)).toBe(false)
    expect(toolStatusUnsettled(null)).toBe(false)
  })

  it("treats terminal statuses as settled", () => {
    expect(toolStatusUnsettled("completed")).toBe(false)
    expect(toolStatusUnsettled("failed")).toBe(false)
    expect(toolStatusUnsettled("cancelled")).toBe(false)
    expect(toolStatusUnsettled("canceled")).toBe(false)
    expect(toolStatusUnsettled(" COMPLETED ")).toBe(false)
    expect(isToolStatusCancelled("cancelled")).toBe(true)
    expect(isToolStatusCancelled(" CANCELED ")).toBe(true)
    expect(isToolStatusCancelled("in_progress")).toBe(false)
  })

  it("treats any non-terminal status as unsettled", () => {
    expect(toolStatusUnsettled("pending")).toBe(true)
    expect(toolStatusUnsettled("in_progress")).toBe(true)
  })
})

describe("isUnsettledToolCall", () => {
  it("is true for a running (live) part regardless of status", () => {
    expect(isUnsettledToolCall(part({ state: "input-available" }))).toBe(true)
    expect(isUnsettledToolCall(part({ state: "input-streaming" }))).toBe(true)
  })

  it("is true for a promoted orphan: output-available but status unsettled", () => {
    expect(
      isUnsettledToolCall(
        part({ state: "output-available", toolStatus: "pending" })
      )
    ).toBe(true)
  })

  it("is false for a settled part (output-available, no/terminal status)", () => {
    expect(isUnsettledToolCall(part({ state: "output-available" }))).toBe(false)
    expect(
      isUnsettledToolCall(
        part({ state: "output-available", toolStatus: "completed" })
      )
    ).toBe(false)
  })
})
