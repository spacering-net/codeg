import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  acpListAgents,
  acpUpdateAgentConfig,
  listModelProviders,
} from "@/lib/api"
import type { AcpAgentInfo } from "@/lib/types"
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

function makeAgent(overrides: Partial<AcpAgentInfo> = {}): AcpAgentInfo {
  return {
    agent_type: "gemini",
    name: "Gemini",
    registry_id: "gemini",
    registry_version: "0.1.0",
    installed_version: "0.1.0",
    description: "Google Gemini CLI agent",
    skills_capable: true,
    supports_custom_version: false,
    available: true,
    distribution_type: "npm",
    is_acp_adapter: false,
    enabled: true,
    sort_order: 0,
    env: {},
    config_json: null,
    config_file_path: null,
    system_instructions_file_path: "C:/Users/test/.gemini/GEMINI.md",
    system_instructions_content: "# You are a helpful assistant",
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

describe("System Instructions in ACP agent settings", () => {
  it("renders system instructions with path and content, and allows saving", async () => {
    const agent = makeAgent()
    vi.mocked(acpListAgents).mockResolvedValue([agent])
    vi.mocked(listModelProviders).mockResolvedValue([])
    vi.mocked(acpUpdateAgentConfig).mockResolvedValue(0)

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AcpAgentSettings />
      </NextIntlClientProvider>
    )

    await screen.findByRole("heading", { name: "Gemini" })

    // Check system instructions section
    expect(screen.getByText("System Instructions")).toBeInTheDocument()
    expect(
      screen.getByText("C:/Users/test/.gemini/GEMINI.md")
    ).toBeInTheDocument()

    const instructionsInput = screen.getByPlaceholderText(
      enMessages.AcpAgentSettings.systemInstructions.placeholder
    )
    expect(instructionsInput).toHaveValue("# You are a helpful assistant")

    // Edit instructions
    fireEvent.change(instructionsInput, {
      target: { value: "# Updated guidelines\nAlways write tests." },
    })

    // Click save system instructions
    const saveButton = screen.getByRole("button", {
      name: enMessages.AcpAgentSettings.actions.saveSystemInstructions,
    })
    fireEvent.click(saveButton)

    await waitFor(() => expect(acpUpdateAgentConfig).toHaveBeenCalledTimes(1))
    expect(acpUpdateAgentConfig).toHaveBeenCalledWith("gemini", {
      system_instructions_content: "# Updated guidelines\nAlways write tests.",
    })
  })

  it("does not render system instructions section when path is null", async () => {
    const agent = makeAgent({
      system_instructions_file_path: null,
      system_instructions_content: null,
    })
    vi.mocked(acpListAgents).mockResolvedValue([agent])
    vi.mocked(listModelProviders).mockResolvedValue([])

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AcpAgentSettings />
      </NextIntlClientProvider>
    )

    await screen.findByRole("heading", { name: "Gemini" })
    expect(screen.queryByText("System Instructions")).not.toBeInTheDocument()
  })
})
