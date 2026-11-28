import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  subscribe: vi.fn(),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({
    call: mocks.call,
    subscribe: mocks.subscribe,
  }),
}))

import { buildModel } from "./model"
import {
  canonicalizeRemoteMcpUrl,
  extractBridgeRouteIdFromUrl,
  isCodegBridgeDefinition,
  matchOAuthRouteForDefinition,
  MCP_OAUTH_CHANGED_EVENT,
  mcpOAuthBridgeDefinition,
  mcpOAuthCancel,
  mcpOAuthCompleteCallback,
  mcpOAuthList,
  mcpOAuthRevoke,
  mcpOAuthStart,
  onMcpOAuthChanged,
  parseOAuthScopesInput,
  planBridgeRouteApply,
  planRestoreDirectUrl,
  type McpOAuthBridgeSnapshot,
  type McpOAuthRouteInfo,
} from "./oauth"
import { agent, entry, inventory, remote, stdio } from "./test-fixtures"

function makeRoute(
  overrides: Partial<McpOAuthRouteInfo> = {}
): McpOAuthRouteInfo {
  return {
    route_id: "route-notion",
    upstream_url: "https://mcp.notion.com/mcp",
    transport: "http",
    bridge_url: "http://127.0.0.1:43210/mcp/route-notion",
    status: "authorized",
    issuer: "https://auth.notion.com",
    scopes: ["read", "write"],
    expires_at: "2026-12-01T00:00:00Z",
    has_refresh_token: true,
    last_error: null,
    updated_at: "2026-11-27T00:00:00Z",
    ...overrides,
  }
}

