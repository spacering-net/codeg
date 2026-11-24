/**
 * The Grok custom-model card's other models: the endpoint's own list, asked
 * the way its backend talks, picked into codeg's extra `[model.<id>]`
 * entries — sent only once the list moved.
 */
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  acpListAgents,
  acpUpdateAgentConfig,
  acpUpdateAgentEnv,
  listModelProviders,
  listProviderModels,
} from "@/lib/api"
import type { AcpAgentInfo, GrokSettings } from "@/lib/types"

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

const CONFIG_TOML = [
  "[models]",
  'default = "grok-4.7"',
  "",
  '[model."grok-4.7"]',
  'model = "grok-4.7"',
  'base_url = "https://gateway.example/v1"',
  'api_backend = "responses"',
  "",
].join("\n")

function grokAgent(settings: Partial<GrokSettings> = {}): AcpAgentInfo {
  return {
    agent_type: "grok",
    skills_capable: true,
    registry_id: "grok-build",
    registry_version: "1.0.62",
    supports_custom_version: false,
    name: "Grok",
    description: "",
    available: true,
    distribution_type: "npx",
    is_acp_adapter: false,
    custom_source: null,
    enabled: true,
    sort_order: 0,
    installed_version: "1.0.62",
    host_tools_agent_mode: false,
    env: { GROK_AUTH_MODE: "custom" },
    config_json: null,
    config_file_path: null,
    codex_auth_json: null,
    cline_secrets_json: null,
    codex_config_toml: null,
    codex_model_catalog: null,
    codex_sandbox_settings: null,
    grok_config_toml: CONFIG_TOML,
    grok_settings: {
      default_reasoning_effort: null,
      permission_mode: null,
      custom_model_id: "grok-4.7",
      custom_base_url: "https://gateway.example/v1",
      custom_api_key: null,
      custom_api_backend: "responses",
      custom_context_window: null,
      custom_reasoning_efforts: [],
      custom_extra_models: ["extra-a"],
      auto_compact_threshold_percent: null,
      ...settings,
    },
    hermes_config_yaml: null,
    cursor_cli_config_json: null,
    cursor_settings: null,
    model_provider_id: null,
    icon_url: null,
  }
}

async function openPanel(agent: AcpAgentInfo) {
  vi.mocked(acpListAgents).mockResolvedValue([agent])
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AcpAgentSettings />
    </NextIntlClientProvider>
  )
  await screen.findByRole("button", { name: "Save Grok Config" })
}

async function savedGrokStructured() {
  await waitFor(() => expect(acpUpdateAgentConfig).toHaveBeenCalledTimes(1))
  const [, saved] = vi.mocked(acpUpdateAgentConfig).mock.calls[0]
  return saved.grok_structured
}

describe("AcpAgentSettings — Grok's other models from the endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listModelProviders).mockResolvedValue([])
    vi.mocked(acpUpdateAgentEnv).mockResolvedValue(0)
    vi.mocked(acpUpdateAgentConfig).mockResolvedValue(0)
    vi.mocked(listProviderModels).mockResolvedValue({
      url: "https://gateway.example/v1/models",
      models: [{ id: "grok-4.7" }, { id: "extra-a" }, { id: "extra-b" }],
    })
  })

  it("picks them from the endpoint's list and sends the moved list", async () => {
    const user = userEvent.setup()
    await openPanel(
      grokAgent({ custom_api_key: "sk-gw", custom_api_backend: "messages" })
    )
    expect(screen.getByText("extra-a")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Choose models…" }))
    await waitFor(() =>
      expect(listProviderModels).toHaveBeenCalledWith({
        protocol: "anthropic",
        baseUrl: "https://gateway.example/v1",
        keySource: { kind: "inline", apiKey: "sk-gw" },
        keyHeader: null,
      })
    )
    const dialog = await screen.findByRole("dialog")
    const row = (await within(dialog).findByText("extra-b")).closest("label")!
    await user.click(within(row).getByRole("checkbox"))
    await user.click(
      within(dialog).getByRole("button", { name: "Use 2 models" })
    )
    await user.click(screen.getByRole("button", { name: "Save Grok Config" }))
    expect((await savedGrokStructured())?.customExtraModels).toEqual([
      "extra-a",
      "extra-b",
    ])
  })

  it("keeps the extras as they are while the list is untouched", async () => {
    const user = userEvent.setup()
    await openPanel(grokAgent())
    await user.click(screen.getByRole("button", { name: "Save Grok Config" }))
    expect(await savedGrokStructured()).not.toHaveProperty("customExtraModels")
  })
})
