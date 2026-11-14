import { afterEach, describe, expect, it } from "vitest"

import type {
  LiveContentBlock,
  LiveMessage,
  ToolCallInfo,
} from "@/contexts/acp-connections-context"
import {
  buildStreamingTurnsFromLiveMessage,
  resetConversationRuntimeStore,
} from "./conversation-runtime-store"

function bash(
  id: string,
  status: "in_progress" | "completed",
  output: string | null = null
): LiveContentBlock {
  const info: ToolCallInfo = {
    tool_call_id: id,
    title: "`pnpm test`",
    kind: "execute",
    status,
    content: output,
    raw_input: JSON.stringify({ command: "pnpm test" }),
    raw_output_chunks: [],
    raw_output_total_bytes: 0,
    locations: null,
    meta: { claudeCode: { toolName: "Bash" } },
    images: [],
  }
  return { type: "tool_call", info }
}

function message(content: LiveContentBlock[]): LiveMessage {
  return { id: "m1", role: "assistant", content, startedAt: 1_700_000_000_000 }
}

afterEach(() => {
  resetConversationRuntimeStore()
})

describe("buildStreamingTurnsFromLiveMessage — rebuilt on every batch", () => {
  // Three rounds: words and a finished call each, then the round being written.
  const settled: LiveContentBlock[] = [
    { type: "text", text: "Running the first suite." },
    bash("t1", "completed", "1 passed"),
    { type: "text", text: "Now the second." },
    bash("t2", "completed", "2 passed"),
  ]

  it("hands back the rounds that did not change as the objects it built", () => {
    const first = buildStreamingTurnsFromLiveMessage(
      1,
      message([...settled, { type: "text", text: "And the" }])
    )
    const second = buildStreamingTurnsFromLiveMessage(
      1,
      message([...settled, { type: "text", text: "And the third." }])
    )
    expect(second.turns).toHaveLength(3)
    expect(second.turns[0]).toBe(first.turns[0])
    expect(second.turns[1]).toBe(first.turns[1])
    // The round being written is new, and reads as written.
    expect(second.turns[2]).not.toBe(first.turns[2])
    expect(second.turns[2]!.blocks).toEqual([
      { type: "text", text: "And the third." },
    ])
    expect(second.inProgressToolCallIds).toBe(first.inProgressToolCallIds)
  })

  it("hands back the whole list when nothing changed", () => {
    const content = [...settled, bash("t3", "in_progress", "running…")]
    const first = buildStreamingTurnsFromLiveMessage(1, message(content))
    const second = buildStreamingTurnsFromLiveMessage(1, message([...content]))
    expect(second.turns).toBe(first.turns)
    expect(second.inProgressToolCallIds).toBe(first.inProgressToolCallIds)
  })

  it("rebuilds a round once one of its calls lands", () => {
    const running = buildStreamingTurnsFromLiveMessage(
      1,
      message([...settled, bash("t3", "in_progress", "running…")])
    )
    const landed = buildStreamingTurnsFromLiveMessage(
      1,
      message([...settled, bash("t3", "completed", "3 passed")])
    )
    // The call joins the second round: no words came between the two calls.
    expect(landed.turns).toHaveLength(2)
    expect(landed.turns[0]).toBe(running.turns[0])
    expect(landed.turns[1]).not.toBe(running.turns[1])
    expect(landed.inProgressToolCallIds).not.toBe(running.inProgressToolCallIds)
    expect([...landed.inProgressToolCallIds]).toEqual([])
    const blocks = landed.turns[1]!.blocks
    expect(blocks[blocks.length - 1]).toMatchObject({
      type: "tool_result",
      output_preview: "3 passed",
    })
  })

  it("keeps each live message's rounds apart", () => {
    const content = [...settled]
    const first = buildStreamingTurnsFromLiveMessage(1, message(content))
    const other = buildStreamingTurnsFromLiveMessage(2, message(content))
    expect(other.turns[0]).not.toBe(first.turns[0])
    expect(other.turns[0]!.id).not.toBe(first.turns[0]!.id)
  })
})
