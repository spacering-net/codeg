/**
 * The Command Code panel writes its API key through `persistEnv`, while the
 * enable switch persists the raw editor's draft WHOLESALE. The panel's save has
 * to fold its key into that draft, or flipping the switch afterwards would
 * silently bring back a key the user just cleared.
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

function commandCodeAgent(overrides: Partial<AcpAgentInfo> = {}): AcpAgentInfo {
  return {
    agent_type: "command_code",
    skills_capable: true,
    registry_id: "codeg-command-code",
    registry_version: "1.84.0",
    supports_custom_version: true,
    name: "Command Code",
    description: "",
    available: true,
    distribution_type: "npx",
    is_acp_adapter: false,
    install_url: null,
    supports_self_update: false,
    custom_source: null,
    enabled: true,
    sort_order: 0,
    installed_version: "1.84.0",
    host_tools_agent_mode: false,
    env: {},
    config_json: null,
    config_file_path: null,
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

describe("AcpAgentSettings — the Command Code panel", () => {
  beforeEach(() => {
    // Call counts would otherwise carry over from the previous test.
    vi.clearAllMocks()
    vi.mocked(listModelProviders).mockResolvedValue([])
    vi.mocked(acpUpdateAgentEnv).mockResolvedValue(0)
  })

  it("shows the sign-in command and saves the API key", async () => {
    const user = userEvent.setup()
    vi.mocked(acpListAgents).mockResolvedValue([
      commandCodeAgent({ env: { OTHER: "keep" } }),
    ])
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AcpAgentSettings />
      </NextIntlClientProvider>
    )

    expect(await screen.findByText("command-code login")).toBeInTheDocument()
    await user.type(screen.getByLabelText("API key (optional)"), "user_abc")
    await user.click(
      screen.getByRole("button", { name: "Save Command Code Config" })
    )
    await waitFor(() => expect(acpUpdateAgentEnv).toHaveBeenCalledTimes(1))
    const [agentType, saved] = vi.mocked(acpUpdateAgentEnv).mock.calls[0]
    expect(agentType).toBe("command_code")
    expect(saved.env).toEqual({
      OTHER: "keep",
      COMMAND_CODE_API_KEY: "user_abc",
    })
  })

  it("keeps a cleared key cleared when the agent is toggled afterwards", async () => {
    const user = userEvent.setup()
    vi.mocked(acpListAgents).mockResolvedValue([
      commandCodeAgent({
        env: { COMMAND_CODE_API_KEY: "old", OTHER: "keep" },
      }),
    ])
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AcpAgentSettings />
      </NextIntlClientProvider>
    )

    await user.clear(await screen.findByLabelText("API key (optional)"))
    await user.click(
      screen.getByRole("button", { name: "Save Command Code Config" })
    )
    await waitFor(() => expect(acpUpdateAgentEnv).toHaveBeenCalledTimes(1))
    expect(vi.mocked(acpUpdateAgentEnv).mock.calls[0][1].env).toEqual({
      OTHER: "keep",
    })

    // The switch stays locked until the save lands; a click before then is
    // dropped.
    const toggle = screen.getByRole("switch", {
      name: "Command Code enable switch",
    })
    await waitFor(() => expect(toggle).toBeEnabled())
    await user.click(toggle)
    await waitFor(() => expect(acpUpdateAgentEnv).toHaveBeenCalledTimes(2))
    const [, toggled] = vi.mocked(acpUpdateAgentEnv).mock.calls[1]
    expect(toggled.enabled).toBe(false)
    expect(toggled.env).toEqual({ OTHER: "keep" })
  })
})
