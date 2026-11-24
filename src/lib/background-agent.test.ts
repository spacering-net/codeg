import { describe, expect, it } from "vitest"
import {
  BACKGROUND_TASK_MARKER,
  hasTranscriptOverlay,
  isAsyncLaunchAckText,
  isOutOfTurnContentEvent,
  isUnrenderedAgentTurnContent,
  parseBackgroundTaskMarker,
} from "@/lib/background-agent"

describe("parseBackgroundTaskMarker", () => {
  it("parses a settled marker", () => {
    const output = `${BACKGROUND_TASK_MARKER}{"task_id":"abc123","status":"completed","summary":"Agent \\"Run pnpm build\\" finished","result":"Build OK"}`
    expect(parseBackgroundTaskMarker(output)).toEqual({
      taskId: "abc123",
      status: "completed",
      summary: 'Agent "Run pnpm build" finished',
      result: "Build OK",
      interim: false,
    })
  })

  // The detail parse and the live settle both add `"interim": true` when the
  // sub-agent's notification says it will notify again.
  it("parses an interim marker", () => {
    const output = `${BACKGROUND_TASK_MARKER}{"task_id":"a0a4","status":"completed","summary":"Agent \\"probe\\" is waiting on its own background work","result":"ok","interim":true}`
    expect(parseBackgroundTaskMarker(output)).toEqual({
      taskId: "a0a4",
      status: "completed",
      summary: 'Agent "probe" is waiting on its own background work',
      result: "ok",
      interim: true,
    })
    // Anything but `true` is no interim flag.
    expect(
      parseBackgroundTaskMarker(
        `${BACKGROUND_TASK_MARKER}{"task_id":"a0a4","status":"completed","summary":null,"result":null,"interim":"yes"}`
      )?.interim
    ).toBe(false)
  })

  it("parses an unsettled marker (null status — never rendered as running)", () => {
    const output = `${BACKGROUND_TASK_MARKER}{"task_id":"nores99","status":null,"summary":null,"result":null}`
    expect(parseBackgroundTaskMarker(output)).toEqual({
      taskId: "nores99",
      status: null,
      summary: null,
      result: null,
      interim: false,
    })
  })

  it("rejects non-marker output, malformed JSON, and missing task_id", () => {
    expect(parseBackgroundTaskMarker(null)).toBeNull()
    expect(parseBackgroundTaskMarker("plain tool output")).toBeNull()
    expect(
      parseBackgroundTaskMarker(`${BACKGROUND_TASK_MARKER}{not json`)
    ).toBeNull()
    expect(
      parseBackgroundTaskMarker(
        `${BACKGROUND_TASK_MARKER}{"status":"completed"}`
      )
    ).toBeNull()
  })
})

describe("isAsyncLaunchAckText", () => {
  it("matches the live wire ack and nothing else", () => {
    expect(
      isAsyncLaunchAckText(
        "Async agent launched successfully. (This tool result is internal metadata…)\nagentId: a793c…"
      )
    ).toBe(true)
    expect(isAsyncLaunchAckText("Sub-agent finished: all tests pass")).toBe(
      false
    )
    expect(isAsyncLaunchAckText(null)).toBe(false)
  })

  it("matches OpenCode 2's background subagent acknowledgement", () => {
    // packages/core/src/tool/plugin/subagent.ts `backgroundResult`, 2.2.0.
    expect(
      isAsyncLaunchAckText(
        "The subagent is working in the background (sessionID: ses_e825797d9ffeJ5H3F2cPQH0euo). You will be notified automatically when it finishes."
      )
    ).toBe(true)
  })

  it("matches Grok's spawn_subagent background ack (leading position only)", () => {
    expect(
      isAsyncLaunchAckText(
        'Subagent started in background.\nsubagent_id: 019f9432-e0d8-74c3-bd02-0772c4e04a65\ntype: explore\n\nUse get_command_or_subagent_output with task_ids=["019f9432…"] and timeout_ms to wait for results.'
      )
    ).toBe(true)
    // Anchored at the start: a result that merely QUOTES the ack is not a launch.
    expect(
      isAsyncLaunchAckText(
        "The tool said: Subagent started in background.\nsubagent_id: x"
      )
    ).toBe(false)
  })
})

describe("hasTranscriptOverlay", () => {
  it("is true only for the agent whose transcript watcher is armed", () => {
    // Mirrors `background_watch.rs::spawn_if_claude`, which returns None for
    // every other agent — so nothing produces `background_activity` overlay
    // turns for them and their out-of-turn content renders nowhere.
    expect(hasTranscriptOverlay("claude_code")).toBe(true)
    for (const agent of ["code_buddy", "codex", "gemini", "custom:acme"]) {
      expect(hasTranscriptOverlay(agent)).toBe(false)
    }
  })
})

