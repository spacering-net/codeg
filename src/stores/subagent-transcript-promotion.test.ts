/**
 * Subagent transcript lifecycle across settle and promotion.
 *
 * Covered invariants:
 *  - the FINAL branch of `buildStreamingTurnsFromLiveMessage` attaches the
 *    collected `agent_transcript` to the Agent card's tool_result (it used to
 *    attach stats only, which erased the interleaved order the running card
 *    had shown);
 *  - the COMPLETE_TURN promotion keeps that transcript on the promoted
 *    `localTurns` copy (it used to promote without it);
 *  - the transcript stays OUT of the main thread either way — the child's
 *    text/thinking never appears as top-level blocks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  buildStreamingTurnsFromLiveMessage,
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import type { LiveMessage } from "@/contexts/acp-connections-context"
import type { ContentBlock } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
}))

function toolCallInfo(overrides: {
  tool_call_id: string
  title: string
  status: string
  meta?: Record<string, unknown> | null
}) {
  return {
    tool_call_id: overrides.tool_call_id,
    title: overrides.title,
    kind: "other",
    status: overrides.status,
    content: null,
    raw_input: "{}",
    raw_output_chunks: [],
    raw_output_total_bytes: 0,
    locations: null,
    meta: overrides.meta ?? null,
    images: [],
  }
}

/** An Agent launch (settled) followed by the child's prose and its own tool
 *  call, parented through claude-agent-acp's attribution meta. */
function agentLiveMessage(overrides?: { childStatus?: string }): LiveMessage {
  return {
    id: "lm-agent-1",
    role: "assistant",
    startedAt: 0,
    content: [
      {
        type: "tool_call",
        info: toolCallInfo({
          tool_call_id: "agent-1",
          title: "Agent",
          status: "completed",
        }),
      },
      {
        type: "thinking",
        text: "child plans",
        parentToolUseId: "agent-1",
      },
      { type: "text", text: "child reports", parentToolUseId: "agent-1" },
      {
        type: "tool_call",
        info: toolCallInfo({
          tool_call_id: "child-read-1",
          title: "Read file '/w/a.txt'",
          status: overrides?.childStatus ?? "completed",
          meta: { claudeCode: { parentToolUseId: "agent-1" } },
        }),
      },
    ],
  }
}

function agentResultBlock(blocks: ContentBlock[]): ContentBlock | undefined {
  return blocks.find(
    (b) => b.type === "tool_result" && b.tool_use_id === "agent-1"
  )
}

beforeEach(() => {
  resetConversationRuntimeStore()
})

afterEach(() => {
  resetConversationRuntimeStore()
})

describe("buildStreamingTurnsFromLiveMessage — settled agent transcript", () => {
  it("attaches the interleaved transcript to the final Agent tool_result", () => {
    const { turns } = buildStreamingTurnsFromLiveMessage(7, agentLiveMessage())
    const result = agentResultBlock(turns[0]?.blocks ?? [])
    if (result?.type !== "tool_result") {
      throw new Error("expected the Agent's tool_result block")
    }
    expect(result.agent_stats?.tool_calls).toEqual([
      {
        tool_name: "read",
        input_preview: "{}",
        output_preview: null,
        is_error: false,
      },
    ])
    // Arrival order preserved: thinking → text → the child's own call.
    expect(result.agent_transcript).toEqual([
      { type: "thinking", text: "child plans" },
      { type: "text", text: "child reports" },
      { type: "tool_call", childIndex: 0 },
    ])
  })

  it("keeps the child's prose out of the main thread", () => {
    const { turns } = buildStreamingTurnsFromLiveMessage(7, agentLiveMessage())
    const texts = turns
      .flatMap((t) => t.blocks)
      .filter((b) => b.type === "text" || b.type === "thinking")
      .map((b) => ("text" in b ? b.text : ""))
    expect(texts).toEqual([])
  })
})

describe("COMPLETE_TURN promotion — agent transcript", () => {
  it("carries the transcript onto the promoted localTurns", () => {
    const actions = useConversationRuntimeStore.getState().actions
    // Production order: the panel holds the session (materialized here by the
    // live sink) when the turn completes.
    actions.setLiveMessage(7, agentLiveMessage())
    actions.completeTurn(7, agentLiveMessage())

    const localTurns =
      useConversationRuntimeStore.getState().byConversationId.get(7)
        ?.localTurns ?? []
    const result = agentResultBlock(localTurns[0]?.blocks ?? [])
    if (result?.type !== "tool_result") {
      throw new Error("expected the Agent's tool_result block in localTurns")
    }
    expect(result.agent_transcript).toEqual([
      { type: "thinking", text: "child plans" },
      { type: "text", text: "child reports" },
      { type: "tool_call", childIndex: 0 },
    ])
    expect(result.agent_stats?.tool_calls).toHaveLength(1)
  })
})
