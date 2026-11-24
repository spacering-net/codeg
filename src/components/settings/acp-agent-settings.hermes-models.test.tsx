/**
 * A custom Hermes endpoint's model field offers the models the endpoint
 * lists — the same list Hermes shows in the composer once codeg writes the
 * endpoint as its named provider.
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

function hermesAgent(): AcpAgentInfo {
  return {
    agent_type: "hermes",
    skills_capable: true,
    registry_id: "hermes",
    registry_version: "0.22.2",
    supports_custom_version: false,
    name: "Hermes Agent",
    description: "",
    available: true,
    distribution_type: "npx",
    is_acp_adapter: false,
    custom_source: null,
    enabled: true,
    sort_order: 0,
    installed_version: null,
    host_tools_agent_mode: false,
    env: {},
    config_json: JSON.stringify({
      provider: "custom",
      model: "glm-5.2",
      baseUrl: "https://gw.test/v1",
      apiKey: "sk-gw",
    }),
    config_file_path: null,
    codex_auth_json: null,
    cline_secrets_json: null,
    codex_config_toml: null,
    codex_model_catalog: null,
    codex_sandbox_settings: null,
    grok_config_toml: null,
    grok_settings: null,
    hermes_config_yaml: "",
    cursor_cli_config_json: null,
    cursor_settings: null,
    model_provider_id: null,
    icon_url: null,
  }
}

describe("AcpAgentSettings — a custom Hermes endpoint's models", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listModelProviders).mockResolvedValue([])
    vi.mocked(listProviderModels).mockResolvedValue({
      url: "https://gw.test/v1/models",
      models: [{ id: "glm-5.2" }, { id: "kimi-k3" }],
    })
  })

  it("lists them with the endpoint's key and offers them in the model field", async () => {
    const user = userEvent.setup()
    vi.mocked(acpListAgents).mockResolvedValue([hermesAgent()])
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
        protocol: "openai",
        baseUrl: "https://gw.test/v1",
        keySource: { kind: "inline", apiKey: "sk-gw" },
        keyHeader: null,
      })
    )
    await user.click(await screen.findByRole("option", { name: /kimi-k3/ }))
    expect(screen.getByDisplayValue("kimi-k3")).toBeInTheDocument()
  })
})
