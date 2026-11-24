/**
 * A Claude gateway's models in the Claude card: the model fields offer what
 * the gateway lists, the extra /model rows are picked from it and stored by
 * codeg (only while no provider is bound), and the switch that lets Claude
 * discover the gateway's own Claude models is set or removed — never "0",
 * which Claude reads as on.
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
  acpUpdateClaudeModelPicker,
  listModelProviders,
  listProviderModels,
} from "@/lib/api"
import type { AcpAgentInfo, ModelProviderInfo } from "@/lib/types"

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

const DISCOVERY = "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"
const GATEWAY_CONFIG = JSON.stringify({
  env: {
    ANTHROPIC_BASE_URL: "https://gateway.test",
    ANTHROPIC_AUTH_TOKEN: "gw-key",
    ANTHROPIC_MODEL: "glm-5.2",
  },
})

function claudeAgent(overrides: Partial<AcpAgentInfo> = {}): AcpAgentInfo {
  return {
    agent_type: "claude_code",
    skills_capable: true,
    registry_id: "claude-code",
    registry_version: "1.0.0",
    supports_custom_version: false,
    name: "Claude Code",
    description: "",
    available: true,
    distribution_type: "npx",
    is_acp_adapter: true,
    custom_source: null,
    enabled: true,
    sort_order: 0,
    installed_version: null,
    host_tools_agent_mode: false,
    env: {},
    config_json: GATEWAY_CONFIG,
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

function controlUnder(label: string, role: "combobox" | "textbox") {
  const labelEl = screen.getByText(label, { selector: "label" })
  return within(labelEl.parentElement as HTMLElement).getByRole(role)
}

function nativeConfigEnv(): Record<string, string> {
  const config = controlUnder(
    "Native JSON Config",
    "textbox"
  ) as HTMLTextAreaElement
  return (
    (JSON.parse(config.value || "{}") as { env?: Record<string, string> })
      .env ?? {}
  )
}

async function openPanel(agent: AcpAgentInfo) {
  vi.mocked(acpListAgents).mockResolvedValue([agent])
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AcpAgentSettings />
    </NextIntlClientProvider>
  )
  await screen.findByText("Native JSON Config", { selector: "label" })
}

async function save(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: "Save Config Management" })
  )
  await waitFor(() => expect(acpUpdateAgentConfig).toHaveBeenCalled())
}

describe("AcpAgentSettings — a Claude gateway's models", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listModelProviders).mockResolvedValue([])
    vi.mocked(acpUpdateAgentEnv).mockResolvedValue(0)
    vi.mocked(acpUpdateAgentConfig).mockResolvedValue(0)
    vi.mocked(acpUpdateClaudeModelPicker).mockResolvedValue(0)
    vi.mocked(listProviderModels).mockResolvedValue({
      url: "https://gateway.test/v1/models",
      models: [{ id: "glm-5.2" }, { id: "kimi-k3" }, { id: "qwen-4" }],
    })
  })

  it("lists the gateway's models with its Bearer key, offers them, and stores the picked rows", async () => {
    const user = userEvent.setup()
    await openPanel(claudeAgent({ claude_model_picker: ["mine"] }))
    expect(screen.getByText("mine")).toBeVisible()

    // Nothing is asked until a list of the gateway's models is opened.
    expect(listProviderModels).not.toHaveBeenCalled()

    // A model field picks from the list, which opening it fetches.
    const haiku = screen.getByText("Default Haiku Model", { selector: "label" })
    await user.click(
      within(haiku.parentElement as HTMLElement).getByRole("button", {
        name: "Choose from the provider's models",
      })
    )
    await waitFor(() =>
      expect(listProviderModels).toHaveBeenCalledWith({
        protocol: "anthropic",
        baseUrl: "https://gateway.test",
        keySource: { kind: "inline", apiKey: "gw-key" },
        keyHeader: "bearer",
      })
    )
    expect(await screen.findByText("3 models · gateway.test")).toBeVisible()
    await user.click(await screen.findByRole("option", { name: /qwen-4/ }))
    expect(nativeConfigEnv().ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("qwen-4")
    // The other fields share that list: opening one asks nothing again.
    const opus = screen.getByText("Default Opus Model", { selector: "label" })
    await user.click(
      within(opus.parentElement as HTMLElement).getByRole("button", {
        name: "Choose from the provider's models",
      })
    )
    expect(await screen.findByRole("option", { name: /glm-5.2/ })).toBeVisible()
    expect(listProviderModels).toHaveBeenCalledTimes(1)
    await user.keyboard("{Escape}")

    // The extra /model rows: picked, the unlisted one kept.
    await user.click(screen.getByRole("button", { name: "Choose models…" }))
    const dialog = await screen.findByRole("dialog")
    const kimi = within(dialog).getByText("kimi-k3").closest("label")!
    await user.click(within(kimi).getByRole("checkbox"))
    await user.click(
      within(dialog).getByRole("button", { name: "Use 2 models" })
    )
    expect(screen.getByText("kimi-k3")).toBeVisible()

    await save(user)
    await waitFor(() =>
      expect(acpUpdateClaudeModelPicker).toHaveBeenCalledWith([
        "mine",
        "kimi-k3",
      ])
    )
  })

  it("does not store unchanged rows", async () => {
    const user = userEvent.setup()
    await openPanel(claudeAgent({ claude_model_picker: ["mine"] }))
    await save(user)
    expect(acpUpdateClaudeModelPicker).not.toHaveBeenCalled()
  })

  it("sets the discovery switch to 1 and removes it again", async () => {
    const user = userEvent.setup()
    await openPanel(claudeAgent())
    const toggle = screen.getByRole("switch", {
      name: "Let Claude Code list the gateway's Claude models",
    })
    expect(toggle).not.toBeChecked()
    await user.click(toggle)
    expect(nativeConfigEnv()[DISCOVERY]).toBe("1")
    await save(user)
    const [, onPatch] = vi.mocked(acpUpdateAgentEnv).mock.calls[0]
    expect(onPatch.env[DISCOVERY]).toBe("1")

    await user.click(toggle)
    expect(nativeConfigEnv()).not.toHaveProperty(DISCOVERY)
    vi.mocked(acpUpdateAgentConfig).mockClear()
    await save(user)
    const envCalls = vi.mocked(acpUpdateAgentEnv).mock.calls
    const offPatch = envCalls[envCalls.length - 1][1]
    // Off is the key gone from both layers, never "0" (which reads as on).
    expect(offPatch.env).not.toHaveProperty(DISCOVERY)
    const [, configPatch] = vi.mocked(acpUpdateAgentConfig).mock.calls[0]
    // `null` is the config patch's "remove this key".
    expect(
      JSON.parse(configPatch.config_json ?? "{}").env[DISCOVERY]
    ).toBeNull()
  })

  it("shows a bound provider's rows without editing or storing them", async () => {
    const bound: ModelProviderInfo = {
      id: 7,
      name: "Relay",
      api_url: "https://relay.test",
      api_key: "relay-key",
      api_key_masked: "",
      agent_type: "claude_code",
      model: JSON.stringify({ main: "glm-5.2", pickerModels: ["glm-5.2"] }),
      created_at: "",
      updated_at: "",
    }
    vi.mocked(listModelProviders).mockResolvedValue([bound])
    const user = userEvent.setup()
    await openPanel(
      claudeAgent({ model_provider_id: 7, claude_model_picker: ["mine"] })
    )
    await waitFor(() =>
      expect(screen.getByText("Set in the bound model provider.")).toBeVisible()
    )
    expect(screen.queryByText("mine")).toBeNull()
    expect(screen.queryByRole("button", { name: "Choose models…" })).toBeNull()
    await save(user)
    expect(acpUpdateClaudeModelPicker).not.toHaveBeenCalled()
  })
})
