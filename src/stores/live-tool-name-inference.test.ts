/**
 * The tool name a live tool call is drawn as. A streaming turn is rebuilt from
 * the live message on every token; the name inferred for each call is kept
 * with the call's info, which an update replaces rather than changes.
 */

import { describe, expect, it, vi } from "vitest"

import { buildStreamingTurnsFromLiveMessage } from "@/stores/conversation-runtime-store"
import type { LiveMessage } from "@/contexts/acp-connections-context"
import { inferLiveToolName } from "@/lib/tool-call-normalization"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
}))

vi.mock("@/lib/tool-call-normalization", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/tool-call-normalization")>()
  return { ...actual, inferLiveToolName: vi.fn(actual.inferLiveToolName) }
})

function info(overrides: { title: string; kind: string; raw_input: string }) {
  return {
    tool_call_id: "call-1",
    status: "in_progress",
    content: null,
    raw_output_chunks: [],
    raw_output_total_bytes: 0,
    locations: null,
    meta: null,
    images: [],
    ...overrides,
  }
}

function live(callInfo: ReturnType<typeof info>): LiveMessage {
  return {
    id: "lm-1",
    role: "assistant",
    startedAt: 0,
    content: [{ type: "tool_call", info: callInfo }],
  }
}

function toolNames(message: LiveMessage): string[] {
  return buildStreamingTurnsFromLiveMessage(1, message).turns.flatMap((turn) =>
    turn.blocks.flatMap((block) =>
      block.type === "tool_use" ? [block.tool_name] : []
    )
  )
}

describe("buildStreamingTurnsFromLiveMessage — tool names", () => {
  const reading = info({
    title: "Read file '/w/a.txt'",
    kind: "read",
    raw_input: JSON.stringify({ file_path: "/w/a.txt" }),
  })

  it("names a call once while its info stands, however often it rebuilds", () => {
    const first = toolNames(live(reading))
    expect(first).toHaveLength(1)
    const inferred = vi.mocked(inferLiveToolName).mock.calls.length
    expect(toolNames(live(reading))).toEqual(first)
    expect(toolNames(live(reading))).toEqual(first)
    expect(vi.mocked(inferLiveToolName).mock.calls.length).toBe(inferred)
  })

  it("names a call afresh once an update replaces its info", () => {
    const before = toolNames(live(reading))
    const after = toolNames(
      live(
        info({
          title: "Terminal",
          kind: "execute",
          raw_input: JSON.stringify({ command: "ls -la" }),
        })
      )
    )
    expect(after).toHaveLength(1)
    expect(after).not.toEqual(before)
  })
})
