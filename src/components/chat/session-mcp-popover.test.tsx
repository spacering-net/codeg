import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { resetSessionMcpStoreForTests } from "@/hooks/use-session-mcp"
import { agent, entry, inventory, remote, stdio } from "@/lib/mcp/test-fixtures"
import type { ConnectionState } from "@/contexts/acp-connections-context"
import { SessionMcpPopover } from "./session-mcp-popover"

const mocks = vi.hoisted(() => ({
  mcpInventory: vi.fn(),
  mcpProbe: vi.fn(),
  mcpApply: vi.fn(),
  onMcpChanged: vi.fn(async () => () => {}),
  openHarness: vi.fn(() => ({ ok: true, section: "mcp", targeted: true })),
  reapplyConfig: vi.fn(async () => true),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  conn: undefined as Partial<ConnectionState> | undefined,
}))

vi.mock("@/lib/mcp/api", () => ({
  mcpInventory: () => mocks.mcpInventory(),
  mcpProbe: (args: unknown) => mocks.mcpProbe(args),
  mcpApply: (args: unknown) => mocks.mcpApply(args),
  onMcpChanged: (cb: unknown) => mocks.onMcpChanged(cb),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({}),
}))

vi.mock("@/hooks/use-open-harness", () => ({
  useOpenHarness: () => ({
    available: true,
    openHarness: mocks.openHarness,
  }),
}))

vi.mock("@/components/agent-icon", () => ({
  AgentIcon: () => <span data-testid="agent-icon" />,
}))

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    error: (...args: unknown[]) => mocks.toastError(...args),
  },
}))

vi.mock("@/contexts/acp-connections-context", () => ({
  useOptionalConnectionStore: () => ({
    subscribeKey: () => () => {},
    getConnection: () => mocks.conn,
    getConnectError: () => undefined,
  }),
  useOptionalAcpActions: () => ({
    reapplyConfig: (key: string) => mocks.reapplyConfig(key),
  }),
}))

function renderPopover(
  props: Partial<React.ComponentProps<typeof SessionMcpPopover>> = {}
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SessionMcpPopover tabId="tab-1" agentType="claude_code" {...props} />
    </NextIntlClientProvider>
  )
}

