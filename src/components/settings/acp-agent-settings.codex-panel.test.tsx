/**
 * The Codex configuration card, driven through the real panel:
 * - the Fast and Skills switches are gone (the composer owns Fast per
 *   session; codex dropped the `skills` flag in 0.80.0);
 * - the WebSocket switch exists only in the provider modes, and writes the
 *   provider's `supports_websockets` and nothing else;
 * - config.toml is shown and saved as it is on disk — no forced
 *   `disable_response_storage = true`.
 */
import { render, screen, waitFor, within } from "@testing-library/react"
import { parse as parseTomlDocument } from "smol-toml"
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

const SUBSCRIPTION_AUTH = JSON.stringify({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: { access_token: "at", refresh_token: "rt", id_token: "it" },
})
const API_KEY_AUTH = JSON.stringify({ OPENAI_API_KEY: "sk-test" })

const API_KEY_CONFIG = [
  'model = "gpt-5.5"',
  'model_provider = "codeg"',
  "",
  "[model_providers.codeg]",
  'base_url = "https://relay.example/v1"',
  'name = "codeg"',
  'wire_api = "responses"',
  "requires_openai_auth = true",
  "",
].join("\n")

function codexAgent(overrides: Partial<AcpAgentInfo> = {}): AcpAgentInfo {
  return {
    agent_type: "codex",
    skills_capable: true,
    registry_id: "codex-acp",
    registry_version: "2.2.2",
    supports_custom_version: false,
    name: "Codex CLI",
    description: "",
    available: true,
    distribution_type: "npx",
    is_acp_adapter: true,
    custom_source: null,
    enabled: true,
    sort_order: 0,
    installed_version: "2.2.2",
    host_tools_agent_mode: false,
    env: {},
    config_json: null,
    config_file_path: null,
    opencode_auth_json: null,
    codex_auth_json: API_KEY_AUTH,
    cline_secrets_json: null,
    codex_config_toml: API_KEY_CONFIG,
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

async function openPanel(agent: AcpAgentInfo) {
  vi.mocked(acpListAgents).mockResolvedValue([agent])
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AcpAgentSettings />
    </NextIntlClientProvider>
  )
  await screen.findByText("config.toml (native)", { selector: "label" })
}

/** The raw config.toml editor, found through its label like a user would. */
function configTomlEditor(): HTMLTextAreaElement {
  const label = screen.getByText("config.toml (native)", { selector: "label" })
  return within(label.parentElement as HTMLElement).getByRole(
    "textbox"
  ) as HTMLTextAreaElement
}

const WEBSOCKET_SWITCH = { name: "Enable WebSocket for Codex Provider" }

describe("AcpAgentSettings — the Codex configuration card", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listModelProviders).mockResolvedValue([])
    vi.mocked(acpUpdateAgentEnv).mockResolvedValue(0)
    vi.mocked(acpUpdateAgentConfig).mockResolvedValue(0)
  })

  it("no longer offers the Fast or Skills switches", async () => {
    await openPanel(codexAgent())
    expect(
      screen.queryByRole("switch", { name: /Fast service tier/ })
    ).toBeNull()
    expect(
      screen.queryByRole("switch", { name: /Skills for Codex/ })
    ).toBeNull()
    expect(screen.queryByText("Enable Fast")).toBeNull()
    expect(screen.queryByText("Enable Skills")).toBeNull()
  })

  it("shows config.toml as it is on disk, without forcing disable_response_storage", async () => {
    const user = userEvent.setup()
    await openPanel(codexAgent())
    expect(configTomlEditor().value).toBe(API_KEY_CONFIG)

    await user.click(screen.getByRole("button", { name: "Save Codex Config" }))
    await waitFor(() => expect(acpUpdateAgentConfig).toHaveBeenCalledTimes(1))
    const [, saved] = vi.mocked(acpUpdateAgentConfig).mock.calls[0]
    expect(saved.codex_config_toml).toBe(API_KEY_CONFIG)
  })

  it("writes only supports_websockets from the WebSocket switch", async () => {
    const user = userEvent.setup()
    await openPanel(codexAgent())
    const ws = screen.getByRole("switch", WEBSOCKET_SWITCH)
    expect(ws).toHaveAttribute("aria-checked", "false")

    await user.click(ws)
    expect(screen.getByRole("switch", WEBSOCKET_SWITCH)).toHaveAttribute(
      "aria-checked",
      "true"
    )
    // Exactly one key changed, on the active provider's own table.
    const original = parseTomlDocument(API_KEY_CONFIG) as {
      model_providers: { codeg: Record<string, unknown> }
    }
    expect(parseTomlDocument(configTomlEditor().value)).toEqual({
      ...original,
      model_providers: {
        codeg: { ...original.model_providers.codeg, supports_websockets: true },
      },
    })

    await user.click(screen.getByRole("switch", WEBSOCKET_SWITCH))
    expect(parseTomlDocument(configTomlEditor().value)).toEqual(original)
  })

  // codex keeps its built-in providers whatever config.toml says about them.
  it("hides the WebSocket switch when a built-in provider is active", async () => {
    await openPanel(
      codexAgent({
        codex_config_toml: 'model = "gpt-5.5"\nmodel_provider = "openai"\n',
      })
    )
    expect(screen.queryByRole("switch", WEBSOCKET_SWITCH)).toBeNull()
  })

  // The built-in OpenAI provider already uses WebSockets, and the switch's
  // write path used to pin `model_provider = "codeg"` with an empty base_url.
  it("hides the WebSocket switch for Official Subscription", async () => {
    await openPanel(
      codexAgent({
        codex_auth_json: SUBSCRIPTION_AUTH,
        codex_config_toml: 'model = "gpt-5.5"\n',
      })
    )
    expect(screen.queryByRole("switch", WEBSOCKET_SWITCH)).toBeNull()
  })
})
