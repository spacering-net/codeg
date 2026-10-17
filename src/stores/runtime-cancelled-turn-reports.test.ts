/**
 * A stopped turn's late tool-call reports (`ConnectionState.cancelledTurn`
 * → `APPLY_CANCELLED_TURN_REPORTS`).
 *
 * codeg ends a turn the moment the user stops it, so the reports that close the
 * turn's open calls reach a turn the panel already promoted. Covered:
 *  - a stopped command's card takes the report that closed it (`failed`, the
 *    CLI's refusal) instead of reading as completed;
 *  - a stopped sub-agent's card takes its own closing and its child call's, in
 *    either order;
 *  - a card the turn did not leave open is never revised — an async
 *    sub-agent's launch card keeps the lifecycle marker written on it;
 *  - reports that land before the turn is promoted are applied when it is,
 *    whichever copy of the message the promotion is handed;
 *  - nothing changes without an open session, or when no card moved.
 *
 * Fixtures follow claude-agent-acp 0.91.0's frames for a stopped `sleep 30`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import {
  adaptMessageTurn,
  type AdaptedContentPart,
  type AdaptedToolCallPart,
} from "@/lib/adapters/ai-elements-adapter"
import { BACKGROUND_TASK_MARKER } from "@/lib/background-agent"
import type {
  CancelledTurnReports,
  LiveMessage,
  ToolCallInfo,
} from "@/contexts/acp-connections-context"
import type { ContentBlock, MessageTurn } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
}))

const REFUSAL =
  "```\nThe user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.\n```"
const TURN_CANCELLED =
  "The turn was cancelled before this tool call returned a result."

function call(
  id: string,
  overrides: Partial<ToolCallInfo> & { toolName: string; parent?: string }
): ToolCallInfo {
  const { toolName, parent, ...rest } = overrides
  return {
    tool_call_id: id,
    title: toolName,
    kind: toolName === "Bash" ? "execute" : "think",
    status: "pending",
    content: null,
    raw_input: null,
    raw_output_chunks: [],
    raw_output_total_bytes: 0,
    locations: null,
    meta: {
      claudeCode: { toolName, ...(parent ? { parentToolUseId: parent } : {}) },
    },
    images: [],
    ...rest,
  }
}

function message(id: string, calls: ToolCallInfo[]): LiveMessage {
  return {
    id,
    role: "assistant",
    startedAt: 0,
    content: [
      { type: "text", text: "On it." },
      ...calls.map((info) => ({ type: "tool_call" as const, info })),
    ],
  }
}

/** `message` with `id`'s call revised the way a report revises it. */
function reported(
  stopped: LiveMessage,
  id: string,
  report: Partial<ToolCallInfo>
): LiveMessage {
  return {
    ...stopped,
    content: stopped.content.map((block) =>
      block.type === "tool_call" && block.info.tool_call_id === id
        ? { type: "tool_call", info: { ...block.info, ...report } }
        : block
    ),
  }
}

const BASH = call("toolu_bash", {
  toolName: "Bash",
  title: "sleep 30; echo never",
  raw_input: JSON.stringify({
    command: "sleep 30; echo never",
    description: "probe command",
  }),
  content: "probe command",
})

function actions() {
  return useConversationRuntimeStore.getState().actions
}

function localTurns(conversationId = 7): MessageTurn[] {
  return (
    useConversationRuntimeStore.getState().byConversationId.get(conversationId)
      ?.localTurns ?? []
  )
}

function blocksOf(id: string): ContentBlock[] {
  return localTurns()
    .flatMap((t) => t.blocks)
    .filter(
      (b) =>
        (b.type === "tool_use" || b.type === "tool_result") &&
        b.tool_use_id === id
    )
}

/** The rendered tool-call part for `id`, out of a tool group if need be. */
function renderedCard(id: string): AdaptedToolCallPart {
  const parts: AdaptedContentPart[] = localTurns().flatMap(
    (turn) =>
      adaptMessageTurn(turn, {
        attachedResources: "Attached resources",
        toolCallFailed: "Tool failed",
        pageHandoffName: () => "page",
      }).content
  )
  for (const part of parts) {
    if (part.type === "tool-call" && part.toolCallId === id) return part
    if (part.type === "tool-group") {
      const item = part.items.find((p) => p.toolCallId === id)
      if (item) return item
    }
  }
  throw new Error(`no card for ${id}`)
}

