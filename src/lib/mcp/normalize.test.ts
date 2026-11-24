import { describe, expect, it } from "vitest"

import { McpClientError } from "./errors"
import {
  normalizeApplyResult,
  normalizeChanged,
  normalizeInventory,
  normalizeSnippet,
} from "./normalize"

describe("reading an inventory", () => {
  it("keeps the backend's shape, filling in what a field left out means", () => {
    const read = normalizeInventory({
      agents: [
        {
          agent: "cline",
          installed: null,
          config: {
            path: "/x/cline_mcp_settings.json",
            format: "json",
            status: "ok",
            basis: "9f2c",
            symlink: false,
            comments_lost_on_write: false,
            related: [],
          },
          writable: true,
          transports: ["stdio", "http", "sse"],
          delivery: "agent_file",
          can_disable: true,
          codeg_mcp: false,
          session_capabilities: null,
          entries: [
            {
              key: "x",
              definition: { type: "stdio", command: "x" },
              extra: { autoApprove: ["a"] },
              enabled: false,
              fingerprint: "5b1e",
              read_only: false,
              reserved: false,
              legacy: false,
              problems: [],
            },
          ],
        },
      ],
      reserved_keys: ["codeg-mcp"],
      key_pattern: "^[A-Za-z0-9_-]{1,64}$",
    })
    expect(read.agents[0].entries[0]).toEqual({
      key: "x",
      definition: { type: "stdio", command: "x" },
      extra: { autoApprove: ["a"] },
      enabled: false,
      fingerprint: "5b1e",
      read_only: false,
      reserved: false,
      legacy: false,
      problems: [],
    })
    expect(read.agents[0].installed).toBeNull()
  })

  it("keeps an agent and a status this build does not know, as they are", () => {
    const read = normalizeInventory({
      agents: [
        {
          agent: "future_agent",
          config: { path: "/f", status: "quarantined" },
          entries: [],
        },
      ],
    })
    expect(read.agents[0].agent).toBe("future_agent")
    expect(read.agents[0].config.status).toBe("quarantined")
    expect(read.agents[0].writable).toBe(false)
  })

  it("reads a definition of a transport it does not know as one it cannot describe", () => {
    const read = normalizeInventory({
      agents: [
        {
          agent: "claude_code",
          config: { path: "/c" },
          entries: [
            {
              key: "w",
              definition: { type: "websocket", url: "wss://a" },
              fingerprint: "ff",
              problems: [],
            },
          ],
        },
      ],
    })
    expect(read.agents[0].entries[0]).toMatchObject({
      definition: null,
      fingerprint: null,
      problems: [
        { code: "unsupported_type", field: "type", detail: "websocket" },
      ],
    })
  })

  it("refuses an answer that is not an inventory", () => {
    expect(() => normalizeInventory("nope")).toThrow(McpClientError)
    expect(() => normalizeInventory({ agents: "x" })).toThrow(McpClientError)
  })
})

describe("reading a result", () => {
  it("keeps every field of every agent", () => {
    const read = normalizeApplyResult({
      outcome: "applied",
      ok: true,
      agents: [
        {
          agent: "cline",
          path: "/p",
          status: "written",
          basis: "c41a",
          issues: [],
          warnings: [{ code: "entry_not_found", op_index: 1, key: "absent" }],
          ops: [{ index: 0, key: "x", effect: "enabled" }],
          writes: [{ path: "/p", role: "servers", creates: false }],
          backup_paths: ["/b"],
        },
      ],
    })
    expect(read.agents[0].warnings).toEqual([
      { code: "entry_not_found", op_index: 1, key: "absent" },
    ])
    expect(read.agents[0].backup_paths).toEqual(["/b"])
  })

  it("refuses one with no outcome", () => {
    expect(() => normalizeApplyResult({ ok: true })).toThrow(McpClientError)
  })
})

describe("reading a snippet and an event", () => {
  it("keeps a server with no name", () => {
    expect(
      normalizeSnippet({
        format: "json_server",
        servers: [
          { key: null, definition: { type: "http", url: "https://a" } },
        ],
        problems: [],
      }).servers[0]
    ).toEqual({
      key: null,
      definition: { type: "http", url: "https://a" },
      extra: {},
      problems: [],
    })
  })

  it("names only agents", () => {
    expect(normalizeChanged({ agents: ["codex", 4] })).toEqual({
      agents: ["codex"],
    })
    expect(normalizeChanged(null)).toEqual({ agents: [] })
  })
})
