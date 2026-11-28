import { describe, expect, it } from "vitest"

import {
  planAgentBulkEnable,
  planServerBulkDisable,
  planServerBulkEnable,
} from "./bulk"
import { buildModel } from "./model"
import type { McpAgentInventory, McpEntry, McpInventory } from "./types"

function entryOf(key: string, overrides: Partial<McpEntry> = {}): McpEntry {
  return {
    key,
    definition: { type: "http", url: "https://mcp.example.com" },
    extra: {},
    enabled: true,
    paused: false,
    fingerprint: "fp-http",
    read_only: false,
    reserved: false,
    legacy: false,
    problems: [],
    ...overrides,
  }
}

function agentOf(
  agent: string,
  overrides: Partial<McpAgentInventory> = {}
): McpAgentInventory {
  return {
    agent,
    installed: true,
    config: {
      path: `/tmp/${agent}.json`,
      format: "json",
      status: "ok",
      basis: `basis-${agent}`,
      symlink: false,
      comments_lost_on_write: false,
      related: [],
    },
    writable: true,
    transports: ["stdio", "http", "sse"],
    delivery: "agent_file",
    can_disable: true,
    disable_mode: "native",
    codeg_mcp: false,
    session_capabilities: null,
    entries: [],
    ...overrides,
  }
}

function inventoryOf(agents: McpAgentInventory[]): McpInventory {
  return {
    agents,
    reserved_keys: ["codeg-mcp"],
    key_pattern: "^[A-Za-z0-9_-]{1,64}$",
  }
}

describe("planServerBulkEnable", () => {
  it("computes ops for compatible installed writable agents and categorizes active/skipped with reasons", () => {
    const model = buildModel(
      inventoryOf([
        // Already enabled with same definition
        agentOf("claude_code", { entries: [entryOf("linear")] }),
        // Disabled/paused with same definition -> set_enabled(true)
        agentOf("codex", {
          disable_mode: "codeg_pause",
          entries: [entryOf("linear", { enabled: false, paused: true })],
        }),
        // Absent, compatible, installed, writable -> set
        agentOf("gemini"),
        // Incompatible transport (stdio only) -> skipped(unsupportedTransport)
        agentOf("cline", { transports: ["stdio"] }),
        // Not installed -> skipped(notInstalled)
        agentOf("cursor", { installed: false }),
        // Read-only agent -> skipped(readOnly)
        agentOf("kiro", {
          writable: false,
          config: {
            path: "/tmp/kiro.json",
            format: "json",
            status: "read_only",
            basis: "b",
            symlink: false,
            comments_lost_on_write: false,
            related: [],
          },
        }),
        // Unreadable agent -> skipped(unreadable)
        agentOf("trae", {
          writable: false,
          config: {
            path: "/tmp/trae.json",
            format: "json",
            status: "unreadable",
            basis: null,
            symlink: false,
            comments_lost_on_write: false,
            related: [],
          },
        }),
        // Unknown future agent -> skipped(unknownAgent)
        agentOf("future_cli"),
      ])
    )

    const server = model.server("linear")!
    const plan = planServerBulkEnable(server, server.groups[0], model)

    expect(plan.alreadyActive).toEqual(["claude_code"])
    expect(plan.ops).toEqual([
      {
        agent: "codex",
        effect: "enable",
        op: {
          agent: "codex",
          key: "linear",
          action: "set_enabled",
          enabled: true,
        },
      },
      {
        agent: "gemini",
        effect: "add",
        op: {
          agent: "gemini",
          key: "linear",
          action: "set",
          definition: { type: "http", url: "https://mcp.example.com" },
        },
      },
    ])
    expect(plan.skipped).toEqual([
      {
        agent: "cline",
        reason: { kind: "unsupportedTransport", transport: "http" },
      },
      { agent: "cursor", reason: { kind: "notInstalled" } },
      { agent: "kiro", reason: { kind: "readOnly" } },
      { agent: "trae", reason: { kind: "unreadable" } },
      { agent: "future_cli", reason: { kind: "unknownAgent" } },
    ])
  })
})

