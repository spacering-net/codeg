import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { buildModel } from "@/lib/mcp/model"
import type {
  McpOAuthBridgeSnapshot,
  McpOAuthChanged,
  McpOAuthRouteInfo,
} from "@/lib/mcp/oauth"
import {
  agent,
  appliedOf,
  entry,
  inventory,
  preflightOf,
  remote,
} from "@/lib/mcp/test-fixtures"
import { McpOAuthDialog } from "./mcp-oauth-dialog"

const mocks = vi.hoisted(() => ({
  openInSystemBrowser: vi.fn(async () => {}),
  copyTextToClipboard: vi.fn(async () => true),
  mcpApply: vi.fn(),
  mcpProbe: vi.fn(),
  mcpOAuthStart: vi.fn(),
  mcpOAuthCompleteCallback: vi.fn(),
  mcpOAuthCancel: vi.fn(),
  mcpOAuthList: vi.fn(),
  mcpOAuthBridgeDefinition: vi.fn(),
  oauthListeners: new Set<(payload: McpOAuthChanged) => void>(),
}))

vi.mock("@/lib/link-open", () => ({
  openInSystemBrowser: (url: string) => mocks.openInSystemBrowser(url),
}))

vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>()
  return {
    ...actual,
    copyTextToClipboard: (text: string) => mocks.copyTextToClipboard(text),
  }
})

vi.mock("@/lib/mcp/api", () => ({
  mcpApply: (args: unknown) => mocks.mcpApply(args),
  mcpProbe: (args: unknown) => mocks.mcpProbe(args),
}))

vi.mock("@/lib/mcp/oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/oauth")>()
  return {
    ...actual,
    mcpOAuthStart: (args: unknown) => mocks.mcpOAuthStart(args),
    mcpOAuthCompleteCallback: (args: unknown) =>
      mocks.mcpOAuthCompleteCallback(args),
    mcpOAuthCancel: (flowId: string) => mocks.mcpOAuthCancel(flowId),
    mcpOAuthList: () => mocks.mcpOAuthList(),
    mcpOAuthBridgeDefinition: (routeId: string) =>
      mocks.mcpOAuthBridgeDefinition(routeId),
    onMcpOAuthChanged: async (cb: (payload: McpOAuthChanged) => void) => {
      mocks.oauthListeners.add(cb)
      return () => mocks.oauthListeners.delete(cb)
    },
  }
})

vi.mock("@/components/agent-icon", () => ({
  AgentIcon: () => <span data-testid="agent-icon" />,
}))

const BRIDGE_SECRET_TOKEN = "super-secret-bridge-token-987654"

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

function makeModel() {
  return buildModel(
    inventory([
      agent("claude_code", [
        entry("notion", remote("http", "https://mcp.notion.com/mcp")),
      ]),
      agent("codex", []),
      agent("custom:goose", [], {
        custom: true,
        display_name: "Goose",
        transports: ["stdio", "http", "sse"],
      }),
    ])
  )
}

