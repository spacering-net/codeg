/**
 * An OpenAI-compatible provider in the Cline card: its model field offers the
 * provider's listed models, and the models.json table — the only models a
 * Cline session can pick for it — is edited as a list and saved whole.
 */
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  acpListAgents,
  acpUpdateAgentConfig,
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

function clineAgent(config: Record<string, unknown>): AcpAgentInfo {
  return {
    agent_type: "cline",
    skills_capable: true,
    registry_id: "cline",
    registry_version: "3.0.73",
    supports_custom_version: false,
    name: "Cline",
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
    config_json: JSON.stringify(config),
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

const RELAY = {
  apiProvider: "openai-compatible",
  apiKey: "sk-relay",
  model: "glm-5.2",
  apiBaseUrl: "https://relay.test/v1",
}

async function openPanel(agent: AcpAgentInfo) {
  vi.mocked(acpListAgents).mockResolvedValue([agent])
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AcpAgentSettings />
    </NextIntlClientProvider>
  )
  await screen.findByRole("button", { name: "Save Cline Config" })
}

async function savedConfig(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Save Cline Config" }))
  await waitFor(() => expect(acpUpdateAgentConfig).toHaveBeenCalled())
  const [, patch] = vi.mocked(acpUpdateAgentConfig).mock.calls[0]
  return JSON.parse(patch.config_json ?? "{}") as Record<string, unknown>
}

describe("AcpAgentSettings — Cline's OpenAI-compatible model table", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listModelProviders).mockResolvedValue([])
    vi.mocked(acpUpdateAgentConfig).mockResolvedValue(0)
    vi.mocked(listProviderModels).mockResolvedValue({
      url: "https://relay.test/v1/models",
      models: [{ id: "glm-5.2" }, { id: "kimi-k3" }],
    })
  })

  it("picks the table from the provider's list and saves it whole", async () => {
    const user = userEvent.setup()
    await openPanel(clineAgent({ ...RELAY, models: ["glm-5.2", "old"] }))
    expect(screen.getByText("old")).toBeVisible()

    await user.click(screen.getByRole("button", { name: "Choose models…" }))
    await waitFor(() =>
      expect(listProviderModels).toHaveBeenCalledWith({
        protocol: "openai",
        baseUrl: "https://relay.test/v1",
        keySource: { kind: "inline", apiKey: "sk-relay" },
        keyHeader: null,
      })
    )
    const dialog = await screen.findByRole("dialog")
    for (const id of ["kimi-k3", "old"]) {
      const row = (await within(dialog).findByText(id)).closest("label")!
      await user.click(within(row).getByRole("checkbox"))
    }
    await user.click(
      within(dialog).getByRole("button", { name: "Use 2 models" })
    )

    const saved = await savedConfig(user)
    expect(saved.models).toEqual(["glm-5.2", "kimi-k3"])
    expect(saved.model).toBe("glm-5.2")
  })

  it("keeps the loaded table when the raw text drops its models key", async () => {
    const user = userEvent.setup()
    await openPanel(clineAgent({ ...RELAY, models: ["glm-5.2", "old"] }))
    const raw = screen.getByPlaceholderText(/"apiProvider": "anthropic"/)
    await user.clear(raw)
    // Typed text never names the table…
    await user.click(raw)
    await user.paste(JSON.stringify(RELAY))
    expect(screen.getByText("old")).toBeVisible()
    // …so a pick edits the whole table, not just the pick.
    await user.type(
      screen.getByRole("textbox", { name: "Add a model id" }),
      "kimi-k3{Enter}"
    )
    const saved = await savedConfig(user)
    expect(saved.models).toEqual(["glm-5.2", "old", "kimi-k3"])
  })

  it("leaves a table it never saw alone", async () => {
    const user = userEvent.setup()
    await openPanel(clineAgent(RELAY))
    const saved = await savedConfig(user)
    expect(saved).not.toHaveProperty("models")
  })

  it("offers no provider list for a provider with a built-in catalogue", async () => {
    await openPanel(
      clineAgent({ apiProvider: "anthropic", apiKey: "sk", model: "m" })
    )
    expect(screen.queryByRole("button", { name: "Fetch models" })).toBeNull()
    expect(screen.queryByText("Models in Cline's list")).toBeNull()
  })
})
