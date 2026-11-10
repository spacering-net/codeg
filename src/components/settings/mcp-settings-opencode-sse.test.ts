import { describe, expect, it } from "vitest"

import { detectSseSpec } from "./mcp-settings"

/**
 * OpenCode 2 has no SSE client, so the MCP page warns when an SSE server is
 * about to be assigned to OpenCode. The check has to see SSE in both shapes
 * the editor accepts: the canonical `type: "sse"`, and OpenCode's own
 * `type: "remote"` with `transport: "sse"`, which the backend reads as SSE.
 */
describe("detectSseSpec", () => {
  it("recognizes SSE in the canonical and the OpenCode shape", () => {
    expect(detectSseSpec('{"type": "sse", "url": "https://h/sse"}')).toBe(true)
    expect(detectSseSpec('{"type": " SSE ", "url": "https://h/sse"}')).toBe(
      true
    )
    expect(
      detectSseSpec(
        '{"type": "remote", "url": "https://h/sse", "transport": "sse"}'
      )
    ).toBe(true)
  })

  it("leaves every other transport and unparsable text alone", () => {
    expect(detectSseSpec('{"type": "http", "url": "https://h/mcp"}')).toBe(
      false
    )
    expect(detectSseSpec('{"type": "remote", "url": "https://h/mcp"}')).toBe(
      false
    )
    expect(detectSseSpec('{"type": "stdio", "command": "npx"}')).toBe(false)
    expect(detectSseSpec('{"transport": "sse"}')).toBe(false)
    expect(detectSseSpec("{ not json")).toBe(false)
    expect(detectSseSpec("")).toBe(false)
  })
})
