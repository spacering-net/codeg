/**
 * The Kiro panel writes its env keys through `persistEnv`, while the enable
 * switch persists the raw editor's draft WHOLESALE. The panel's save has to
 * fold its keys into that draft, or flipping the switch afterwards silently
 * brings back whatever the draft held before — here `--trust-all-tools`, after
 * the user chose to be asked again.
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

function kiroAgent(overrides: Partial<AcpAgentInfo> = {}): AcpAgentInfo {
  return {
    agent_type: "kiro",
    skills_capable: true,
    registry_id: "kiro-cli",
    registry_version: null,
    supports_custom_version: false,
    name: "Kiro CLI",
    description: "",
    available: true,
    distribution_type: "system",
    is_acp_adapter: false,
    install_url: "https://kiro.dev/docs/getting-started/installation/",
    supports_self_update: true,
    custom_source: null,
    enabled: true,
    sort_order: 0,
    installed_version: "2.24.1",
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

describe("AcpAgentSettings — the Kiro panel and the enable switch", () => {
  beforeEach(() => {
    vi.mocked(listModelProviders).mockResolvedValue([])
    vi.mocked(acpUpdateAgentEnv).mockResolvedValue(0)
  })

  it("keeps a switch back to asking when the agent is toggled afterwards", async () => {
    const user = userEvent.setup()
    vi.mocked(acpListAgents).mockResolvedValue([
      kiroAgent({ env: { KIRO_TRUST_ALL_TOOLS: "1", OTHER: "keep" } }),
    ])
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AcpAgentSettings />
      </NextIntlClientProvider>
    )

    await user.click(
      await screen.findByRole("combobox", { name: "Permission mode" })
    )
    await user.click(
      await screen.findByRole("option", {
        name: "Ask before running tools (default)",
      })
    )
    await user.click(screen.getByRole("button", { name: "Save Kiro Config" }))
    await waitFor(() => expect(acpUpdateAgentEnv).toHaveBeenCalledTimes(1))
    expect(vi.mocked(acpUpdateAgentEnv).mock.calls[0][1].env).toEqual({
      KIRO_TRUST_ALL_TOOLS: "0",
      OTHER: "keep",
    })

    // The switch stays locked until the save lands; a click before then is
    // dropped.
    const toggle = screen.getByRole("switch", {
      name: "Kiro CLI enable switch",
    })
    await waitFor(() => expect(toggle).toBeEnabled())
    await user.click(toggle)
    await waitFor(() => expect(acpUpdateAgentEnv).toHaveBeenCalledTimes(2))
    const [, toggled] = vi.mocked(acpUpdateAgentEnv).mock.calls[1]
    expect(toggled.enabled).toBe(false)
    expect(toggled.env).toEqual({ KIRO_TRUST_ALL_TOOLS: "0", OTHER: "keep" })
  })
})
