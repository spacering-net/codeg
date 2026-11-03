import { fireEvent, render, screen, waitFor } from "@testing-library/react"
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
import {
  AcpAgentSettings,
  rebaseSystemInstructionsDraft,
} from "./acp-agent-settings"

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

// Claude Code's panel is the one whose shared save also carries the
// instructions; the other panels save them with the card's own button.
function claudeAgent(): AcpAgentInfo {
  return makeAgent({
    agent_type: "claude_code",
    name: "Claude Code",
    registry_id: "claude-acp",
    system_instructions_file_path: "/home/test/.claude/CLAUDE.md",
    system_instructions_content: "# Be brief",
  })
}

function renderSettings() {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AcpAgentSettings />
    </NextIntlClientProvider>
  )
}

describe("System Instructions in ACP agent settings", () => {
  beforeEach(() => {
    vi.mocked(acpUpdateAgentConfig).mockReset()
  })

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
      // Bound to the file the editor showed, not a fresh resolution.
      system_instructions_file_path: "C:/Users/test/.gemini/GEMINI.md",
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

  it("the shared config save leaves untouched instructions alone", async () => {
    vi.mocked(acpListAgents).mockResolvedValue([claudeAgent()])
    vi.mocked(listModelProviders).mockResolvedValue([])
    vi.mocked(acpUpdateAgentEnv).mockResolvedValue(0)
    vi.mocked(acpUpdateAgentConfig).mockResolvedValue(0)

    renderSettings()
    await screen.findByRole("heading", { name: "Claude Code" })

    fireEvent.click(
      screen.getByRole("button", {
        name: enMessages.AcpAgentSettings.actions.saveConfigManagement,
      })
    )

    await waitFor(() => expect(acpUpdateAgentConfig).toHaveBeenCalledTimes(1))
    expect(vi.mocked(acpUpdateAgentConfig).mock.calls[0][1]).toMatchObject({
      system_instructions_content: null,
    })
  })

  it("the shared config save sends edited instructions once", async () => {
    vi.mocked(acpListAgents).mockResolvedValue([claudeAgent()])
    vi.mocked(listModelProviders).mockResolvedValue([])
    vi.mocked(acpUpdateAgentEnv).mockResolvedValue(0)
    vi.mocked(acpUpdateAgentConfig).mockResolvedValue(0)

    renderSettings()
    await screen.findByRole("heading", { name: "Claude Code" })

    fireEvent.change(
      screen.getByPlaceholderText(
        enMessages.AcpAgentSettings.systemInstructions.placeholder
      ),
      { target: { value: "# Edited" } }
    )
    const save = screen.getByRole("button", {
      name: enMessages.AcpAgentSettings.actions.saveConfigManagement,
    })
    fireEvent.click(save)

    await waitFor(() => expect(acpUpdateAgentConfig).toHaveBeenCalledTimes(1))
    expect(vi.mocked(acpUpdateAgentConfig).mock.calls[0][1]).toMatchObject({
      system_instructions_content: "# Edited",
      system_instructions_file_path: "/home/test/.claude/CLAUDE.md",
    })

    // Saved: the next shared save no longer carries it.
    await waitFor(() => expect(save).toBeEnabled())
    fireEvent.click(save)
    await waitFor(() => expect(acpUpdateAgentConfig).toHaveBeenCalledTimes(2))
    expect(vi.mocked(acpUpdateAgentConfig).mock.calls[1][1]).toMatchObject({
      system_instructions_content: null,
    })
  })
})

describe("rebaseSystemInstructionsDraft", () => {
  type Draft = Parameters<typeof rebaseSystemInstructionsDraft>[0]
  const draft = (text: string, baseline: string) =>
    ({
      systemInstructionsText: text,
      systemInstructionsBaseline: baseline,
    }) as Draft

  it("follows the file while the editor is untouched", () => {
    const next = rebaseSystemInstructionsDraft(
      draft("old", "old"),
      makeAgent({ system_instructions_content: "new" })
    )
    expect(next.systemInstructionsText).toBe("new")
    expect(next.systemInstructionsBaseline).toBe("new")
  })

  it("keeps an unsaved edit, and returns the same draft when nothing moved", () => {
    const edited = draft("typed", "old")
    expect(
      rebaseSystemInstructionsDraft(
        edited,
        makeAgent({ system_instructions_content: "new" })
      )
    ).toBe(edited)
    const clean = draft("same", "same")
    expect(
      rebaseSystemInstructionsDraft(
        clean,
        makeAgent({ system_instructions_content: "same" })
      )
    ).toBe(clean)
  })
})
