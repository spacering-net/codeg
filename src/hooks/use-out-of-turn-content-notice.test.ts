import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { EventEnvelope } from "@/lib/types"

// The handler `useAcpEvent` registers, so tests can fire envelopes at it.
let fire: ((envelope: EventEnvelope) => void) | null = null
// What the connection store holds for the tab, read at event time.
let stored:
  | { status: string; hasPrompted: boolean; agentType: string }
  | undefined
const markOutOfTurnContent = vi.fn()

vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpEvent: (handler: (envelope: EventEnvelope) => void) => {
    fire = handler
  },
  useConnectionStore: () => ({ getConnection: () => stored }),
}))
vi.mock("@/stores/conversation-runtime-store", () => {
  const actions = {
    markOutOfTurnContent: (id: number) => markOutOfTurnContent(id),
  }
  return { useConversationRuntimeActions: () => actions }
})

import { useOutOfTurnContentNotice } from "./use-out-of-turn-content-notice"

const CONVERSATION = -42

function mount() {
  renderHook(() => useOutOfTurnContentNotice("tab-1", "conn-1", CONVERSATION))
}

const text = (connectionId = "conn-1"): EventEnvelope => ({
  seq: 10,
  connection_id: connectionId,
  type: "content_delta",
  text: "Continuing the goal.",
})

const toolCall = (toolCallId: string): EventEnvelope => ({
  seq: 11,
  connection_id: "conn-1",
  type: "tool_call",
  tool_call_id: toolCallId,
  title: "mcp__codeg-mcp__startup",
  kind: "other",
  status: "failed",
  content: null,
  raw_input: null,
  raw_output: null,
})

beforeEach(() => {
  fire = null
  stored = undefined
  markOutOfTurnContent.mockReset()
})

describe("useOutOfTurnContentNotice", () => {
  it("flags a turn the agent runs on its own after one of ours", () => {
    stored = { status: "connected", hasPrompted: true, agentType: "codex" }
    mount()
    fire!(text())
    expect(markOutOfTurnContent).toHaveBeenCalledWith(CONVERSATION)
  })

  it("flags nothing a new conversation's agent sends before its first turn", () => {
    // codex-acp reporting a codeg-mcp that failed to start, while the welcome
    // screen hides the thread — the notice then showed with the first message.
    stored = { status: "connected", hasPrompted: false, agentType: "codex" }
    mount()
    fire!(toolCall("mcp_startup.codeg-mcp.4f1c2b9e"))
    fire!(toolCall("call_1"))
    fire!(text())
    expect(markOutOfTurnContent).not.toHaveBeenCalled()
  })

  it("never flags codex-acp's MCP start-up report, even after a turn", () => {
    // A server slow to fail reports after a quick first turn has ended.
    stored = { status: "connected", hasPrompted: true, agentType: "codex" }
    mount()
    fire!(toolCall("mcp_startup.codeg-mcp.4f1c2b9e"))
    expect(markOutOfTurnContent).not.toHaveBeenCalled()
    fire!(toolCall("call_1"))
    expect(markOutOfTurnContent).toHaveBeenCalledTimes(1)
  })

  it("leaves the running turn's content to the turn", () => {
    stored = { status: "prompting", hasPrompted: true, agentType: "codex" }
    mount()
    fire!(text())
    expect(markOutOfTurnContent).not.toHaveBeenCalled()
  })

  it("reads the connection when the envelope arrives, not when it mounted", () => {
    stored = { status: "prompting", hasPrompted: true, agentType: "codex" }
    mount()
    fire!(text())
    // The turn ended after mount; the next envelope is out of turn.
    stored = { status: "connected", hasPrompted: true, agentType: "codex" }
    fire!(text())
    expect(markOutOfTurnContent).toHaveBeenCalledTimes(1)
  })

  it("ignores other connections and agents with a transcript overlay", () => {
    stored = { status: "connected", hasPrompted: true, agentType: "codex" }
    mount()
    fire!(text("conn-2"))
    stored = {
      status: "connected",
      hasPrompted: true,
      agentType: "claude_code",
    }
    fire!(text())
    expect(markOutOfTurnContent).not.toHaveBeenCalled()
  })
})
