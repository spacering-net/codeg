/**
 * A Gemini API key panel offers the models the Gemini API lists for that key
 * (Gemini CLI itself only offers its built-in list).
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  acpListAgents,
  listModelProviders,
  listProviderModels,
} from "@/lib/api"
import type { AcpAgentInfo } from "@/lib/types"

import { AcpAgentSettings } from "./acp-agent-settings"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  // Every function is stubbed so nothing here can reach the real transport;
  // the calls these tests don't need simply never settle.
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

function geminiAgent(): AcpAgentInfo {
  return {
    agent_type: "gemini",
    skills_capable: true,
    registry_id: "gemini",
    registry_version: "0.60.0",
    supports_custom_version: false,
    name: "Gemini CLI",
    description: "",
    available: true,
    distribution_type: "npx",
    is_acp_adapter: false,
    custom_source: null,
    enabled: true,
    sort_order: 0,
    installed_version: null,
    host_tools_agent_mode: false,
    env: { GEMINI_API_KEY: "gk-test" },
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
  }
}

describe("AcpAgentSettings — the Gemini API's models", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listModelProviders).mockResolvedValue([])
    vi.mocked(listProviderModels).mockResolvedValue({
      url: "https://generativelanguage.googleapis.com/v1beta/models",
      models: [{ id: "gemini-3-pro" }, { id: "gemini-3-flash" }],
    })
  })

  it("lists them with the key, at Google's endpoint, and offers them", async () => {
    const user = userEvent.setup()
    vi.mocked(acpListAgents).mockResolvedValue([geminiAgent()])
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AcpAgentSettings />
      </NextIntlClientProvider>
    )
    // Opening the model field's list asks the endpoint.
    await user.click(
      await screen.findByRole("button", {
        name: "Choose from the provider's models",
      })
    )
    await waitFor(() =>
      expect(listProviderModels).toHaveBeenCalledWith({
        protocol: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com",
        keySource: { kind: "inline", apiKey: "gk-test" },
        keyHeader: null,
      })
    )
    await user.click(
      await screen.findByRole("option", { name: /gemini-3-flash/ })
    )
    expect(screen.getByDisplayValue("gemini-3-flash")).toBeInTheDocument()
  })
})
