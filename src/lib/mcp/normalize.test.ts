import { describe, expect, it } from "vitest"

import { McpClientError } from "./errors"
import {
  normalizeApplyResult,
  normalizeChanged,
  normalizeInventory,
  normalizeProbeResult,
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
      paused: false,
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

describe("disable_mode and paused normalization", () => {
  it("infers disable_mode from can_disable when older backends omit it", () => {
    const read = normalizeInventory({
      agents: [
        {
          agent: "claude_code",
          config: { path: "/a" },
          can_disable: true,
          entries: [{ key: "s1", definition: { type: "stdio", command: "x" } }],
        },
        {
          agent: "codex",
          config: { path: "/b" },
          can_disable: false,
          entries: [],
        },
        {
          agent: "gemini",
          config: { path: "/c" },
          can_disable: true,
          disable_mode: "codeg_pause",
          entries: [
            {
              key: "s2",
              definition: { type: "stdio", command: "y" },
              enabled: false,
              paused: true,
            },
          ],
        },
      ],
    })
    expect(read.agents[0].disable_mode).toBe("native")
    expect(read.agents[0].entries[0].paused).toBe(false)
    expect(read.agents[1].disable_mode).toBe("unsupported")
    expect(read.agents[2].disable_mode).toBe("codeg_pause")
    expect(read.agents[2].entries[0].paused).toBe(true)
  })
})

describe("reading a probe result", () => {
  it("normalizes ok, auth_required, session_id_mismatch, and unknown future statuses", () => {
    const ok = normalizeProbeResult({
      status: "ok",
      latency_ms: 42.6,
      server_info: { name: "demo-mcp", version: "1.2.3" },
      protocol_version: "2025-03-26",
      tools: [
        { name: "search", description: "Search docs" },
        { name: "" },
        { name: "ping" },
      ],
      tools_count: 2,
      checked_at: "2026-11-26T00:00:00Z",
    })
    expect(ok).toEqual({
      status: "ok",
      latency_ms: 43,
      server_info: { name: "demo-mcp", version: "1.2.3" },
      protocol_version: "2025-03-26",
      tools: [
        { name: "search", description: "Search docs" },
        { name: "ping", description: null },
      ],
      tools_count: 2,
      http_status: null,
      auth_hint: null,
      detail: null,
      stderr_tail: null,
      checked_at: "2026-11-26T00:00:00Z",
    })

    const auth = normalizeProbeResult({
      status: "auth_required",
      latency_ms: 120,
      http_status: 401,
      auth_hint: {
        scheme: "Bearer",
        resource_metadata:
          "https://example.com/.well-known/oauth-protected-resource",
      },
      detail: "Unauthorized",
      checked_at: "2026-11-26T00:00:01Z",
    })
    expect(auth.status).toBe("auth_required")
    expect(auth.http_status).toBe(401)
    expect(auth.auth_hint).toEqual({
      scheme: "Bearer",
      resource_metadata:
        "https://example.com/.well-known/oauth-protected-resource",
    })
    expect(auth.tools).toEqual([])
    expect(auth.tools_count).toBe(0)

    const future = normalizeProbeResult({
      status: "rate_limited",
      latency_ms: -5,
      stderr_tail: "429 too many requests",
      checked_at: "2026-11-26T00:00:02Z",
    })
    expect(future.status).toBe("rate_limited")
    expect(future.latency_ms).toBe(0)
    expect(future.stderr_tail).toBe("429 too many requests")
  })

  it("rejects non-objects or payloads missing status", () => {
    expect(() => normalizeProbeResult(null)).toThrow(McpClientError)
    expect(() => normalizeProbeResult("ok")).toThrow(McpClientError)
    expect(() => normalizeProbeResult({ latency_ms: 10 })).toThrow(
      McpClientError
    )
  })
})
