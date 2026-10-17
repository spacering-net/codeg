import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { acpListAgents, listModelProviders } from "@/lib/api"
import type { AcpAgentInfo } from "@/lib/types"
import { AcpAgentSettings } from "./acp-agent-settings"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === "function" ? vi.fn(() => new Promise(() => {})) : value,
    ])
  )
})
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}))

describe("ZCode settings panel", () => {
  it("shows runtime overrides without offering unsupported credential/config writes", async () => {
    const agent: AcpAgentInfo = {
      agent_type: "zcode",
      name: "ZCode",
      registry_id: "codeg-zcode-acp",
      registry_version: "0.69.2",
      installed_version: "0.69.2",
      description: "Official ZCode runtime via the community ACP bridge",
      skills_capable: false,
      supports_custom_version: true,
      available: true,
      distribution_type: "npx",
      is_acp_adapter: true,
      enabled: true,
      sort_order: 0,
      env: {
        ZCODE_BIN: "C:/My ZCode/zcode.cjs",
        ZCODE_NODE: "C:/My Node/node.exe",
      },
      config_json: null,
      config_file_path: null,
      opencode_auth_json: null,
      codex_auth_json: null,
      codex_config_toml: null,
      codex_model_catalog: null,
      codex_sandbox_settings: null,
      cline_secrets_json: null,
      hermes_config_yaml: null,
      grok_config_toml: null,
      grok_settings: null,
      cursor_cli_config_json: null,
      cursor_settings: null,
      model_provider_id: null,
      host_tools_agent_mode: false,
      custom_source: null,
      icon_url: null,
    }
    vi.mocked(acpListAgents).mockResolvedValue([agent])
    vi.mocked(listModelProviders).mockResolvedValue([])
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AcpAgentSettings />
      </NextIntlClientProvider>
    )
    await screen.findByRole("heading", { name: "ZCode" })
    expect(await screen.findByRole("textbox")).toHaveValue(
      "ZCODE_BIN=C:/My ZCode/zcode.cjs\nZCODE_NODE=C:/My Node/node.exe"
    )
    expect(
      screen.getByText(enMessages.AcpAgentSettings.zcode.runtimeHint)
    ).toBeInTheDocument()
    expect(
      screen.queryByText("Native JSON Config", { selector: "label" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText("API Key", { selector: "label" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Save Config Management" })
    ).not.toBeInTheDocument()
  })
})
