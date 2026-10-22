/**
 * The TRAE CLI panel writes its two env keys through `persistEnv`, while the
 * enable switch persists the raw editor's draft WHOLESALE. The panel's save has
 * to fold its keys into that draft, or flipping the switch afterwards would
 * silently bring back a token the user just cleared.
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { acpListAgents, acpUpdateAgentEnv, listModelProviders } from "@/lib/api"
import type { AcpAgentInfo } from "@/lib/types"

import { AcpAgentSettings } from "./acp-agent-settings"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  // Every function is stubbed so nothing here can reach the real transport;
  // the calls the panel makes on mount that these tests don't need (preflight,
  // catalogs) simply never settle.
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === "function" ? vi.fn(() => new Promise(() => {})) : value,
    ])
  )
})
vi.mock("next/navigation", () => {
  const params = new URLSearchParams()
  return { useSearchParams: () => params }
})

function traeAgent(overrides: Partial<AcpAgentInfo> = {}): AcpAgentInfo {
  return {
    agent_type: "trae",
    skills_capable: true,
    registry_id: "codeg-trae-cli",
    registry_version: null,
    supports_custom_version: false,
    name: "TRAE CLI",
    description: "",
    available: true,
    distribution_type: "system",
    is_acp_adapter: false,
    install_url: "https://docs.trae.cn/cli_get-started-with-trae-cli-2",
    supports_self_update: true,
    custom_source: null,
    enabled: true,
    sort_order: 0,
    installed_version: "0.209.1",
    host_tools_agent_mode: false,
    env: {},
    config_json: null,
    config_file_path: null,
    opencode_auth_json: null,
    codex_auth_json: null,
    cline_secrets_json: null,
    codex_config_toml: null,
    codex_model_catalog: null,
    codex_sandbox_settings: null,
    grok_config_toml: null,
    grok_settings: null,
    hermes_config_yaml: null,
    cursor_cli_config_json: null,
    cursor_settings: null,
    model_provider_id: null,
    icon_url: null,
    ...overrides,
  }
}

describe("AcpAgentSettings — the TRAE CLI panel", () => {
  beforeEach(() => {
    // Call counts would otherwise carry over from the previous test.
    vi.clearAllMocks()
    vi.mocked(listModelProviders).mockResolvedValue([])
    vi.mocked(acpUpdateAgentEnv).mockResolvedValue(0)
  })

  it("shows the sign-in command and saves the token and API URL", async () => {
    const user = userEvent.setup()
    vi.mocked(acpListAgents).mockResolvedValue([
      traeAgent({ env: { OTHER: "keep" } }),
    ])
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AcpAgentSettings />
      </NextIntlClientProvider>
    )

    expect(await screen.findByText("traecli login")).toBeInTheDocument()
    await user.type(
      screen.getByLabelText("Personal access token (optional)"),
      "pat_123"
    )
    await user.type(
      screen.getByLabelText("Enterprise API URL (optional)"),
      "https://api.example.com"
    )
    await user.click(
      screen.getByRole("button", { name: "Save TRAE CLI Config" })
    )
    await waitFor(() => expect(acpUpdateAgentEnv).toHaveBeenCalledTimes(1))
    const [agentType, saved] = vi.mocked(acpUpdateAgentEnv).mock.calls[0]
    expect(agentType).toBe("trae")
    expect(saved.env).toEqual({
      OTHER: "keep",
      TRAECLI_PERSONAL_ACCESS_TOKEN: "pat_123",
      TRAECLI_HOST: "https://api.example.com",
    })
  })

  it("keeps a cleared token cleared when the agent is toggled afterwards", async () => {
    const user = userEvent.setup()
    vi.mocked(acpListAgents).mockResolvedValue([
      traeAgent({
        env: { TRAECLI_PERSONAL_ACCESS_TOKEN: "old", OTHER: "keep" },
      }),
    ])
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AcpAgentSettings />
      </NextIntlClientProvider>
    )

    await user.clear(
      await screen.findByLabelText("Personal access token (optional)")
    )
    await user.click(
      screen.getByRole("button", { name: "Save TRAE CLI Config" })
    )
    await waitFor(() => expect(acpUpdateAgentEnv).toHaveBeenCalledTimes(1))
    expect(vi.mocked(acpUpdateAgentEnv).mock.calls[0][1].env).toEqual({
      OTHER: "keep",
    })

    await user.click(
      screen.getByRole("switch", { name: "TRAE CLI enable switch" })
    )
    await waitFor(() => expect(acpUpdateAgentEnv).toHaveBeenCalledTimes(2))
    const [, toggled] = vi.mocked(acpUpdateAgentEnv).mock.calls[1]
    expect(toggled.enabled).toBe(false)
    expect(toggled.env).toEqual({ OTHER: "keep" })
  })
})