describe("mcp/oauth wire commands", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("normalizes mcp_oauth_list snapshot", async () => {
    mocks.call.mockResolvedValue({
      bridge_running: true,
      bridge_base_url: "http://127.0.0.1:43210",
      routes: [makeRoute()],
    })

    const snap = await mcpOAuthList()
    expect(mocks.call).toHaveBeenCalledWith("mcp_oauth_list")
    expect(snap.bridge_running).toBe(true)
    expect(snap.bridge_base_url).toBe("http://127.0.0.1:43210")
    expect(snap.routes).toHaveLength(1)
    expect(snap.routes[0].route_id).toBe("route-notion")
  })

  it("sends only non-empty optional fields in mcp_oauth_start", async () => {
    mocks.call.mockResolvedValue({
      flow_id: "flow-1",
      route_id: "route-1",
      upstream_url: "https://mcp.notion.com/mcp",
      authorization_url: "https://auth.notion.com/authorize?state=abc",
      callback_url: "http://127.0.0.1:43210/oauth/callback",
      expires_at: "2026-11-27T01:00:00Z",
      registration_mode: "dynamic",
    })

    const res = await mcpOAuthStart({
      upstream_url: "  https://mcp.notion.com/mcp  ",
      transport: "http",
      client_id: "   ",
      client_secret: "",
      resource_metadata_url: null,
      scopes: [],
    })

    expect(mocks.call).toHaveBeenCalledWith("mcp_oauth_start", {
      upstream_url: "https://mcp.notion.com/mcp",
      transport: "http",
    })
    expect(res.flow_id).toBe("flow-1")
    expect(res.registration_mode).toBe("dynamic")

    mocks.call.mockResolvedValueOnce({
      flow_id: "flow-2",
      route_id: "route-2",
      upstream_url: "https://api.github.com/mcp",
      authorization_url: "https://github.com/login/oauth/authorize",
      callback_url: "http://127.0.0.1:43210/oauth/callback",
      expires_at: "2026-11-27T01:00:00Z",
      registration_mode: "manual",
    })

    const manualRes = await mcpOAuthStart({
      upstream_url: "https://api.github.com/mcp",
      transport: "sse",
      resource_metadata_url: "https://api.github.com/.well-known/oauth",
      client_id: "gh-client",
      client_secret: "gh-secret",
      scopes: ["repo", "read:user"],
    })
    expect(mocks.call).toHaveBeenLastCalledWith("mcp_oauth_start", {
      upstream_url: "https://api.github.com/mcp",
      transport: "sse",
      resource_metadata_url: "https://api.github.com/.well-known/oauth",
      client_id: "gh-client",
      client_secret: "gh-secret",
      scopes: ["repo", "read:user"],
    })
    expect(manualRes.registration_mode).toBe("manual")
  })

  it("calls complete_callback, cancel, revoke, and bridge_definition", async () => {
    mocks.call.mockResolvedValueOnce(makeRoute({ status: "authorized" }))
    const route = await mcpOAuthCompleteCallback({
      flow_id: "flow-1",
      callback_url: "http://127.0.0.1:43210/oauth/callback?code=123&state=xyz",
    })
    expect(mocks.call).toHaveBeenCalledWith("mcp_oauth_complete_callback", {
      flow_id: "flow-1",
      callback_url: "http://127.0.0.1:43210/oauth/callback?code=123&state=xyz",
    })
    expect(route.status).toBe("authorized")

    mocks.call.mockResolvedValueOnce({ cancelled: true })
    const cancelled = await mcpOAuthCancel("flow-1")
    expect(mocks.call).toHaveBeenCalledWith("mcp_oauth_cancel", {
      flow_id: "flow-1",
    })
    expect(cancelled).toEqual({ cancelled: true })

    mocks.call.mockResolvedValueOnce({
      bridge_running: true,
      bridge_base_url: "http://127.0.0.1:43210",
      routes: [makeRoute({ status: "revoked" })],
    })
    const revokedSnap = await mcpOAuthRevoke("route-notion")
    expect(mocks.call).toHaveBeenCalledWith("mcp_oauth_revoke", {
      route_id: "route-notion",
    })
    expect(revokedSnap.routes[0].status).toBe("revoked")

    // Accepts both `type` and `transport` wire encodings for bridge definition
    mocks.call.mockResolvedValueOnce({
      transport: "http",
      url: "http://127.0.0.1:43210/mcp/route-notion",
      headers: { Authorization: "Bearer bridge-tok-xyz" },
    })
    const bridgeDef = await mcpOAuthBridgeDefinition("route-notion")
    expect(mocks.call).toHaveBeenCalledWith("mcp_oauth_bridge_definition", {
      route_id: "route-notion",
    })
    expect(bridgeDef).toEqual({
      type: "http",
      url: "http://127.0.0.1:43210/mcp/route-notion",
      headers: { Authorization: "Bearer bridge-tok-xyz" },
    })
  })

  it("subscribes to mcp://oauth-changed", async () => {
    const unsub = vi.fn()
    mocks.subscribe.mockImplementation(
      async (_event: string, cb: (payload: unknown) => void) => {
        cb({
          route_id: "route-notion",
          upstream_url: "https://mcp.notion.com/mcp",
          status: "authorized",
        })
        return unsub
      }
    )

    const handler = vi.fn()
    const stop = await onMcpOAuthChanged(handler)
    expect(mocks.subscribe).toHaveBeenCalledWith(
      MCP_OAUTH_CHANGED_EVENT,
      expect.any(Function)
    )
    expect(handler).toHaveBeenCalledWith({
      route_id: "route-notion",
      upstream_url: "https://mcp.notion.com/mcp",
      status: "authorized",
    })
    stop()
    expect(unsub).toHaveBeenCalled()
  })
})