describe("isOutOfTurnContentEvent", () => {
  it("accepts new turn material", () => {
    expect(isOutOfTurnContentEvent({ type: "content_delta", text: "hi" })).toBe(
      true
    )
    expect(isOutOfTurnContentEvent({ type: "thinking", text: "hmm" })).toBe(
      true
    )
    // No text field at all, and none needed: a tool call IS the material.
    expect(isOutOfTurnContentEvent({ type: "tool_call" })).toBe(true)
  })

  it("rejects revisions of material already on screen", () => {
    expect(isOutOfTurnContentEvent({ type: "tool_call_update" })).toBe(false)
    expect(isOutOfTurnContentEvent({ type: "plan_update" })).toBe(false)
    expect(isOutOfTurnContentEvent({ type: "turn_complete" })).toBe(false)
  })

  it("rejects empty deltas — a re-read would surface nothing", () => {
    expect(isOutOfTurnContentEvent({ type: "content_delta", text: "" })).toBe(
      false
    )
    expect(isOutOfTurnContentEvent({ type: "thinking", text: "" })).toBe(false)
    expect(isOutOfTurnContentEvent({ type: "content_delta" })).toBe(false)
  })

  it("ignores trailing newlines and whitespace without suppressing subsequent background text", () => {
    // Captured after Stop: turn_complete(cancelled), connected, then "\n".
    // No cancellation timer/state is needed: meaningful output must remain
    // recoverable even when an autonomous task resumes after an interruption.
    for (const text of ["\n", "\r\n", " ", "\t", "\u00a0", "\u3000"]) {
      expect(isOutOfTurnContentEvent({ type: "content_delta", text })).toBe(
        false
      )
      expect(isOutOfTurnContentEvent({ type: "thinking", text })).toBe(false)
    }
    expect(
      isOutOfTurnContentEvent({
        type: "content_delta",
        text: "Background result",
      })
    ).toBe(true)
    expect(isOutOfTurnContentEvent({ type: "tool_call" })).toBe(true)
  })

  it("keeps indented code and text-bearing whitespace chunks recoverable", () => {
    expect(
      isOutOfTurnContentEvent({ type: "content_delta", text: "  return 1\n" })
    ).toBe(true)
    expect(
      isOutOfTurnContentEvent({ type: "thinking", text: "\nnext step\n" })
    ).toBe(true)
  })

  it("rejects codex-acp's MCP start-up report, which no transcript holds", () => {
    // As codex-acp 2.2.2 sends it for a codeg-mcp that could not start: right
    // after session/new, before any prompt.
    expect(
      isOutOfTurnContentEvent({
        type: "tool_call",
        tool_call_id:
          "mcp_startup.codeg-mcp.4f1c2b9e-8d7a-4c3e-9b1a-2f6d5e8c7a90",
      })
    ).toBe(false)
    // Every other tool call is still turn material, whatever its id.
    expect(
      isOutOfTurnContentEvent({ type: "tool_call", tool_call_id: "call_1" })
    ).toBe(true)
    expect(
      isOutOfTurnContentEvent({
        type: "tool_call",
        tool_call_id: "mcp__codeg-mcp__check_user_feedback",
      })
    ).toBe(true)
  })
})

describe("isUnrenderedAgentTurnContent", () => {
  const connection = (
    over: Partial<{ status: string; hasPrompted: boolean; agentType: string }>
  ) => ({ status: "connected", hasPrompted: true, agentType: "codex", ...over })

  it("flags content after a turn has run, outside one", () => {
    expect(isUnrenderedAgentTurnContent(connection({}))).toBe(true)
    expect(
      isUnrenderedAgentTurnContent(connection({ agentType: "code_buddy" }))
    ).toBe(true)
  })

  it("leaves content of the running turn to the turn", () => {
    expect(
      isUnrenderedAgentTurnContent(connection({ status: "prompting" }))
    ).toBe(false)
  })

  it("ignores what an agent sends before its first turn", () => {
    // A new conversation's agent reporting an MCP server that failed to start,
    // while the welcome screen still hides the thread: flagging it there is
    // what showed the notice the moment the first message was sent.
    expect(
      isUnrenderedAgentTurnContent(connection({ hasPrompted: false }))
    ).toBe(false)
    expect(
      isUnrenderedAgentTurnContent(
        connection({ hasPrompted: false, agentType: "open_code" })
      )
    ).toBe(false)
  })

  it("leaves agents with a transcript overlay to the overlay", () => {
    expect(
      isUnrenderedAgentTurnContent(connection({ agentType: "claude_code" }))
    ).toBe(false)
  })

  it("flags nothing for a connection the store no longer holds", () => {
    expect(isUnrenderedAgentTurnContent(undefined)).toBe(false)
  })
})
