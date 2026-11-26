import { describe, expect, it } from "vitest"

import { agentTypeToMcpApp, extractMcpInitFailure } from "./failure-recovery"

describe("extractMcpInitFailure", () => {
  it("parses raw `MCP load failed for <name>: <reason>` lines", () => {
    expect(
      extractMcpInitFailure("MCP load failed for github: connection refused")
    ).toEqual({
      serverName: "github",
      reason: "connection refused",
    })

    expect(
      extractMcpInitFailure(
        "stderr:\nMCP load failed for linear-remote: 401 Unauthorized (OAuth required)"
      )
    ).toEqual({
      serverName: "linear-remote",
      reason: "401 Unauthorized (OAuth required)",
    })
  })

  it("parses formatted `The MCP server '<name>' failed to initialize...` messages", () => {
    expect(
      extractMcpInitFailure(
        "The MCP server 'notion' failed to initialize: session ID mismatch"
      )
    ).toEqual({
      serverName: "notion",
      reason: "session ID mismatch",
    })

    expect(
      extractMcpInitFailure(
        "The MCP server 'slack' failed to initialize (spawn ENOENT)"
      )
    ).toEqual({
      serverName: "slack",
      reason: "spawn ENOENT",
    })
  })

  it("automatically ignores built-in chrome_devtools failures", () => {
    expect(
      extractMcpInitFailure(
        "MCP load failed for chrome_devtools: browser port closed"
      )
    ).toBeNull()
    expect(
      extractMcpInitFailure(
        "The MCP server 'chrome_devtools' failed to initialize: timeout"
      )
    ).toBeNull()
    // Still catches a real user server on a later line
    expect(
      extractMcpInitFailure(
        "MCP load failed for chrome_devtools: closed\nMCP load failed for sentry: 403 Forbidden"
      )
    ).toEqual({
      serverName: "sentry",
      reason: "403 Forbidden",
    })
  })

  it("returns null for unrelated errors or empty text", () => {
    expect(extractMcpInitFailure("")).toBeNull()
    expect(
      extractMcpInitFailure("Network timeout while calling API")
    ).toBeNull()
  })
})

describe("agentTypeToMcpApp", () => {
  it("maps built-in agent types to McpAppType and returns null for custom/unknown", () => {
    expect(agentTypeToMcpApp("claude_code")).toBe("claude_code")
    expect(agentTypeToMcpApp("codex")).toBe("codex")
    expect(agentTypeToMcpApp("gemini")).toBe("gemini")
    expect(agentTypeToMcpApp("open_code")).toBe("open_code")
    expect(agentTypeToMcpApp("custom:my-agent")).toBeNull()
    expect(agentTypeToMcpApp("custom:@plugin-deadbeef")).toBeNull()
    expect(agentTypeToMcpApp("unknown_agent")).toBeNull()
    expect(agentTypeToMcpApp(null)).toBeNull()
    expect(agentTypeToMcpApp(undefined)).toBeNull()
  })
})