describe("McpOAuthDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.oauthListeners.clear()
  })

  it("completes manual OAuth callback, routes multiple agents (including custom ACP), probes bridge, and never leaks bridge token", async () => {
    const model = makeModel()
    const onClose = vi.fn()
    const onApplied = vi.fn()
    const onOAuthChanged = vi.fn()

    mocks.mcpOAuthStart.mockResolvedValue({
      flow_id: "flow-1",
      route_id: "route-notion",
      upstream_url: "https://mcp.notion.com/mcp",
      authorization_url: "https://auth.notion.com/authorize?state=s1",
      callback_url: "http://127.0.0.1:43210/oauth/callback",
      expires_at: "2026-11-27T01:00:00Z",
      registration_mode: "manual",
    })
    mocks.mcpOAuthCompleteCallback.mockResolvedValue(makeRoute())
    const bridgeDef = remote(
      "http",
      "http://127.0.0.1:43210/mcp/route-notion",
      { Authorization: `Bearer ${BRIDGE_SECRET_TOKEN}` }
    )
    mocks.mcpOAuthBridgeDefinition.mockResolvedValue(bridgeDef)
    mocks.mcpApply.mockImplementation(
      async (args: { ops: never[]; preflight?: boolean }) =>
        args.preflight ? preflightOf(args.ops) : appliedOf(args.ops)
    )
    mocks.mcpProbe.mockResolvedValue({
      status: "ok",
      latency_ms: 42,
      tools: [{ name: "search_pages", description: "Search Notion" }],
      tools_count: 1,
      checked_at: "2026-11-27T00:00:00Z",
    })

    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <McpOAuthDialog
          serverKey="notion"
          upstreamUrl="https://mcp.notion.com/mcp"
          transport="http"
          resourceMetadataUrl="https://mcp.notion.com/.well-known/oauth-protected-resource"
          availableTargets={model.agents}
          model={model}
          onClose={onClose}
          onApplied={onApplied}
          onOAuthChanged={onOAuthChanged}
        />
      </NextIntlClientProvider>
    )

    // Open advanced options and supply manual client credentials + scopes
    fireEvent.click(screen.getByRole("button", { name: /Advanced options/i }))
    fireEvent.change(screen.getByLabelText("Client ID"), {
      target: { value: "my-client" },
    })
    fireEvent.change(screen.getByLabelText("Client secret"), {
      target: { value: "my-secret" },
    })
    fireEvent.change(screen.getByLabelText("Scopes"), {
      target: { value: "read, write" },
    })

    // Start OAuth flow -> opens system browser
    fireEvent.click(
      screen.getByRole("button", { name: /Authorize in browser/i })
    )
    await waitFor(() => {
      expect(mocks.mcpOAuthStart).toHaveBeenCalledWith({
        upstream_url: "https://mcp.notion.com/mcp",
        transport: "http",
        resource_metadata_url:
          "https://mcp.notion.com/.well-known/oauth-protected-resource",
        client_id: "my-client",
        client_secret: "my-secret",
        scopes: ["read", "write"],
      })
      expect(mocks.openInSystemBrowser).toHaveBeenCalledWith(
        "https://auth.notion.com/authorize?state=s1"
      )
      expect(
        screen.getByText(/Waiting for browser callback/i)
      ).toBeInTheDocument()
    })

    // Paste manual callback URL (Docker / remote server flow)
    fireEvent.click(
      screen.getByRole("button", { name: /Paste callback URL manually/i })
    )
    fireEvent.change(screen.getByPlaceholderText(/callback\?code=/i), {
      target: {
        value: "http://127.0.0.1:43210/oauth/callback?code=abc&state=s1",
      },
    })
    fireEvent.click(
      screen.getByRole("button", { name: /Complete authorization/i })
    )

    await waitFor(() => {
      expect(mocks.mcpOAuthCompleteCallback).toHaveBeenCalledWith({
        flow_id: "flow-1",
        callback_url: "http://127.0.0.1:43210/oauth/callback?code=abc&state=s1",
      })
      expect(screen.getByText(/Authorization complete/i)).toBeInTheDocument()
      expect(screen.getByText("https://auth.notion.com")).toBeInTheDocument()
      expect(screen.getByText(/Automatic refresh enabled/i)).toBeInTheDocument()
    })
    expect(onOAuthChanged).toHaveBeenCalled()

    // Select custom ACP agent "Goose" in addition to pre-selected "Claude Code"
    fireEvent.click(screen.getByLabelText(/Goose/i))

    // Review bridge changes (preflight: true)
    fireEvent.click(
      screen.getByRole("button", { name: /Review bridge changes/i })
    )
    await waitFor(() => {
      expect(mocks.mcpOAuthBridgeDefinition).toHaveBeenCalledWith(
        "route-notion"
      )
      expect(mocks.mcpApply).toHaveBeenCalledWith(
        expect.objectContaining({
          preflight: true,
          ops: expect.arrayContaining([
            expect.objectContaining({
              agent: "claude_code",
              key: "notion",
              action: "set",
              definition: bridgeDef,
            }),
            expect.objectContaining({
              agent: "custom:goose",
              key: "notion",
              action: "set",
              definition: bridgeDef,
            }),
          ]),
        })
      )
    })

    // Security check: bridge bearer token must NEVER appear in the DOM!
    expect(container.textContent).not.toContain(BRIDGE_SECRET_TOKEN)

    // Save (preflight: false)
    const saveBtn = await screen.findByRole("button", { name: /^Save$/i })
    fireEvent.click(saveBtn)
    await waitFor(() => {
      expect(mocks.mcpApply).toHaveBeenCalledWith(
        expect.objectContaining({ preflight: false })
      )
      expect(onApplied).toHaveBeenCalled()
    })
    expect(container.textContent).not.toContain(BRIDGE_SECRET_TOKEN)

    // Probe end-to-end connectivity through bridge
    fireEvent.click(
      screen.getByRole("button", { name: /Test connection now/i })
    )
    await waitFor(() => {
      expect(mocks.mcpProbe).toHaveBeenCalledWith({ definition: bridgeDef })
      expect(screen.getByText(/Healthy · 1 tool/i)).toBeInTheDocument()
    })
    expect(container.textContent).not.toContain(BRIDGE_SECRET_TOKEN)
  })

  it("auto-advances to authorized state on mcp://oauth-changed and supports cancelling active flow", async () => {
    const model = makeModel()
    const onClose = vi.fn()
    mocks.mcpOAuthStart.mockResolvedValue({
      flow_id: "flow-2",
      route_id: "route-notion",
      upstream_url: "https://mcp.notion.com/mcp",
      authorization_url: "https://auth.notion.com/authorize?state=s2",
      callback_url: "http://127.0.0.1:43210/oauth/callback",
      expires_at: "2026-11-27T01:00:00Z",
      registration_mode: "dynamic",
    })
    mocks.mcpOAuthCancel.mockResolvedValue({ cancelled: true })
    mocks.mcpOAuthList.mockResolvedValue({
      bridge_running: true,
      bridge_base_url: "http://127.0.0.1:43210",
      routes: [makeRoute()],
    } satisfies McpOAuthBridgeSnapshot)

    const { unmount } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <McpOAuthDialog
          serverKey="notion"
          upstreamUrl="https://mcp.notion.com/mcp"
          transport="http"
          availableTargets={model.agents}
          model={model}
          onClose={onClose}
        />
      </NextIntlClientProvider>
    )

    fireEvent.click(
      screen.getByRole("button", { name: /Authorize in browser/i })
    )
    await waitFor(() => {
      expect(mocks.oauthListeners.size).toBe(1)
    })

    // Emit mcp://oauth-changed
    await act(async () => {
      for (const listener of mocks.oauthListeners) {
        listener({
          route_id: "route-notion",
          upstream_url: "https://mcp.notion.com/mcp",
          status: "authorized",
        })
      }
    })

    await waitFor(() => {
      expect(screen.getByText(/Authorization complete/i)).toBeInTheDocument()
    })

    unmount()

    // Test cancelling while waiting
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <McpOAuthDialog
          serverKey="notion"
          upstreamUrl="https://mcp.notion.com/mcp"
          transport="http"
          availableTargets={model.agents}
          model={model}
          onClose={onClose}
        />
      </NextIntlClientProvider>
    )
    fireEvent.click(
      screen.getByRole("button", { name: /Authorize in browser/i })
    )
    await waitFor(() => {
      expect(
        screen.getByText(/Waiting for browser callback/i)
      ).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }))
    await waitFor(() => {
      expect(mocks.mcpOAuthCancel).toHaveBeenCalledWith("flow-2")
      expect(onClose).toHaveBeenCalled()
    })
  })

  it("restores direct upstream URL via preflight review without bridge headers", async () => {
    const bridgedModel = buildModel(
      inventory([
        agent("claude_code", [
          entry(
            "notion",
            remote("http", "http://127.0.0.1:43210/mcp/route-notion", {
              Authorization: `Bearer ${BRIDGE_SECRET_TOKEN}`,
            })
          ),
        ]),
      ])
    )
    const snap: McpOAuthBridgeSnapshot = {
      bridge_running: true,
      bridge_base_url: "http://127.0.0.1:43210",
      routes: [makeRoute()],
    }
    mocks.mcpApply.mockImplementation(
      async (args: { ops: never[]; preflight?: boolean }) =>
        args.preflight ? preflightOf(args.ops) : appliedOf(args.ops)
    )

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <McpOAuthDialog
          serverKey="notion"
          upstreamUrl="https://mcp.notion.com/mcp"
          transport="http"
          existingRoute={makeRoute()}
          availableTargets={bridgedModel.agents}
          model={bridgedModel}
          oauthSnapshot={snap}
          initialMode="restore"
          onClose={vi.fn()}
        />
      </NextIntlClientProvider>
    )

    fireEvent.click(
      screen.getByRole("button", { name: /Review restore changes/i })
    )
    await waitFor(() => {
      expect(mocks.mcpApply).toHaveBeenCalledWith(
        expect.objectContaining({
          preflight: true,
          ops: [
            {
              agent: "claude_code",
              key: "notion",
              action: "set",
              definition: {
                type: "http",
                url: "https://mcp.notion.com/mcp",
              },
            },
          ],
        })
      )
    })

    fireEvent.click(await screen.findByRole("button", { name: /^Save$/i }))
    await waitFor(() => {
      expect(mocks.mcpApply).toHaveBeenCalledWith(
        expect.objectContaining({ preflight: false })
      )
    })
  })

  it("advances to authorized even if parent re-renders with a new inline onOAuthChanged while mcpOAuthList is pending", async () => {
    const model = makeModel()
    mocks.mcpOAuthStart.mockResolvedValue({
      flow_id: "flow-race-1",
      route_id: "route-notion",
      upstream_url: "https://mcp.notion.com/mcp",
      authorization_url: "https://auth.notion.com/authorize?state=race1",
      callback_url: "http://127.0.0.1:43210/oauth/callback",
      expires_at: "2026-11-27T01:00:00Z",
      registration_mode: "dynamic",
    })

    let resolveList!: (value: McpOAuthBridgeSnapshot) => void
    mocks.mcpOAuthList.mockImplementation(
      () =>
        new Promise<McpOAuthBridgeSnapshot>((resolve) => {
          resolveList = resolve
        })
    )

    const onOAuthChanged1 = vi.fn()
    const onOAuthChanged2 = vi.fn()
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <McpOAuthDialog
          serverKey="notion"
          upstreamUrl="https://mcp.notion.com/mcp"
          transport="http"
          availableTargets={model.agents}
          model={model}
          onClose={vi.fn()}
          onOAuthChanged={onOAuthChanged1}
        />
      </NextIntlClientProvider>
    )

    fireEvent.click(
      screen.getByRole("button", { name: /Authorize in browser/i })
    )
    await waitFor(() => {
      expect(mocks.oauthListeners.size).toBe(1)
    })

    // Emit mcp://oauth-changed; mcpOAuthList() starts and stays pending
    act(() => {
      for (const listener of mocks.oauthListeners) {
        listener({
          route_id: "route-notion",
          upstream_url: "https://mcp.notion.com/mcp",
          status: "authorized",
        })
      }
    })
    await waitFor(() => {
      expect(mocks.mcpOAuthList).toHaveBeenCalledTimes(1)
    })

    // Simulate parent re-rendering with a brand-new inline onOAuthChanged prop
    // while `await mcpOAuthList()` is still pending
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <McpOAuthDialog
          serverKey="notion"
          upstreamUrl="https://mcp.notion.com/mcp"
          transport="http"
          availableTargets={model.agents}
          model={model}
          onClose={vi.fn()}
          onOAuthChanged={onOAuthChanged2}
        />
      </NextIntlClientProvider>
    )

    // Now resolve mcpOAuthList() -> dialog MUST advance to authorized state
    await act(async () => {
      resolveList({
        bridge_running: true,
        bridge_base_url: "http://127.0.0.1:43210",
        routes: [makeRoute()],
      })
    })

    await waitFor(() => {
      expect(screen.getByText(/Authorization complete/i)).toBeInTheDocument()
      expect(
        screen.getByRole("button", { name: /Review bridge changes/i })
      ).toBeInTheDocument()
      expect(screen.getByLabelText(/Goose/i)).toBeInTheDocument()
    })
    expect(onOAuthChanged2).toHaveBeenCalledTimes(1)
    expect(onOAuthChanged1).not.toHaveBeenCalled()
  })

  it("advances waiting dialog via oauthSnapshot / existingRoute fallback even when event was missed, without false-triggering on stale re-auth", async () => {
    const model = makeModel()
    mocks.mcpOAuthStart.mockResolvedValue({
      flow_id: "flow-fallback-1",
      route_id: "route-notion",
      upstream_url: "https://mcp.notion.com/mcp",
      authorization_url: "https://auth.notion.com/authorize?state=fb1",
      callback_url: "http://127.0.0.1:43210/oauth/callback",
      expires_at: "2026-11-27T01:00:00Z",
      registration_mode: "dynamic",
    })

    const initialRoute = makeRoute({
      status: "authorized",
      updated_at: "2026-11-27T00:00:00Z",
    })
    const initialSnapshot: McpOAuthBridgeSnapshot = {
      bridge_running: true,
      bridge_base_url: "http://127.0.0.1:43210",
      routes: [initialRoute],
    }

    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <McpOAuthDialog
          serverKey="notion"
          upstreamUrl="https://mcp.notion.com/mcp"
          transport="http"
          existingRoute={initialRoute}
          oauthSnapshot={initialSnapshot}
          availableTargets={model.agents}
          model={model}
          onClose={vi.fn()}
        />
      </NextIntlClientProvider>
    )

    // Re-authorizing an already-authorized route must STAY in waiting state
    // while `updated_at` matches the pre-flow baseline
    fireEvent.click(
      screen.getByRole("button", { name: /Authorize in browser/i })
    )
    await waitFor(() => {
      expect(
        screen.getByText(/Waiting for browser callback/i)
      ).toBeInTheDocument()
    })

    // Parent snapshot updates with a newer `updated_at` (no WS event emitted to dialog)
    const freshRoute = makeRoute({
      status: "authorized",
      updated_at: "2026-11-27T00:05:00Z",
      scopes: ["read", "write", "admin"],
    })
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <McpOAuthDialog
          serverKey="notion"
          upstreamUrl="https://mcp.notion.com/mcp"
          transport="http"
          existingRoute={freshRoute}
          oauthSnapshot={{
            bridge_running: true,
            bridge_base_url: "http://127.0.0.1:43210",
            routes: [freshRoute],
          }}
          availableTargets={model.agents}
          model={model}
          onClose={vi.fn()}
        />
      </NextIntlClientProvider>
    )

    await waitFor(() => {
      expect(screen.getByText(/Authorization complete/i)).toBeInTheDocument()
      expect(screen.getByText("admin")).toBeInTheDocument()
      expect(
        screen.getByRole("button", { name: /Review bridge changes/i })
      ).toBeInTheDocument()
    })
  })
})
