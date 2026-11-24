import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { CodeBuddyConfigPanel } from "./codebuddy-config-panel"
import enMessages from "@/i18n/messages/en.json"
import type { AcpAgentInfo } from "@/lib/types"

/** A minimal CodeBuddy AcpAgentInfo whose only meaningful field is `env`. */
function makeAgent(env: Record<string, string>): AcpAgentInfo {
  return {
    agent_type: "code_buddy",
    skills_capable: true,
    registry_id: "codebuddy-code",
    registry_version: "2.109.3",
    supports_custom_version: false,
    name: "CodeBuddy",
    description: "",
    available: true,
    distribution_type: "npx",
    is_acp_adapter: false,
    custom_source: null,
    enabled: true,
    sort_order: 0,
    installed_version: null,
    host_tools_agent_mode: false,
    env,
    config_json: null,
    config_file_path: null,
    codex_auth_json: null,
    codex_config_toml: null,
    codex_model_catalog: null,
    codex_sandbox_settings: null,
    grok_config_toml: null,
    grok_settings: null,
    cline_secrets_json: null,
    hermes_config_yaml: null,
    cursor_cli_config_json: null,
    cursor_settings: null,
    model_provider_id: null,
    icon_url: null,
  }
}

function renderPanel(agent: AcpAgentInfo) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CodeBuddyConfigPanel agent={agent} saving={false} onSave={vi.fn()} />
    </NextIntlClientProvider>
  )
}

// Copy that only makes sense for the hosted CLI sign-in flow — it must NOT
// appear for a private (self-hosted) endpoint, where there is no Tencent-account
// CLI login.
const CLI_API_KEY_COPY = /sign in with the CodeBuddy CLI/i
const CLI_LOGIN_COPY = /sign in with your Tencent account/i

describe("CodeBuddyConfigPanel — self-hosted (private deployment)", () => {
  it("shows a labelled Deployment URL field and hides all CLI sign-in copy", () => {
    renderPanel(makeAgent({ CODEBUDDY_BASE_URL: "https://codebuddy.acme.com" }))

    // Label is associated with the input (accessible name resolves).
    const input = screen.getByLabelText(
      enMessages.AcpAgentSettings.codebuddy.baseUrlLabel
    )
    expect(input).toHaveValue("https://codebuddy.acme.com")

    // The private-deployment API-key hint is shown...
    expect(
      screen.getByText(/Use the key issued by your private deployment/i)
    ).toBeInTheDocument()
    // ...and neither CLI sign-in hint leaks through.
    expect(screen.queryByText(CLI_API_KEY_COPY)).not.toBeInTheDocument()
    expect(screen.queryByText(CLI_LOGIN_COPY)).not.toBeInTheDocument()
  })
})

describe("CodeBuddyConfigPanel — hosted builds", () => {
  it("keeps the CLI sign-in hints and shows no Deployment URL field", () => {
    renderPanel(makeAgent({}))

    expect(screen.getByText(CLI_API_KEY_COPY)).toBeInTheDocument()
    expect(screen.getByText(CLI_LOGIN_COPY)).toBeInTheDocument()
    expect(
      screen.queryByLabelText(
        enMessages.AcpAgentSettings.codebuddy.baseUrlLabel
      )
    ).not.toBeInTheDocument()
  })
})