describe("SessionMcpPopover", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSessionMcpStoreForTests()
    mocks.conn = undefined
  })

  afterEach(() => {
    resetSessionMcpStoreForTests()
  })

  it("stays hidden when the agent has no MCP servers and no error state", () => {
    mocks.conn = {
      agentType: "claude_code",
      status: "connected",
      configStale: false,
      configStaleKind: null,
      sessionFailures: [],
      mcpState: {
        delivery: "codeg_session",
        supports_mcp: true,
        codeg_mcp_attached: false,
        servers: [],
      },
    }

    const { container } = renderPopover()
    expect(container.firstChild).toBeNull()
    expect(mocks.mcpInventory).not.toHaveBeenCalled()
  })

  it("shows monochrome trigger without fetching while closed, and loads/probes on open", async () => {
    const gh = entry("github", stdio("npx", ["-y", "github"]))
    mocks.mcpInventory.mockResolvedValue(
      inventory([agent("claude_code", [gh], { delivery: "codeg_session" })])
    )
    mocks.mcpProbe.mockResolvedValue({
      status: "ok",
      latency_ms: 35,
      tools: [{ name: "list_prs" }],
      tools_count: 1,
      checked_at: "2026-11-26T00:00:00Z",
    })

    mocks.conn = {
      agentType: "claude_code",
      status: "connected",
      isViewer: false,
      isDelegationChild: false,
      configStale: false,
      configStaleKind: null,
      sessionFailures: [],
      mcpState: {
        delivery: "codeg_session",
        supports_mcp: true,
        codeg_mcp_attached: true,
        servers: [
          {
            key: "github",
            transport: "stdio",
            origin: "codeg_session",
            fingerprint: gh.fingerprint,
            status: "attached",
          },
        ],
      },
    }

    renderPopover()
    const trigger = screen.getByTestId("session-mcp-trigger")
    expect(trigger).toBeInTheDocument()
    // Healthy / configured -> no attention dot, no network fetch while closed
    expect(screen.queryByTestId("session-mcp-attention-dot")).toBeNull()
    expect(mocks.mcpInventory).not.toHaveBeenCalled()

    // Open popover -> fetches inventory and allows probing + Manage MCP
    fireEvent.click(trigger)
    await waitFor(() => {
      expect(mocks.mcpInventory).toHaveBeenCalledTimes(1)
      expect(screen.getByText("github")).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole("button", { name: "Test github" }))
    await waitFor(() => {
      expect(mocks.mcpProbe).toHaveBeenCalledWith({
        agent: "claude_code",
        key: "github",
      })
      expect(screen.getByText(/Healthy \(1 tools\)/i)).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole("button", { name: /Manage MCP/i }))
    expect(mocks.openHarness).toHaveBeenCalledWith({
      section: "mcp",
      agentId: "claude_code",
    })
  })

  it("shows a gentle attention dot and Reconnect action when mcp_config is stale", async () => {
    mocks.mcpInventory.mockResolvedValue(inventory([agent("claude_code", [])]))
    mocks.conn = {
      agentType: "claude_code",
      status: "connected",
      isViewer: false,
      isDelegationChild: false,
      configStale: true,
      configStaleKind: "mcp_config",
      sessionFailures: [],
      mcpState: null,
    }

    renderPopover()
    expect(screen.getByTestId("session-mcp-attention-dot")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("session-mcp-trigger"))
    const reconnectBtn = await screen.findByRole("button", {
      name: /Reconnect to apply/i,
    })
    fireEvent.click(reconnectBtn)
    await waitFor(() => {
      expect(mocks.reapplyConfig).toHaveBeenCalledWith("tab-1")
    })
  })

  it("shows OAuth bridge label and Authorize CTA for expired bridged server", async () => {
    const notion = entry(
      "notion",
      remote("http", "http://127.0.0.1:43210/mcp/route-notion", {
        Authorization: "Bearer bridge-tok",
      })
    )
    const linear = entry(
      "linear",
      remote("http", "http://127.0.0.1:43210/mcp/route-linear", {
        Authorization: "Bearer bridge-tok-2",
      })
    )
    mocks.mcpInventory.mockResolvedValue(
      inventory([agent("claude_code", [notion, linear])])
    )
    mocks.conn = {
      agentType: "claude_code",
      status: "connected",
      isViewer: false,
      isDelegationChild: false,
      configStale: false,
      configStaleKind: null,
      sessionFailures: [],
      mcpState: {
        delivery: "codeg_session",
        supports_mcp: true,
        codeg_mcp_attached: true,
        servers: [
          {
            key: "notion",
            transport: "http",
            origin: "codeg_session",
            fingerprint: notion.fingerprint,
            status: "attached",
          },
          {
            key: "linear",
            transport: "http",
            origin: "codeg_session",
            fingerprint: linear.fingerprint,
            status: "attached",
          },
        ],
      },
    }

    const { setMcpOAuthSnapshot } = await import("@/hooks/use-mcp-oauth")
    setMcpOAuthSnapshot({
      bridge_running: true,
      bridge_base_url: "http://127.0.0.1:43210",
      routes: [
        {
          route_id: "route-notion",
          upstream_url: "https://mcp.notion.com/mcp",
          transport: "http",
          bridge_url: "http://127.0.0.1:43210/mcp/route-notion",
          status: "expired",
          scopes: [],
          has_refresh_token: false,
          updated_at: "2026-11-27T00:00:00Z",
        },
        {
          route_id: "route-linear",
          upstream_url: "https://mcp.linear.app/mcp",
          transport: "http",
          bridge_url: "http://127.0.0.1:43210/mcp/route-linear",
          status: "authorized",
          scopes: [],
          has_refresh_token: true,
          updated_at: "2026-11-27T00:00:00Z",
        },
      ],
    })

    renderPopover()
    fireEvent.click(screen.getByTestId("session-mcp-trigger"))

    await waitFor(() => {
      expect(screen.getByText("OAuth bridge")).toBeInTheDocument()
      expect(
        screen.getByRole("button", { name: /^Authorize$/i })
      ).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole("button", { name: /^Authorize$/i }))
    expect(mocks.openHarness).toHaveBeenCalledWith({
      section: "mcp",
      serverKey: "notion",
      openOAuth: true,
    })
  })
})
