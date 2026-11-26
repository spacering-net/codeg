import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { resetSessionMcpStoreForTests } from "@/hooks/use-session-mcp"
import { saveSessionDetailsSectionOpen } from "@/lib/session-details-prefs"
import {
  agent,
  appliedOf,
  entry,
  inventory,
  remote,
  stdio,
} from "@/lib/mcp/test-fixtures"
import type { ConnectionState } from "@/contexts/acp-connections-context"
import { SessionMcpSection } from "./session-mcp-section"

const mocks = vi.hoisted(() => ({
  mcpInventory: vi.fn(),
  mcpProbe: vi.fn(),
  mcpApply: vi.fn(),
  onMcpChanged: vi.fn(async () => () => {}),
  openHarness: vi.fn(() => ({ ok: true, section: "mcp", targeted: true })),
  openSettingsWindow: vi.fn(async () => {}),
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

vi.mock("@/lib/api", () => ({
  openSettingsWindow: (section: string) => mocks.openSettingsWindow(section),
}))

vi.mock("@/hooks/use-open-harness", () => ({
  useOpenHarness: () => ({
    available: true,
    openHarness: mocks.openHarness,
  }),
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

function renderSection(
  props: Partial<React.ComponentProps<typeof SessionMcpSection>> = {}
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SessionMcpSection
        contextKey="tab-1"
        agentType="claude_code"
        active={true}
        {...props}
      />
    </NextIntlClientProvider>
  )
}

describe("SessionMcpSection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetSessionMcpStoreForTests()
    saveSessionDetailsSectionOpen("mcp", true)
    mocks.conn = undefined
  })

  afterEach(() => {
    resetSessionMcpStoreForTests()
  })

  it("does not fetch inventory when inactive or collapsed", () => {
    mocks.mcpInventory.mockResolvedValue(inventory([agent("claude_code", [])]))
    renderSection({ active: false })
    expect(mocks.mcpInventory).not.toHaveBeenCalled()

    saveSessionDetailsSectionOpen("mcp", false)
    renderSection({ active: true })
    expect(mocks.mcpInventory).not.toHaveBeenCalled()
  })

  it("renders unified server states, runs single probe, pauses failed server, and jumps to Harness MCP", async () => {
    const gh = entry("github", stdio("npx", ["-y", "github"]))
    const broken = entry(
      "broken-srv",
      remote("http", "https://bad.example/mcp")
    )
    const inv = inventory([
      agent("claude_code", [gh, broken], {
        can_disable: true,
        disable_mode: "codeg_pause",
        delivery: "codeg_session",
      }),
    ])
    mocks.mcpInventory.mockResolvedValue(inv)
    mocks.mcpProbe.mockResolvedValue({
      status: "ok",
      latency_ms: 48,
      tools: [{ name: "search_code", description: "Search repo" }],
      tools_count: 1,
      checked_at: "2026-11-26T00:00:00Z",
    })
    mocks.mcpApply.mockResolvedValue(
      appliedOf([
        {
          agent: "claude_code",
          key: "broken-srv",
          action: "set_enabled",
          enabled: false,
        },
      ])
    )

    mocks.conn = {
      agentType: "claude_code",
      status: "connected",
      isViewer: false,
      isDelegationChild: false,
      configStale: true,
      configStaleKind: "mcp_config",
      sessionFailures: [],
      mcpState: {
        delivery: "codeg_session",
        supports_mcp: true,
        codeg_mcp_attached: true,
        capabilities: { http: true, sse: false },
        config_basis: inv.agents[0].config.basis,
        servers: [
          {
            key: "github",
            transport: "stdio",
            origin: "codeg_session",
            fingerprint: gh.fingerprint,
            status: "attached",
          },
          {
            key: "broken-srv",
            transport: "http",
            origin: "codeg_session",
            fingerprint: broken.fingerprint,
            status: "failed",
            detail: "connection refused",
          },
        ],
      },
    }

    renderSection()

    await waitFor(() => {
      expect(screen.getByText("github")).toBeInTheDocument()
      expect(screen.getByText("broken-srv")).toBeInTheDocument()
    })

    // Reconnect button shown for mcp_config stale state
    const reconnectBtn = screen.getByRole("button", {
      name: /Reconnect to apply/i,
    })
    fireEvent.click(reconnectBtn)
    await waitFor(() => {
      expect(mocks.reapplyConfig).toHaveBeenCalledWith("tab-1")
    })

    // Probe a single server and inspect discovered tools
    fireEvent.click(screen.getByRole("button", { name: "Test github" }))
    await waitFor(() => {
      expect(mocks.mcpProbe).toHaveBeenCalledWith({
        agent: "claude_code",
        key: "github",
      })
      expect(screen.getByText("search_code")).toBeInTheDocument()
      expect(screen.getByText(/Healthy \(1 tools\)/i)).toBeInTheDocument()
    })

    // Inline pause & reconnect for failed server
    fireEvent.click(screen.getByRole("button", { name: /Pause & reconnect/i }))
    await waitFor(() => {
      expect(mocks.mcpApply).toHaveBeenCalledWith(
        expect.objectContaining({
          ops: [
            {
              agent: "claude_code",
              key: "broken-srv",
              action: "set_enabled",
              enabled: false,
            },
          ],
        })
      )
    })

    // Manage MCP opens Harness focused on the active agent
    fireEvent.click(screen.getByRole("button", { name: /Manage MCP/i }))
    expect(mocks.openHarness).toHaveBeenCalledWith({
      section: "mcp",
      agentId: "claude_code",
    })
  })

  it("shows Agent Settings button when custom agent has MCP disabled", async () => {
    mocks.mcpInventory.mockResolvedValue(
      inventory([
        agent("custom:goose", [], {
          custom: true,
          display_name: "Goose",
          writable: false,
          config: {
            status: "read_only",
            reason: { code: "mcp_disabled_in_agent_settings" },
          },
        }),
      ])
    )

    renderSection({ agentType: "custom:goose" })

    await waitFor(() => {
      expect(
        screen.getByText(/MCP support is disabled in this custom agent/i)
      ).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole("button", { name: /Agent settings/i }))
    expect(mocks.openSettingsWindow).toHaveBeenCalledWith("agents")
  })
})
