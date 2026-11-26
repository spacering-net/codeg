import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { ConfigStaleKind, ConnectionStatus } from "@/lib/types"
import { SessionConfigStaleBanner } from "./session-config-stale-banner"

const mocks = vi.hoisted(() => ({
  connection: {
    configStale: true,
    configStaleKind: "agent_config" as ConfigStaleKind | null,
    configStaleDismissed: false,
    isViewer: false,
    isDelegationChild: false,
    status: "connected" as ConnectionStatus | null,
    reapplyConfig: vi.fn(async () => true),
    dismissConfigStale: vi.fn(),
  },
  toastSuccess: vi.fn(),
}))

vi.mock("@/hooks/use-connection", () => ({
  useConnection: () => mocks.connection,
}))

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
  },
}))

function renderBanner() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SessionConfigStaleBanner contextKey="tab-1" />
    </NextIntlClientProvider>
  )
}

describe("SessionConfigStaleBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.connection.configStale = true
    mocks.connection.configStaleKind = "agent_config"
    mocks.connection.configStaleDismissed = false
    mocks.connection.isViewer = false
    mocks.connection.isDelegationChild = false
    mocks.connection.status = "connected"
    mocks.connection.reapplyConfig.mockResolvedValue(true)
  })

  it("shows dedicated MCP wording when configStaleKind is mcp_config", async () => {
    mocks.connection.configStaleKind = "mcp_config"
    renderBanner()

    expect(screen.getByText("MCP configuration changed")).toBeInTheDocument()
    const reconnectButton = screen.getByRole("button", {
      name: /Reconnect to apply/i,
    })
    fireEvent.click(reconnectButton)

    await waitFor(() => {
      expect(mocks.connection.reapplyConfig).toHaveBeenCalledTimes(1)
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "New configuration applied"
      )
    })
  })

  it("disables reconnect while a turn is prompting", () => {
    mocks.connection.configStaleKind = "mcp_config"
    mocks.connection.status = "prompting"
    renderBanner()

    expect(
      screen.getByRole("button", { name: /Reconnect to apply/i })
    ).toBeDisabled()
  })

  it("renders agent_config and model_provider titles as before", () => {
    mocks.connection.configStaleKind = "model_provider"
    const { rerender } = renderBanner()
    expect(screen.getByText("Model provider updated")).toBeInTheDocument()

    mocks.connection.configStaleKind = "agent_config"
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SessionConfigStaleBanner contextKey="tab-1" />
      </NextIntlClientProvider>
    )
    expect(screen.getByText("Agent settings updated")).toBeInTheDocument()
  })
})
