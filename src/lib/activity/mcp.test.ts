import { describe, expect, it } from "vitest"

import {
  mcpArgumentPreview,
  mcpResultLabel,
  mcpResultPayload,
  parseMcpToolName,
} from "./mcp"

describe("parseMcpToolName", () => {
  it("reads every host's spelling", () => {
    expect(parseMcpToolName("mcp__linear__get_issue")).toEqual({
      server: "linear",
      tool: "get_issue",
    })
    expect(parseMcpToolName("mcp__chrome-devtools__take_snapshot")).toEqual({
      server: "chrome-devtools",
      tool: "take_snapshot",
    })
    expect(parseMcpToolName("linear/get_issue")).toEqual({
      server: "linear",
      tool: "get_issue",
    })
    expect(parseMcpToolName("github.search_code")).toEqual({
      server: "github",
      tool: "search_code",
    })
    expect(parseMcpToolName("context7:query-docs")).toEqual({
      server: "context7",
      tool: "query-docs",
    })
  })

  it("rejects names that only look namespaced", () => {
    expect(parseMcpToolName("functions.exec_command")).toBeNull()
    expect(parseMcpToolName("Read")).toBeNull()
    expect(parseMcpToolName("Read file 'a.ts'")).toBeNull()
  })
})

describe("mcpArgumentPreview", () => {
  it("names the call by its first value", () => {
    expect(mcpArgumentPreview('{"id":"HVAC-212"}')).toBe("HVAC-212")
    expect(mcpArgumentPreview('{"limit":5}')).toBe("5")
    expect(mcpArgumentPreview('{"filter":{"a":1}}')).toBeNull()
    expect(mcpArgumentPreview(null)).toBeNull()
  })
})

describe("mcpResultPayload", () => {
  it("reads a plain JSON result", () => {
    expect(mcpResultPayload('{"title":"Bug"}')).toEqual({
      json: { title: "Bug" },
      text: null,
      isError: false,
    })
  })

  it("parses a CallToolResult's JSON text block", () => {
    const output = JSON.stringify({
      content: [{ type: "text", text: '{"title":"Inactive bindings"}' }],
    })
    expect(mcpResultLabel(mcpResultPayload(output))).toBe("Inactive bindings")
  })

  it("prefers structuredContent", () => {
    const output = JSON.stringify({
      content: [{ type: "text", text: "ignored" }],
      structuredContent: { name: "repo" },
    })
    expect(mcpResultPayload(output)?.json).toEqual({ name: "repo" })
  })

  it("peels codex's envelopes and surfaces its host error", () => {
    const ok = JSON.stringify({
      result: { content: [{ type: "text", text: "plain words" }] },
      error: null,
    })
    expect(mcpResultPayload(ok)).toEqual({
      json: null,
      text: "plain words",
      isError: false,
    })
    const failed = JSON.stringify({ result: null, error: "server crashed" })
    expect(mcpResultPayload(failed)).toEqual({
      json: null,
      text: "server crashed",
      isError: true,
    })
  })

  it("keeps non-JSON output as text", () => {
    expect(mcpResultPayload("all good")).toEqual({
      json: null,
      text: "all good",
      isError: false,
    })
    expect(mcpResultPayload("")).toBeNull()
  })
})

describe("mcpResultLabel", () => {
  it("is null for results without a naming field", () => {
    expect(mcpResultLabel(mcpResultPayload('{"count":3}'))).toBeNull()
    expect(mcpResultLabel(null)).toBeNull()
  })
})
