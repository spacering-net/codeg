import { describe, expect, it } from "vitest"

import type { SessionFailureRecord, SessionMcpState } from "@/lib/types"
import {
  deriveSessionMcpState,
  extractObservedMcpTools,
  sessionProbeEntryKey,
  type SessionMcpProbeMap,
} from "./session-state"
import { agent, entry, remote, stdio } from "./test-fixtures"

function makeFailure(
  id: string,
  title: string,
  over: Partial<SessionFailureRecord> = {}
): SessionFailureRecord {
  return {
    id,
    revision: 1,
    category: "tool",
    severity: "error",
    title,
    details: null,
    resolved: false,
    dismissed: false,
    actions: [],
    created_at: "2026-11-26T00:00:00Z",
    updated_at: "2026-11-26T00:00:00Z",
    ...over,
  }
}

describe("deriveSessionMcpState", () => {
  it("classifies session_confirmed, probe_healthy, auth_required, connection_failed, skipped_transport, configured, and paused", () => {
    const githubEntry = entry("github", stdio("npx", ["-y", "@mcp/github"]))
    const linearEntry = entry(
      "linear",
      remote("http", "https://linear.app/mcp")
    )
    const notionEntry = entry("notion", remote("http", "https://notion.so/mcp"))
    const brokenEntry = entry("broken", stdio("bad-bin"))
    const sseEntry = entry(
      "events",
      remote("sse", "https://events.example/sse")
    )
    const plainEntry = entry("filesystem", stdio("npx", ["-y", "fs"]))
    const pausedEntry = entry("slack", stdio("npx", ["-y", "slack"]), {
      enabled: false,
      paused: true,
    })

    const inv = agent(
      "claude_code",
      [
        githubEntry,
        linearEntry,
        notionEntry,
        brokenEntry,
        sseEntry,
        plainEntry,
        pausedEntry,
      ],
      {
        can_disable: true,
        disable_mode: "codeg_pause",
        delivery: "codeg_session",
      }
    )

    const sessionState: SessionMcpState = {
      delivery: "codeg_session",
      supports_mcp: true,
      codeg_mcp_attached: true,
      capabilities: { http: true, sse: false },
      config_basis: inv.config.basis,
      servers: [
        {
          key: "github",
          transport: "stdio",
          origin: "codeg_session",
          fingerprint: githubEntry.fingerprint,
          status: "confirmed",
          confirmed_tools: ["search_issues", "get_pr"],
        },
        {
          key: "linear",
          transport: "http",
          origin: "codeg_session",
          fingerprint: linearEntry.fingerprint,
          status: "attached",
        },
        {
          key: "notion",
          transport: "http",
          origin: "codeg_session",
          fingerprint: notionEntry.fingerprint,
          status: "attached",
        },
        {
          key: "broken",
          transport: "stdio",
          origin: "codeg_session",
          fingerprint: brokenEntry.fingerprint,
          status: "failed",
          detail: "spawn ENOENT",
        },
        {
          key: "events",
          transport: "sse",
          origin: "codeg_session",
          fingerprint: sseEntry.fingerprint,
          status: "skipped_transport",
        },
        {
          key: "filesystem",
          transport: "stdio",
          origin: "codeg_session",
          fingerprint: plainEntry.fingerprint,
          status: "attached",
        },
      ],
    }

    const probeMap: SessionMcpProbeMap = {
      [sessionProbeEntryKey("claude_code", "linear")]: {
        phase: "ready",
        fingerprint: linearEntry.fingerprint,
        failure: null,
        result: {
          status: "ok",
          latency_ms: 85,
          tools: [{ name: "list_issues" }],
          tools_count: 1,
          checked_at: "2026-11-26T00:00:00Z",
        },
      },
      [sessionProbeEntryKey("claude_code", "notion")]: {
        phase: "ready",
        fingerprint: notionEntry.fingerprint,
        failure: null,
        result: {
          status: "auth_required",
          latency_ms: 110,
          http_status: 401,
          auth_hint: { scheme: "Bearer" },
          detail: "OAuth required",
          tools: [],
          tools_count: 0,
          checked_at: "2026-11-26T00:00:00Z",
        },
      },
    }

    const result = deriveSessionMcpState({
      agentType: "claude_code",
      connectionStatus: "connected",
      sessionMcpState: sessionState,
      inventoryAgent: inv,
      probeMap,
    })

    const byKey = new Map(result.rows.map((r) => [r.key, r]))
    expect(byKey.get("github")?.status).toBe("session_confirmed")
    expect(byKey.get("github")?.toolsCount).toBe(2)
    expect(byKey.get("linear")?.status).toBe("probe_healthy")
    expect(byKey.get("linear")?.toolsCount).toBe(1)
    expect(byKey.get("notion")?.status).toBe("auth_required")
    expect(byKey.get("broken")?.status).toBe("connection_failed")
    expect(byKey.get("broken")?.canPause).toBe(true)
    expect(byKey.get("broken")?.detail).toBe("spawn ENOENT")
    expect(byKey.get("events")?.status).toBe("skipped_transport")
    expect(byKey.get("filesystem")?.status).toBe("configured")
    expect(byKey.get("slack")?.status).toBe("paused")
    expect(byKey.get("slack")?.paused).toBe(true)

    expect(result.needsReconnect).toBe(false)
    expect(result.summary).toEqual({
      totalCount: 7,
      activeCount: 6,
      confirmedCount: 1,
      healthyCount: 1,
      attentionCount: 3,
      pendingReconnectCount: 0,
      pausedCount: 1,
    })
  })

  it("detects saved_pending_reconnect for added, modified, paused, and removed servers after session start", () => {
    const originalGithub = entry("github", stdio("npx", ["-y", "github@1"]))
    const updatedGithub = entry("github", stdio("npx", ["-y", "github@2"]))
    const addedLinear = entry(
      "linear",
      remote("http", "https://linear.app/mcp")
    )
    const pausedSentry = entry("sentry", stdio("npx", ["-y", "sentry"]), {
      enabled: false,
      paused: true,
    })
    const removedOld = entry("legacy", stdio("npx", ["-y", "legacy"]))

    const inv = agent("codex", [updatedGithub, addedLinear, pausedSentry], {
      config: { basis: "basis-codex-2" },
    })

    const sessionState: SessionMcpState = {
      delivery: "codeg_session",
      supports_mcp: true,
      codeg_mcp_attached: true,
      config_basis: "basis-codex-1",
      servers: [
        {
          key: "github",
          transport: "stdio",
          origin: "codeg_session",
          fingerprint: originalGithub.fingerprint,
          status: "confirmed",
          confirmed_tools: ["search"],
        },
        {
          key: "sentry",
          transport: "stdio",
          origin: "codeg_session",
          fingerprint: pausedSentry.fingerprint,
          status: "attached",
        },
        {
          key: "legacy",
          transport: "stdio",
          origin: "codeg_session",
          fingerprint: removedOld.fingerprint,
          status: "attached",
        },
      ],
    }

    const result = deriveSessionMcpState({
      agentType: "codex",
      connectionStatus: "connected",
      sessionMcpState: sessionState,
      inventoryAgent: inv,
    })

    const byKey = new Map(result.rows.map((r) => [r.key, r]))
    expect(byKey.get("github")?.status).toBe("saved_pending_reconnect")
    expect(byKey.get("github")?.needsReconnect).toBe(true)
    expect(byKey.get("linear")?.status).toBe("saved_pending_reconnect")
    expect(byKey.get("linear")?.needsReconnect).toBe(true)
    expect(byKey.get("sentry")?.status).toBe("saved_pending_reconnect")
    expect(byKey.get("sentry")?.paused).toBe(true)
    expect(byKey.get("legacy")?.status).toBe("saved_pending_reconnect")
    expect(byKey.get("legacy")?.removedPendingReconnect).toBe(true)
    expect(result.needsReconnect).toBe(true)
    expect(result.summary.pendingReconnectCount).toBe(4)
  })

  it("degrades cleanly when older servers omit sessionMcpState", () => {
    const githubEntry = entry("github", stdio("npx", ["-y", "github"]))
    const brokenEntry = entry("sentry", stdio("npx", ["-y", "sentry"]))
    const inv = agent("custom:my-acp", [githubEntry, brokenEntry], {
      custom: true,
      display_name: "My ACP",
      delivery: "codeg_session",
      can_disable: true,
      disable_mode: "codeg_pause",
    })

    const result = deriveSessionMcpState({
      agentType: "custom:my-acp",
      connectionStatus: "connected",
      sessionMcpState: null,
      inventoryAgent: inv,
      sessionFailures: [
        makeFailure("f-1", "MCP load failed for sentry: connection refused"),
      ],
      configStale: true,
      configStaleKind: "mcp_config",
    })

    expect(result.mcpAgentId).toBe("custom:my-acp")
    expect(result.supportsMcp).toBe(true)
    expect(result.needsReconnect).toBe(true)
    const byKey = new Map(result.rows.map((r) => [r.key, r]))
    expect(byKey.get("github")?.status).toBe("configured")
    expect(byKey.get("sentry")?.status).toBe("connection_failed")
    expect(byKey.get("sentry")?.detail).toBe("connection refused")
    expect(byKey.get("sentry")?.canPause).toBe(true)
  })

  it("marks supportsMcp=false when custom agent has mcp_disabled_in_agent_settings", () => {
    const inv = agent("custom:no-mcp", [], {
      custom: true,
      display_name: "No MCP Agent",
      writable: false,
      config: {
        status: "read_only",
        reason: { code: "mcp_disabled_in_agent_settings" },
      },
    })

    const result = deriveSessionMcpState({
      agentType: "custom:no-mcp",
      connectionStatus: null,
      sessionMcpState: null,
      inventoryAgent: inv,
    })

    expect(result.supportsMcp).toBe(false)
    expect(result.rows).toEqual([])
  })

  it("extracts observed non-codeg-mcp tool calls from transcript tool names", () => {
    const known = new Set(["github", "linear-app", "codeg-mcp"])
    const observed = extractObservedMcpTools(
      [
        "mcp__codeg-mcp__delegate_to_agent",
        "mcp__codeg_mcp__ask_user_question",
        "mcp__github__search_code",
        "mcp__github__get_issue",
        "mcp__linear_app__create_issue",
        "Read",
      ],
      known
    )
    expect(observed).toEqual({
      github: ["search_code", "get_issue"],
      "linear-app": ["create_issue"],
    })
  })

  it("marks bridged OAuth servers as auth_required when route is expired or revoked, and exposes oauthBridged metadata", () => {
    const notionBridged = entry(
      "notion",
      remote("http", "http://127.0.0.1:43210/mcp/route-notion", {
        Authorization: "Bearer bridge-tok",
      })
    )
    const linearBridged = entry(
      "linear",
      remote("http", "http://127.0.0.1:43210/mcp/route-linear", {
        Authorization: "Bearer bridge-tok-2",
      })
    )
    const inv = agent("claude_code", [notionBridged, linearBridged], {
      delivery: "codeg_session",
    })

    const result = deriveSessionMcpState({
      agentType: "claude_code",
      connectionStatus: "connected",
      inventoryAgent: inv,
      oauthSnapshot: {
        bridge_running: true,
        bridge_base_url: "http://127.0.0.1:43210",
        routes: [
          {
            route_id: "route-notion",
            upstream_url: "https://mcp.notion.com/mcp",
            transport: "http",
            bridge_url: "http://127.0.0.1:43210/mcp/route-notion",
            status: "expired",
            scopes: ["read"],
            has_refresh_token: false,
            last_error: "OAuth token expired",
            updated_at: "2026-11-27T00:00:00Z",
          },
          {
            route_id: "route-linear",
            upstream_url: "https://mcp.linear.app/mcp",
            transport: "http",
            bridge_url: "http://127.0.0.1:43210/mcp/route-linear",
            status: "authorized",
            scopes: ["read"],
            has_refresh_token: true,
            updated_at: "2026-11-27T00:00:00Z",
          },
        ],
      },
    })

    const byKey = new Map(result.rows.map((r) => [r.key, r]))
    expect(byKey.get("notion")?.status).toBe("auth_required")
    expect(byKey.get("notion")?.oauthBridged).toBe(true)
    expect(byKey.get("notion")?.oauthRoute?.status).toBe("expired")
    expect(byKey.get("notion")?.detail).toBe("OAuth token expired")

    expect(byKey.get("linear")?.status).toBe("configured")
    expect(byKey.get("linear")?.oauthBridged).toBe(true)
    expect(byKey.get("linear")?.oauthRoute?.status).toBe("authorized")
    expect(result.summary.attentionCount).toBe(1)
  })
})
