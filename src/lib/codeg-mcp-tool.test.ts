import { describe, expect, it } from "vitest"

import { parseCodegMcpToolCall } from "./codeg-mcp-tool"

const progress = (output: string | null, extra = {}) =>
  parseCodegMcpToolCall({
    tool: "task_progress",
    input: JSON.stringify({ message: "tests passing" }),
    output,
    state: "output-available",
    ...extra,
  })

/** The MCP CallToolResult `render_task_ack` (companion.rs) builds. */
const callToolResult = (text: string, structured: Record<string, unknown>) => ({
  content: [{ type: "text", text }],
  isError: false,
  structuredContent: structured,
})

const RECORDED = { recorded: true, note: null }

describe("parseCodegMcpToolCall: work-task report acks", () => {
  it("reads the bare structured ack Claude Code and Codex persist", () => {
    // What a work task's own transcript holds for every report: the model is
    // shown only `structuredContent`, so the "Recorded." text never survives.
    const model = progress('{"recorded":true}')
    expect(model.ack).toEqual(RECORDED)
    expect(model.resultText).toBeNull()
    expect(model.detail).toBe("tests passing")
  })

  it("keeps a refusal's reason", () => {
    expect(
      progress('{"recorded":false,"note":"the task moved on to a new run"}').ack
    ).toEqual({ recorded: false, note: "the task moved on to a new run" })
    expect(progress('{"recorded":false}').ack).toEqual({
      recorded: false,
      note: null,
    })
  })

  it("prefers the structured half of a full CallToolResult", () => {
    const refused = callToolResult(
      "this session is not executing a work task",
      {
        recorded: false,
        note: "this session is not executing a work task",
      }
    )
    expect(progress(JSON.stringify(refused)).ack).toEqual({
      recorded: false,
      note: "this session is not executing a work task",
    })
  })

  it("peels codex-acp's {result, error} envelope and Codex's Wall time wrap", () => {
    const result = callToolResult("Recorded.", { recorded: true })
    expect(progress(JSON.stringify({ result, error: null })).ack).toEqual(
      RECORDED
    )
    expect(
      progress("Wall time: 0.0031 seconds\nOutput:\n" + JSON.stringify(result))
        .ack
    ).toEqual(RECORDED)
    expect(
      progress('Wall time: 0.0031 seconds\nOutput:\n{"recorded":true}').ack
    ).toEqual(RECORDED)
  })

  it("reads JSON-of-JSON and a bare content-block array", () => {
    expect(progress(JSON.stringify('{"recorded":true}')).ack).toEqual(RECORDED)
    expect(
      progress(JSON.stringify([{ type: "text", text: '{"recorded":true}' }]))
        .ack
    ).toEqual(RECORDED)
  })

  it("recognizes the companion's own text when only content survived", () => {
    // OpenCode keeps `content` and drops `structuredContent`.
    expect(progress("Recorded.").ack).toEqual(RECORDED)
    expect(progress("Not recorded.").ack).toEqual({
      recorded: false,
      note: null,
    })
    expect(
      progress(
        JSON.stringify({ content: [{ type: "text", text: "Recorded." }] })
      ).ack
    ).toEqual(RECORDED)
  })

  it("leaves text it cannot positively identify to resultText", () => {
    // OpenCode's half of a refusal is the bare reason — indistinguishable from
    // any other text, so it is shown as-is rather than guessed at.
    const model = progress("the task moved on to a new run")
    expect(model.ack).toBeNull()
    expect(model.resultText).toBe("the task moved on to a new run")
  })

  it("has no ack in flight, on a failed call, or for a host failure envelope", () => {
    expect(progress(null, { state: "input-available" }).ack).toBeNull()

    const failed = progress('{"recorded":true}', {
      errorText: "socket closed",
      state: "output-error",
    })
    expect(failed.ack).toBeNull()
    expect(failed.status).toBe("err")
    expect(failed.resultText).toBe("socket closed")

    const hostFailure = progress(
      JSON.stringify({ result: null, error: "tool call timed out" })
    )
    expect(hostFailure.ack).toBeNull()
    expect(hostFailure.resultText).toBe("tool call timed out")
  })

  it("reads task_complete's ack the same way", () => {
    const model = parseCodegMcpToolCall({
      tool: "task_complete",
      input: JSON.stringify({ verdict: "success", summary: "shipped" }),
      output: '{"recorded":true}',
      state: "output-available",
    })
    expect(model.ack).toEqual(RECORDED)
    expect(model.verdict).toBe("success")
    expect(model.detail).toBe("shipped")
    expect(model.resultText).toBeNull()
  })

  it("never reads an ack off the other workbench tools", () => {
    // Only the two reporting tools return one; anything else that happens to
    // carry a `recorded` key is that tool's own payload.
    const model = parseCodegMcpToolCall({
      tool: "get_session_info",
      input: JSON.stringify({ session_id: 7 }),
      output: '{"recorded":true}',
      state: "output-available",
    })
    expect(model.ack).toBeNull()
    expect(model.resultText).toBe('{"recorded":true}')
  })
})