describe("planServerBulkDisable", () => {
  it("only emits set_enabled(false) for enabled pausable/disableable agents and NEVER removes config", () => {
    const model = buildModel(
      inventoryOf([
        agentOf("claude_code", {
          can_disable: true,
          disable_mode: "native",
          entries: [entryOf("linear", { enabled: true })],
        }),
        agentOf("codex", {
          can_disable: true,
          disable_mode: "codeg_pause",
          entries: [entryOf("linear", { enabled: true })],
        }),
        agentOf("gemini", {
          can_disable: false,
          disable_mode: "unsupported",
          entries: [entryOf("linear", { enabled: true })],
        }),
        agentOf("cline", {
          can_disable: true,
          entries: [entryOf("linear", { enabled: false, paused: true })],
        }),
        agentOf("cursor", {
          writable: false,
          can_disable: true,
          entries: [entryOf("linear", { enabled: true })],
        }),
      ])
    )

    const server = model.server("linear")!
    const plan = planServerBulkDisable(server, model)

    expect(plan.ops.every((item) => item.op.action === "set_enabled")).toBe(
      true
    )
    expect(plan.ops).toEqual([
      {
        agent: "claude_code",
        effect: "disable",
        op: {
          agent: "claude_code",
          key: "linear",
          action: "set_enabled",
          enabled: false,
        },
      },
      {
        agent: "codex",
        effect: "disable",
        op: {
          agent: "codex",
          key: "linear",
          action: "set_enabled",
          enabled: false,
        },
      },
    ])
    expect(plan.alreadyActive).toEqual(["cline"])
    expect(plan.skipped).toEqual([
      { agent: "gemini", reason: { kind: "cannotDisable" } },
      { agent: "cursor", reason: { kind: "readOnly" } },
    ])
  })
})

describe("planAgentBulkEnable", () => {
  it("enables or adds every compatible local MCP server for a target agent", () => {
    const stdioDef = { type: "stdio" as const, command: "npx", args: ["fs"] }
    const httpDef = { type: "http" as const, url: "https://mcp.example.com" }

    const model = buildModel(
      inventoryOf([
        agentOf("claude_code", {
          transports: ["stdio", "http"],
          entries: [
            entryOf("already_on", {
              definition: stdioDef,
              fingerprint: "fp-a",
            }),
            entryOf("remote_only", {
              definition: httpDef,
              fingerprint: "fp-h",
            }),
            entryOf("local_stdio", {
              definition: stdioDef,
              fingerprint: "fp-s",
            }),
          ],
        }),
        // Target agent only supports stdio
        agentOf("cline", {
          transports: ["stdio"],
          entries: [
            entryOf("already_on", {
              definition: stdioDef,
              fingerprint: "fp-a",
              enabled: true,
            }),
            entryOf("paused_stdio", {
              definition: stdioDef,
              fingerprint: "fp-p",
              enabled: false,
              paused: true,
            }),
          ],
        }),
      ])
    )

    const clineInfo = model.agent("cline")!
    const plan = planAgentBulkEnable(clineInfo, model)

    expect(plan.alreadyActive).toEqual(["already_on"])
    expect(plan.ops).toEqual([
      {
        serverKey: "local_stdio",
        effect: "add",
        definition: stdioDef,
        op: {
          agent: "cline",
          key: "local_stdio",
          action: "set",
          definition: stdioDef,
        },
      },
      {
        serverKey: "paused_stdio",
        effect: "enable",
        definition: stdioDef,
        op: {
          agent: "cline",
          key: "paused_stdio",
          action: "set_enabled",
          enabled: true,
        },
      },
    ])
    expect(plan.skipped).toEqual([
      {
        serverKey: "remote_only",
        reason: { kind: "unsupportedTransport", transport: "http" },
      },
    ])
  })
})
