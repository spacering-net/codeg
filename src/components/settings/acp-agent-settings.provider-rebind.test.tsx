/**
 * Leaving "model_provider" auth mode drops the draft's provider binding (a save
 * in another mode must not persist one), so coming back falls into the
 * auto-select. That auto-select used to take the head of the provider list —
 * the OLDEST provider, since the list is ordered by row id — and the rebind is
 * provider-authoritative: it rewrites the model fields, the env text and the
 * config text from whichever provider it lands on. These drive the real panel
 * through that round trip and pin where it lands: the user's own last pick,
 * then the binding saved on the agent, and only then the head.
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

function provider(id: number, letter: string): ModelProviderInfo {
  return {
    id,
    name: `Provider ${letter}`,
    api_url: `https://gateway-${letter.toLowerCase()}.test`,
    api_key: `key-${letter.toLowerCase()}`,
    api_key_masked: "",
    agent_type: "claude_code",
    model: JSON.stringify({ main: `model-${letter.toLowerCase()}` }),
    created_at: "",
    updated_at: "",
  }
}

// Row-id order, as `list_all` returns them: A is the oldest, so the head.
const PROVIDERS = [provider(1, "A"), provider(2, "B"), provider(3, "C")]

function renderPanel() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AcpAgentSettings />
    </NextIntlClientProvider>
  )
}

/** The select that sits under a visible `<label>` in the config card. */
function selectUnder(label: string): HTMLElement {
  const labelEl = screen.getByText(label, { selector: "label" })
  return within(labelEl.parentElement as HTMLElement).getByRole("combobox")
}

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string
) {
  await user.click(selectUnder(label))
  const list = await screen.findByRole("listbox")
  await user.click(within(list).getByRole("option", { name: option }))
}

async function expectBoundTo(letter: string) {
  await waitFor(() =>
    expect(selectUnder("Select Model Provider")).toHaveTextContent(
      `Provider ${letter}`
    )
  )
  const labelEl = screen.getByText("Native JSON Config", { selector: "label" })
  const config = within(labelEl.parentElement as HTMLElement).getByRole(
    "textbox"
  ) as HTMLTextAreaElement
  expect(JSON.parse(config.value).env.ANTHROPIC_MODEL).toBe(
    `model-${letter.toLowerCase()}`
  )
}

async function openPanel(agent: AcpAgentInfo) {
  vi.mocked(acpListAgents).mockResolvedValue([agent])
  renderPanel()
  await screen.findByText("Native JSON Config", { selector: "label" })
}

describe("AcpAgentSettings — provider rebind across an auth-mode round trip", () => {
  beforeEach(() => {
    vi.mocked(listModelProviders).mockResolvedValue(PROVIDERS)
    vi.mocked(acpUpdateAgentEnv).mockResolvedValue(0)
    vi.mocked(acpUpdateAgentConfig).mockResolvedValue(0)
  })

  it("returns to an unsaved pick, and Save persists that provider", async () => {
    const user = userEvent.setup()
    await openPanel(claudeAgent())

    // A first-time pick has nothing to return to, so it takes the head.
    await choose(user, "Auth Mode", "Model Provider")
    await expectBoundTo("A")
    await choose(user, "Select Model Provider", "Provider B")
    await expectBoundTo("B")

    await choose(user, "Auth Mode", "Custom Endpoint")
    await choose(user, "Auth Mode", "Model Provider")
    await expectBoundTo("B")

    await user.click(
      screen.getByRole("button", { name: "Save Config Management" })
    )
    await waitFor(() => expect(acpUpdateAgentConfig).toHaveBeenCalledTimes(1))
    expect(acpUpdateAgentEnv).toHaveBeenCalledTimes(1)
    expect(acpUpdateAgentEnv).toHaveBeenCalledWith(
      "claude_code",
      expect.objectContaining({
        modelProviderId: 2,
        env: expect.objectContaining({ ANTHROPIC_MODEL: "model-b" }),
      })
    )
    const [, configPatch] = vi.mocked(acpUpdateAgentConfig).mock.calls[0]
    expect(
      JSON.parse(configPatch.config_json ?? "{}").env.ANTHROPIC_MODEL
    ).toBe("model-b")
  })

  it("returns to the saved binding when nothing was picked", async () => {
    const user = userEvent.setup()
    await openPanel(claudeAgent({ model_provider_id: 2 }))
    await waitFor(() =>
      expect(selectUnder("Select Model Provider")).toHaveTextContent(
        "Provider B"
      )
    )

    await choose(user, "Auth Mode", "Official Subscription")
    await choose(user, "Auth Mode", "Model Provider")
    await expectBoundTo("B")
  })

  it("prefers the last pick over the saved binding", async () => {
    const user = userEvent.setup()
    await openPanel(claudeAgent({ model_provider_id: 2 }))
    await choose(user, "Select Model Provider", "Provider C")
    await expectBoundTo("C")

    await choose(user, "Auth Mode", "Custom Endpoint")
    await choose(user, "Auth Mode", "Model Provider")
    await expectBoundTo("C")
  })
})