describe("mcp/oauth pure helpers", () => {
  it("canonicalizes remote MCP URLs consistently", () => {
    expect(
      canonicalizeRemoteMcpUrl("HTTPS://MCP.NOTION.COM:443/mcp/#top")
    ).toBe("https://mcp.notion.com/mcp")
    expect(canonicalizeRemoteMcpUrl("http://Example.com:80/api/")).toBe(
      "http://example.com/api"
    )
    expect(canonicalizeRemoteMcpUrl("https://example.com:8443/mcp?a=1#h")).toBe(
      "https://example.com:8443/mcp?a=1"
    )
    expect(canonicalizeRemoteMcpUrl("https://EXAMPLE.COM")).toBe(
      "https://example.com/"
    )
  })

  it("detects loopback bridge route IDs and bridge definitions", () => {
    expect(
      extractBridgeRouteIdFromUrl("http://127.0.0.1:43210/mcp/route-notion")
    ).toBe("route-notion")
    expect(
      extractBridgeRouteIdFromUrl("http://localhost:43210/mcp/route-1/")
    ).toBe("route-1")
    expect(extractBridgeRouteIdFromUrl("http://[::1]:43210/mcp/route-2")).toBe(
      "route-2"
    )
    expect(
      extractBridgeRouteIdFromUrl("https://mcp.notion.com/mcp/route-notion")
    ).toBeNull()
    expect(
      isCodegBridgeDefinition(
        remote("http", "http://127.0.0.1:43210/mcp/route-notion")
      )
    ).toBe(true)
    expect(
      isCodegBridgeDefinition(remote("http", "https://mcp.notion.com/mcp"))
    ).toBe(false)
    expect(isCodegBridgeDefinition(stdio("npx", ["-y", "srv"]))).toBe(false)
  })

  it("matches bridged, port-drifted bridged, and direct OAuth routes", () => {
    const route = makeRoute()
    const snap: McpOAuthBridgeSnapshot = {
      bridge_running: true,
      bridge_base_url: "http://127.0.0.1:43210",
      routes: [route],
    }

    // Exact bridged match
    expect(
      matchOAuthRouteForDefinition(
        remote("http", "http://127.0.0.1:43210/mcp/route-notion"),
        snap
      )
    ).toEqual({ kind: "bridged", route, portDrifted: false })

    // Port drifted loopback match
    expect(
      matchOAuthRouteForDefinition(
        remote("http", "http://127.0.0.1:59999/mcp/route-notion"),
        snap
      )
    ).toEqual({ kind: "bridged", route, portDrifted: true })

    // Direct match with canonicalization
    expect(
      matchOAuthRouteForDefinition(
        remote("http", "HTTPS://mcp.notion.com:443/mcp/#frag"),
        snap
      )
    ).toEqual({ kind: "direct", route })

    // Non-matching remote & stdio
    expect(
      matchOAuthRouteForDefinition(
        remote("http", "https://other.example/mcp"),
        snap
      )
    ).toBeNull()
    expect(matchOAuthRouteForDefinition(stdio("npx"), snap)).toBeNull()
  })

  it("plans bridge apply and direct URL restore across built-in and custom ACP agents", () => {
    const model = buildModel(
      inventory([
        agent("claude_code", [
          entry("notion", remote("http", "https://mcp.notion.com/mcp")),
        ]),
        agent("codex", []), // supports stdio + http
        agent("zcode", []), // stdio only -> should be filtered out
        agent("open_claw", []), // read-only -> should be filtered out
        agent("custom:goose", [], {
          custom: true,
          display_name: "Goose",
          transports: ["stdio", "http", "sse"],
        }),
      ])
    )

    const bridgeDef = remote(
      "http",
      "http://127.0.0.1:43210/mcp/route-notion",
      { Authorization: "Bearer secret-bridge-token" }
    )

    const applyPlan = planBridgeRouteApply(
      model,
      "notion",
      ["claude_code", "codex", "zcode", "open_claw", "custom:goose"],
      bridgeDef
    )
    expect(applyPlan).not.toBeNull()
    expect(applyPlan?.ops.map((op) => op.agent)).toEqual([
      "claude_code",
      "codex",
      "custom:goose",
    ])
    expect(applyPlan?.ops[0]).toEqual({
      agent: "claude_code",
      key: "notion",
      action: "set",
      definition: bridgeDef,
    })
    expect(applyPlan?.basis).toEqual({
      claude_code: "basis-claude_code-1",
      codex: "basis-codex-1",
      "custom:goose": "basis-custom:goose-1",
    })

    const restorePlan = planRestoreDirectUrl(
      model,
      "notion",
      ["claude_code", "custom:goose", "zcode"],
      "https://mcp.notion.com/mcp",
      "http"
    )
    expect(restorePlan).not.toBeNull()
    expect(restorePlan?.ops).toEqual([
      {
        agent: "claude_code",
        key: "notion",
        action: "set",
        definition: { type: "http", url: "https://mcp.notion.com/mcp" },
      },
      {
        agent: "custom:goose",
        key: "notion",
        action: "set",
        definition: { type: "http", url: "https://mcp.notion.com/mcp" },
      },
    ])
  })

  it("parses space and comma separated scopes", () => {
    expect(parseOAuthScopesInput("read, write  admin,read")).toEqual([
      "read",
      "write",
      "admin",
    ])
    expect(parseOAuthScopesInput("   ")).toEqual([])
  })
})
