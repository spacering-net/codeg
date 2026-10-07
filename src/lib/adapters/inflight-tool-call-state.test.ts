/**
 * `inProgressToolCallIds` is the ONE knob that keeps a still-running tool call
 * out of the settled visual state, and it must work for an UNMATCHED call too
 * (a `tool_use` whose `tool_result` hasn't been written yet), not just for a
 * matched one with partial output.
 *
 * Before this, a persisted turn was adapted as `output-available` on the
 * grounds that "the conversation has already ended" — false for a conversation
 * running right now that this client isn't streaming. The delegation cards then
 * translated that into a green ✓ on a poll that was still blocking.
 *
 * The set is supplied by the caller from the backend's `in_flight_user_turn_id`
 * (see `conversation-runtime-store`), never inferred from missing output.
 */

import { describe, expect, it } from "vitest"

import {
  adaptMessageTurn,
  type AdaptedContentPart,
  type AdaptedToolCallPart,
  type AdapterMessageText,
} from "@/lib/adapters/ai-elements-adapter"
import { deriveBadge, parseStatusReports } from "@/lib/delegation-status"
import { parseToolOutput, resolveDelegationStatus } from "@/lib/delegation-card"
import type { ContentBlock, MessageTurn } from "@/lib/types"

const TEXT: AdapterMessageText = {
  attachedResources: "attached",
  toolCallFailed: "Tool failed",
  pageHandoffName: () => "",
}

function turnWith(blocks: ContentBlock[]): MessageTurn {
  return {
    id: "a1",
    role: "assistant",
    blocks,
    timestamp: "2026-08-10T00:00:00.000Z",
  }
}

/** Tool calls in render order, unwrapping the `tool-group` a run of generic
 *  tools folds into (only the agent-like lanes stay standalone). */
function toolParts(parts: AdaptedContentPart[]): AdaptedToolCallPart[] {
  return parts.flatMap((p) =>
    p.type === "tool-call" ? [p] : p.type === "tool-group" ? p.items : []
  )
}

const bash = (id: string): ContentBlock => ({
  type: "tool_use",
  tool_use_id: id,
  tool_name: "Bash",
  input_preview: '{"command":"pnpm build"}',
})

describe("unmatched persisted tool call + inProgressToolCallIds", () => {
  it("stays running when the caller proves the turn is in flight", () => {
    const adapted = adaptMessageTurn(
      turnWith([bash("toolu_a")]),
      TEXT,
      false,
      new Set(["toolu_a"])
    )
    expect(toolParts(adapted.content).map((p) => p.state)).toEqual([
      "input-available",
    ])
  })

  it("still settles when no such proof is supplied (unchanged behavior)", () => {
    const adapted = adaptMessageTurn(turnWith([bash("toolu_a")]), TEXT, false)
    expect(toolParts(adapted.content).map((p) => p.state)).toEqual([
      "output-available",
    ])
  })

  it("marks only the named call, not its settled siblings", () => {
    const adapted = adaptMessageTurn(
      turnWith([bash("toolu_done"), bash("toolu_live")]),
      TEXT,
      false,
      new Set(["toolu_live"])
    )
    expect(toolParts(adapted.content).map((p) => p.state)).toEqual([
      "output-available",
      "input-available",
    ])
  })
})

describe("a MATCHED placeholder result (the grok shape)", () => {
  // The grok parser pairs every call with a placeholder `ToolResult` and
  // backfills it later, so an unfinished call arrives MATCHED — the unmatched
  // branch never sees it. `SubagentSessionDialog` polls a RUNNING child's file
  // and passes the set it derives from the parser's own per-call status.
  const placeholderPair = (id: string): ContentBlock[] => [
    {
      type: "tool_use",
      tool_use_id: id,
      tool_name: "read_file",
      input_preview: '{"target_file":"a.rs"}',
      status: "in_progress",
    },
    {
      type: "tool_result",
      tool_use_id: id,
      output_preview: null,
      is_error: false,
    },
  ]

  it("stays running when the caller marks it", () => {
    const adapted = adaptMessageTurn(
      turnWith(placeholderPair("call-1")),
      TEXT,
      false,
      new Set(["call-1"])
    )
    expect(toolParts(adapted.content).map((p) => p.state)).toEqual([
      "input-available",
    ])
  })

  it("settles when it isn't marked — an unmarked call is never spun", () => {
    const adapted = adaptMessageTurn(
      turnWith(placeholderPair("call-1")),
      TEXT,
      false
    )
    expect(toolParts(adapted.content).map((p) => p.state)).toEqual([
      "output-available",
    ])
  })
})

describe("the delegation cards follow that state", () => {
  const statusPoll = (id: string): ContentBlock => ({
    type: "tool_use",
    tool_use_id: id,
    tool_name: "mcp__codeg-mcp__get_delegation_status",
    input_preview: JSON.stringify({ task_ids: ["task-1"], wait_ms: 0 }),
  })

  it("a blocking status poll badges running, not a green ✓", () => {
    const adapted = adaptMessageTurn(
      turnWith([statusPoll("toolu_poll")]),
      TEXT,
      false,
      new Set(["toolu_poll"])
    )
    // The poll is collapsed into a `delegation-status-group`; pull its poll back
    // out and resolve the badge the card would render.
    const group = adapted.content.find(
      (p) => p.type === "delegation-status-group"
    )
    expect(group).toBeDefined()
    const polls = (group as { polls: AdaptedToolCallPart[] }).polls
    expect(polls).toHaveLength(1)
    expect(polls[0].state).toBe("input-available")
    const badge = deriveBadge(
      "status",
      parseStatusReports(polls[0].output, polls[0].errorText)[0],
      polls[0].state,
      !!polls[0].errorText
    )
    expect(badge.status).toBe("running")
  })

  it("the same poll without the proof still badges ok — the bug this fixes", () => {
    const adapted = adaptMessageTurn(
      turnWith([statusPoll("toolu_poll")]),
      TEXT,
      false
    )
    const group = adapted.content.find(
      (p) => p.type === "delegation-status-group"
    )
    const polls = (group as { polls: AdaptedToolCallPart[] }).polls
    const badge = deriveBadge(
      "status",
      parseStatusReports(polls[0].output, polls[0].errorText)[0],
      polls[0].state,
      !!polls[0].errorText
    )
    expect(badge.status).toBe("ok")
  })

  it("an in-flight delegate_to_agent no longer resolves to ok", () => {
    expect(
      resolveDelegationStatus({
        binding: undefined,
        parsedMeta: null,
        toolOutput: parseToolOutput(null),
        state: "input-available",
        errorText: null,
        childAwaitingPermission: false,
      })
    ).not.toBe("ok")
  })
})
