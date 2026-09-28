import { describe, expect, it } from "vitest"
import {
  BACKGROUND_TASK_MARKER,
  hasTranscriptOverlay,
  isAsyncLaunchAckText,
  isOutOfTurnContentEvent,
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
    })
  })

  it("parses an unsettled marker (null status — never rendered as running)", () => {
    const output = `${BACKGROUND_TASK_MARKER}{"task_id":"nores99","status":null,"summary":null,"result":null}`
    expect(parseBackgroundTaskMarker(output)).toEqual({
      taskId: "nores99",
      status: null,
      summary: null,
      result: null,
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
})
