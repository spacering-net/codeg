import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  acpListAgents,
  acpListCustomAgents,
  listModelProviders,
} from "@/lib/api"
import {
  PLUGIN_PROVIDER_AGENT_PREFIX,
  isCustomAgentType,
  isPluginProviderAgentType,
  type AcpAgentInfo,
  type AgentType,
} from "@/lib/types"
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

const VALID_HEX = "0123456789abcdef".repeat(4)
const PLUGIN_AGENT_TYPE: AgentType = `${PLUGIN_PROVIDER_AGENT_PREFIX}${VALID_HEX}`

function makeAgent(
  overrides: Partial<AcpAgentInfo> & { agent_type: AgentType; name: string }
): AcpAgentInfo {
  return {
    registry_id: overrides.agent_type,
    registry_version: "1.0.0",
    installed_version: "1.0.0",
    description: "Test ACP agent",
    skills_capable: false,
    supports_custom_version: false,
    available: true,
    distribution_type: "binary",
    is_acp_adapter: false,
    enabled: true,
    sort_order: 0,
    env: {},
    config_json: null,
    config_file_path: null,
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
    ...overrides,
  }
}

describe("isPluginProviderAgentType", () => {
  it("matches only custom:@plugin- followed by exactly 64 lowercase hex characters", () => {
    expect(PLUGIN_PROVIDER_AGENT_PREFIX).toBe("custom:@plugin-")
    expect(isPluginProviderAgentType(PLUGIN_AGENT_TYPE)).toBe(true)
    expect(isCustomAgentType(PLUGIN_AGENT_TYPE)).toBe(true)

    // Length & character boundaries
    expect(
      isPluginProviderAgentType(
        `${PLUGIN_PROVIDER_AGENT_PREFIX}${VALID_HEX.slice(0, 63)}`
      )
    ).toBe(false)
    expect(
      isPluginProviderAgentType(`${PLUGIN_PROVIDER_AGENT_PREFIX}${VALID_HEX}a`)
    ).toBe(false)
    expect(
      isPluginProviderAgentType(
        `${PLUGIN_PROVIDER_AGENT_PREFIX}${VALID_HEX.toUpperCase()}`
      )
    ).toBe(false)
    expect(
      isPluginProviderAgentType(
        `${PLUGIN_PROVIDER_AGENT_PREFIX}${"g".repeat(64)}`
      )
    ).toBe(false)
    expect(isPluginProviderAgentType(PLUGIN_PROVIDER_AGENT_PREFIX)).toBe(false)

    // Non-plugin agent types
    expect(isPluginProviderAgentType(`@plugin-${VALID_HEX}`)).toBe(false)
    expect(isPluginProviderAgentType("custom:my-agent")).toBe(false)
    expect(isPluginProviderAgentType("claude_code")).toBe(false)
  })
})

describe("AcpAgentSettings plugin-provided ACP agents", () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("shows plugin badge + read-only notice and hides DB edit/remove/toggles while keeping DB custom agents editable", async () => {
    const pluginAgent = makeAgent({
      agent_type: PLUGIN_AGENT_TYPE,
      name: "Demo Plugin Agent",
      sort_order: 0,
    })
    const dbCustomAgent = makeAgent({
      agent_type: "custom:my-db-agent",
      name: "My DB Custom Agent",
      registry_id: "my-db-agent",
      sort_order: 1,
    })

    vi.mocked(acpListAgents).mockResolvedValue([pluginAgent, dbCustomAgent])
    vi.mocked(listModelProviders).mockResolvedValue([])
    vi.mocked(acpListCustomAgents).mockResolvedValue([])

    const user = userEvent.setup()
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AcpAgentSettings />
      </NextIntlClientProvider>
    )

    // Plugin agent is selected by default
    const pluginHeading = await screen.findByRole("heading", {
      name: "Demo Plugin Agent",
    })
    const detailHeader = pluginHeading.parentElement as HTMLElement
    expect(
      within(detailHeader).getByText(
        enMessages.AcpAgentSettings.pluginAgentBadge
      )
    ).toBeInTheDocument()
    expect(
      within(detailHeader).queryByText(
        enMessages.AcpAgentSettings.customAgentBadge
      )
    ).not.toBeInTheDocument()

    // Plugin badge also appears in the sidebar list row (2 total: list + detail header)
    expect(
      screen.getAllByText(enMessages.AcpAgentSettings.pluginAgentBadge)
    ).toHaveLength(2)

    // Read-only managed card shown
    expect(
      screen.getByText(enMessages.AcpAgentSettings.pluginAgentManagedTitle)
    ).toBeInTheDocument()
    expect(
      screen.getByText(enMessages.AcpAgentSettings.pluginAgentManagedHint)
    ).toBeInTheDocument()

    // DB-only Edit / Remove controls hidden, and no invalid acpListCustomAgents call
    expect(
      screen.queryByRole("button", {
        name: enMessages.AcpAgentSettings.customAgentEdit,
      })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", {
        name: enMessages.AcpAgentSettings.customAgentRemove,
      })
    ).not.toBeInTheDocument()
    expect(acpListCustomAgents).not.toHaveBeenCalled()

    // Switch to ordinary DB custom agent -> shows Custom badge + Edit / Remove controls
    await user.click(screen.getByText("My DB Custom Agent"))
    const dbHeading = await screen.findByRole("heading", {
      name: "My DB Custom Agent",
    })
    const dbDetailHeader = dbHeading.parentElement as HTMLElement
    expect(
      within(dbDetailHeader).getByText(
        enMessages.AcpAgentSettings.customAgentBadge
      )
    ).toBeInTheDocument()
    expect(
      within(dbDetailHeader).queryByText(
        enMessages.AcpAgentSettings.pluginAgentBadge
      )
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(enMessages.AcpAgentSettings.pluginAgentManagedTitle)
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", {
        name: enMessages.AcpAgentSettings.customAgentEdit,
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", {
        name: enMessages.AcpAgentSettings.customAgentRemove,
      })
    ).toBeInTheDocument()
  })
})
