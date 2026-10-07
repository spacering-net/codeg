/**
 * The Fable pin (`ANTHROPIC_DEFAULT_FABLE_MODEL`, what Claude Code's `fable`
 * alias resolves to) rides the same plumbing as the other Claude model pins.
 * These drive the real panel: a pin read off the native config shows in its
 * field, an edit to it lands in that key and no other, and a bound provider
 * owns it like the other pins — set when the provider pins Fable, cleared when
 * it does not.
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
} from "@/lib/api"
import type { AcpAgentInfo, ModelProviderInfo } from "@/lib/types"

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

const FABLE_KEY = "ANTHROPIC_DEFAULT_FABLE_MODEL"

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

function provider(
  id: number,
  letter: string,
  model: Record<string, string>
): ModelProviderInfo {
  return {
    id,
    name: `Provider ${letter}`,
    api_url: `https://gateway-${letter.toLowerCase()}.test`,
    api_key: `key-${letter.toLowerCase()}`,
    api_key_masked: "",
    agent_type: "claude_code",
    model: JSON.stringify(model),
    created_at: "",
    updated_at: "",
  }
}

/** The control that sits under a visible `<label>` in the config card (the
 *  panel's labels carry no `htmlFor`). */
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
    (JSON.parse(config.value) as { env?: Record<string, string> }).env ?? {}
  )
}

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string
) {
  await user.click(controlUnder(label, "combobox"))
  const list = await screen.findByRole("listbox")
  await user.click(within(list).getByRole("option", { name: option }))
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

async function saveConfig(user: ReturnType<typeof userEvent.setup>) {
  const calls = vi.mocked(acpUpdateAgentEnv).mock.calls.length
  await user.click(
    screen.getByRole("button", { name: "Save Config Management" })
  )
  await waitFor(() =>
    expect(vi.mocked(acpUpdateAgentEnv).mock.calls.length).toBe(calls + 1)
  )
  const [, envPatch] = vi.mocked(acpUpdateAgentEnv).mock.calls[calls]
  return envPatch
}

describe("AcpAgentSettings — the Claude Code Fable model pin", () => {
  beforeEach(() => {
    vi.mocked(listModelProviders).mockResolvedValue([])
    vi.mocked(acpUpdateAgentEnv).mockResolvedValue(0)
    vi.mocked(acpUpdateAgentConfig).mockResolvedValue(0)
  })

  it("shows the pin from the native config, and an edit saves that key only", async () => {
    const user = userEvent.setup()
    await openPanel(
      claudeAgent({
        config_json: JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: "https://gateway.test",
            ANTHROPIC_AUTH_TOKEN: "key",
            [FABLE_KEY]: "gw/fable-old",
          },
        }),
      })
    )
    const fable = controlUnder("Default Fable Model", "textbox")
    await waitFor(() => expect(fable).toHaveValue("gw/fable-old"))
    expect(fable).not.toHaveAttribute("readonly")

    await user.clear(fable)
    await user.type(fable, "gw/fable-2")

    const env = nativeConfigEnv()
    expect(env[FABLE_KEY]).toBe("gw/fable-2")
    // The keystrokes reached the Fable pin and nothing else.
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
    expect(env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION).toBeUndefined()

    const envPatch = await saveConfig(user)
    expect(envPatch.env[FABLE_KEY]).toBe("gw/fable-2")
    expect(
      envPatch.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION
    ).toBeUndefined()
    const [, configPatch] = vi.mocked(acpUpdateAgentConfig).mock.calls[0]
    expect(JSON.parse(configPatch.config_json ?? "{}").env[FABLE_KEY]).toBe(
      "gw/fable-2"
    )
  })

  it("follows the bound provider: set by one that pins Fable, cleared by one that does not", async () => {
    vi.mocked(listModelProviders).mockResolvedValue([
      provider(1, "A", { main: "model-a", fable: "gw/fable-a" }),
      provider(2, "B", { main: "model-b" }),
    ])
    const user = userEvent.setup()
    await openPanel(claudeAgent())

    // A first-time pick takes the head of the list: Provider A.
    await choose(user, "Auth Mode", "Model Provider")
    const fable = () => controlUnder("Default Fable Model", "textbox")
    await waitFor(() => expect(fable()).toHaveValue("gw/fable-a"))
    expect(fable()).toHaveAttribute("readonly")
    expect(nativeConfigEnv()[FABLE_KEY]).toBe("gw/fable-a")
    const boundToA = await saveConfig(user)
    expect(boundToA.modelProviderId).toBe(1)
    expect(boundToA.env[FABLE_KEY]).toBe("gw/fable-a")

    await choose(user, "Select Model Provider", "Provider B")
    await waitFor(() => expect(fable()).toHaveValue(""))
    expect(nativeConfigEnv()).not.toHaveProperty(FABLE_KEY)
    const boundToB = await saveConfig(user)
    expect(boundToB.modelProviderId).toBe(2)
    expect(boundToB.env).not.toHaveProperty(FABLE_KEY)
    expect(boundToB.env.ANTHROPIC_MODEL).toBe("model-b")
  })
})