/** The panel's promotion of a turn the user stopped. */
function promote(stopped: LiveMessage) {
  actions().setLiveMessage(7, stopped, true)
  actions().completeTurn(7)
}

/** The connection's record of a stopped turn: its message with the reports
 *  folded in, and the calls it left open. */
function reports(
  message: LiveMessage,
  openCalls: string[]
): CancelledTurnReports {
  return { message, openCalls: new Set(openCalls) }
}

beforeEach(() => {
  resetConversationRuntimeStore()
})

afterEach(() => {
  resetConversationRuntimeStore()
})

describe("APPLY_CANCELLED_TURN_REPORTS", () => {
  it("settles a stopped command's card with the report that closed it", () => {
    const stopped = message("lm-1", [BASH])
    promote(stopped)
    // What the promoted card shows without the report: completed, with the
    // command's description for output.
    expect(renderedCard("toolu_bash").state).toBe("output-available")

    actions().applyCancelledTurnReports(
      7,
      reports(
        reported(stopped, "toolu_bash", { status: "failed", content: REFUSAL }),
        ["toolu_bash"]
      )
    )

    expect(blocksOf("toolu_bash")).toMatchObject([
      { type: "tool_use", status: "failed" },
      { type: "tool_result", output_preview: REFUSAL, is_error: true },
    ])
    const card = renderedCard("toolu_bash")
    expect(card.state).toBe("output-error")
    expect(card.errorText).toBe(REFUSAL)
  })

  describe("a stopped sub-agent", () => {
    const agent = call("toolu_agent", {
      toolName: "Agent",
      title: "Task",
      raw_input: JSON.stringify({
        description: "probe",
        prompt: "SUBAGENT_BASH:sleep 30",
      }),
      content: "SUBAGENT_BASH:sleep 30",
    })
    const child = call("toolu_child", {
      toolName: "Bash",
      parent: "toolu_agent",
      raw_input: JSON.stringify({ command: "sleep 30" }),
    })
    const stopped = message("lm-2", [agent, child])
    const open = ["toolu_agent", "toolu_child"]
    const agentClosed = (from: LiveMessage) =>
      reported(from, "toolu_agent", { status: "failed", content: REFUSAL })
    const childClosed = (from: LiveMessage) =>
      reported(from, "toolu_child", {
        status: "failed",
        content: TURN_CANCELLED,
      })

    function expectBothSettled() {
      const [use, result] = blocksOf("toolu_agent")
      expect(use).toMatchObject({ type: "tool_use", status: "failed" })
      expect(result).toMatchObject({
        type: "tool_result",
        is_error: true,
        agent_stats: {
          tool_calls: [{ output_preview: TURN_CANCELLED, is_error: true }],
        },
      })
      if (result.type !== "tool_result") throw new Error("expected a result")
      expect(result.output_preview).toContain(
        "The user doesn't want to proceed with this tool use."
      )
      // Its child stays nested in the card, never a card of its own.
      expect(blocksOf("toolu_child")).toEqual([])
    }

    // The two closings can reach the frontend in separate batches; the folded
    // message carries the first into the second.
    it("takes its child call's closing, then its own", () => {
      promote(stopped)
      const first = childClosed(stopped)
      actions().applyCancelledTurnReports(7, reports(first, open))
      expect(blocksOf("toolu_agent")).toMatchObject([
        { type: "tool_use", status: "pending" },
        {
          type: "tool_result",
          is_error: false,
          agent_stats: {
            tool_calls: [{ output_preview: TURN_CANCELLED, is_error: true }],
          },
        },
      ])
      actions().applyCancelledTurnReports(7, reports(agentClosed(first), open))
      expectBothSettled()
    })

    // claude-agent-acp 0.91.0 closes the Agent call first: its card has
    // settled by the time its child's closing lands, and still takes it.
    it("takes its own closing, then its child call's", () => {
      promote(stopped)
      const first = agentClosed(stopped)
      actions().applyCancelledTurnReports(7, reports(first, open))
      expect(blocksOf("toolu_agent")).toMatchObject([
        { type: "tool_use", status: "failed" },
        {
          type: "tool_result",
          is_error: true,
          agent_stats: { tool_calls: [{ is_error: false }] },
        },
      ])
      actions().applyCancelledTurnReports(7, reports(childClosed(first), open))
      expectBothSettled()
    })
  })

  it("never revises a card the turn did not leave open: a launch card keeps its lifecycle marker", () => {
    const launch = call("toolu_bg", {
      toolName: "Agent",
      title: "Task",
      status: "completed",
      content: "Async agent launched successfully.\nagentId: a1",
    })
    const child = call("toolu_bgchild", {
      toolName: "Bash",
      parent: "toolu_bg",
      raw_input: JSON.stringify({ command: "sleep 30" }),
    })
    const stopped = message("lm-3", [launch, child])
    promote(stopped)
    actions().resolveBackgroundTask(7, {
      toolUseId: "toolu_bg",
      taskId: "a1",
      status: "killed",
      summary: "Agent stopped",
      result: "",
    })
    const before = localTurns()

    actions().applyCancelledTurnReports(
      7,
      reports(
        reported(stopped, "toolu_bgchild", {
          status: "failed",
          content: TURN_CANCELLED,
        }),
        ["toolu_bgchild"]
      )
    )

    expect(localTurns()).toBe(before)
    const [, result] = blocksOf("toolu_bg")
    if (result?.type !== "tool_result") throw new Error("expected a result")
    expect(result.output_preview).toContain(BACKGROUND_TASK_MARKER)
  })

  // The delegated-child view promotes from an effect, handing COMPLETE_TURN
  // its own copy of the message: a report that landed first still applies.
  it("applies reports that land before the promotion when the turn is promoted", () => {
    const stopped = message("lm-4", [BASH])
    actions().setLiveMessage(7, stopped, true)

    actions().applyCancelledTurnReports(
      7,
      reports(
        reported(stopped, "toolu_bash", { status: "failed", content: REFUSAL }),
        ["toolu_bash"]
      )
    )
    expect(localTurns()).toEqual([])
    actions().completeTurn(7, stopped)

    expect(blocksOf("toolu_bash")).toMatchObject([
      { type: "tool_use", status: "failed" },
      { type: "tool_result", output_preview: REFUSAL, is_error: true },
    ])
    expect(
      useConversationRuntimeStore.getState().byConversationId.get(7)
        ?.pendingCancelledTurnReports
    ).toBeNull()
  })

  // Held reports belong to their message: one replaced before it was
  // promoted never lends them to the promotion of another.
  it("drops held reports when another message is promoted", () => {
    const stopped = message("lm-6", [BASH])
    actions().setLiveMessage(7, stopped, true)
    actions().applyCancelledTurnReports(
      7,
      reports(
        reported(stopped, "toolu_bash", { status: "failed", content: REFUSAL }),
        ["toolu_bash"]
      )
    )

    // A different message carrying a call of the same id, so that applying
    // the held reports to it would show.
    const other = message("lm-7", [BASH])
    actions().setLiveMessage(7, other, true)
    actions().completeTurn(7)

    expect(blocksOf("toolu_bash")).toMatchObject([
      { type: "tool_use", status: "pending" },
      { type: "tool_result", is_error: false },
    ])
    expect(
      useConversationRuntimeStore.getState().byConversationId.get(7)
        ?.pendingCancelledTurnReports
    ).toBeNull()
  })

  it("changes nothing without an open session, or when no card moved", () => {
    const stopped = message("lm-5", [BASH])
    actions().applyCancelledTurnReports(9, reports(stopped, ["toolu_bash"]))
    expect(useConversationRuntimeStore.getState().byConversationId.has(9)).toBe(
      false
    )

    promote(stopped)
    const state = useConversationRuntimeStore.getState()
    actions().applyCancelledTurnReports(7, reports(stopped, ["toolu_bash"]))
    expect(useConversationRuntimeStore.getState()).toBe(state)
  })
})
