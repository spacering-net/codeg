/**
 * The Grok custom-model card's reasoning-effort levels, driven through the real
 * panel (#993): a custom endpoint whose model Grok's own catalog doesn't
 * describe gets an effort selector only from `[model.<id>].reasoning_efforts`,
 * so the card must be able to declare those levels and send them on save.
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
  return screen.findByRole("group", { name: "Reasoning effort levels" })
}

function chipStates(group: HTMLElement): Record<string, string | null> {
  return Object.fromEntries(
    within(group)
      .getAllByRole("button")
      .map((chip) => [chip.textContent, chip.getAttribute("aria-pressed")])
  )
}

async function savedGrokStructured() {
  await waitFor(() => expect(acpUpdateAgentConfig).toHaveBeenCalledTimes(1))
  const [agentType, saved] = vi.mocked(acpUpdateAgentConfig).mock.calls[0]
  expect(agentType).toBe("grok")
  return saved.grok_structured
}

describe("AcpAgentSettings — Grok custom model reasoning-effort levels", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listModelProviders).mockResolvedValue([])
    vi.mocked(acpUpdateAgentEnv).mockResolvedValue(0)
    vi.mocked(acpUpdateAgentConfig).mockResolvedValue(0)
  })

  it("declares the chosen levels for the custom model on save", async () => {
    const user = userEvent.setup()
    const group = await openPanel(grokAgent())
    expect(chipStates(group)).toEqual({
      minimal: "false",
      low: "false",
      medium: "false",
      high: "false",
      xhigh: "false",
      max: "false",
    })
    // With nothing declared the card says why the composer has no selector.
    expect(screen.getByText(/^No levels declared\./)).toBeInTheDocument()

    for (const level of ["xhigh", "low", "high"]) {
      await user.click(within(group).getByRole("button", { name: level }))
    }
    expect(chipStates(group)).toMatchObject({
      low: "true",
      medium: "false",
      high: "true",
      xhigh: "true",
    })
    expect(screen.queryByText(/^No levels declared\./)).toBeNull()
    expect(
      screen.getByText(/reasoning_efforts`\. Each level is sent/)
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Save Grok Config" }))
    const saved = await savedGrokStructured()
    expect(saved?.customModelId).toBe("grok-4.7")
    // Chip order, not click order: the first level is where Grok starts a
    // session when no default reasoning effort is set.
    expect(saved?.customReasoningEfforts).toEqual(["low", "high", "xhigh"])
  })

  it("shows a hand-written level and leaves untouched levels alone on save", async () => {
    const user = userEvent.setup()
    const group = await openPanel(
      grokAgent({ custom_reasoning_efforts: ["none", "high"] })
    )
    expect(chipStates(group)).toMatchObject({
      high: "true",
      none: "true",
      low: "false",
    })

    // null = "leave it as it is", so an edit made in the raw config.toml
    // editor (the merge base) is not reverted by what the chips were read as.
    await user.click(screen.getByRole("button", { name: "Save Grok Config" }))
    const saved = await savedGrokStructured()
    expect(saved?.customModelId).toBe("grok-4.7")
    expect(saved?.customReasoningEfforts).toBeNull()
  })

  it("shows the saved levels after the save re-reads the config", async () => {
    const user = userEvent.setup()
    vi.mocked(acpUpdateAgentConfig).mockImplementation(async () => {
      // What the next read of disk returns once the levels are written.
      vi.mocked(acpListAgents).mockResolvedValue([
        grokAgent({ custom_reasoning_efforts: ["low", "high"] }),
      ])
      return 0
    })
    const group = await openPanel(grokAgent())
    await user.click(within(group).getByRole("button", { name: "high" }))
    await user.click(within(group).getByRole("button", { name: "low" }))
    await user.click(screen.getByRole("button", { name: "Save Grok Config" }))
    expect((await savedGrokStructured())?.customReasoningEfforts).toEqual([
      "low",
      "high",
    ])
    // Mount, then the save's re-read.
    await waitFor(() =>
      expect(vi.mocked(acpListAgents).mock.calls.length).toBeGreaterThanOrEqual(
        2
      )
    )

    // The re-read draft starts from what is on disk, so saving again without
    // touching the chips leaves the levels alone.
    const reread = await screen.findByRole("group", {
      name: "Reasoning effort levels",
    })
    expect(chipStates(reread)).toMatchObject({
      low: "true",
      high: "true",
      medium: "false",
    })
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save Grok Config" })
      ).toBeEnabled()
    )
    await user.click(screen.getByRole("button", { name: "Save Grok Config" }))
    await waitFor(() => expect(acpUpdateAgentConfig).toHaveBeenCalledTimes(2))
    expect(
      vi.mocked(acpUpdateAgentConfig).mock.calls[1][1].grok_structured
        ?.customReasoningEfforts
    ).toBeNull()
  })

  it("starts from the written levels even when the re-read after a save fails", async () => {
    const user = userEvent.setup()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    await openPanel(grokAgent())
    // Every read after mounting fails, the save's own re-read included.
    vi.mocked(acpListAgents).mockRejectedValue(new Error("offline"))
    const levels = () =>
      screen.getByRole("group", { name: "Reasoning effort levels" })
    const save = () =>
      user.click(screen.getByRole("button", { name: "Save Grok Config" }))

    await user.click(within(levels()).getByRole("button", { name: "high" }))
    await save()
    expect((await savedGrokStructured())?.customReasoningEfforts).toEqual([
      "high",
    ])
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save Grok Config" })
      ).toBeEnabled()
    )

    // Back to what the panel was first read as — but `high` is on disk now,
    // so this is still a change to send, not a null that would keep it.
    await user.click(within(levels()).getByRole("button", { name: "high" }))
    await save()
    await waitFor(() => expect(acpUpdateAgentConfig).toHaveBeenCalledTimes(2))
    expect(
      vi.mocked(acpUpdateAgentConfig).mock.calls[1][1].grok_structured
        ?.customReasoningEfforts
    ).toEqual([])
    consoleError.mockRestore()
  })

  it("turning every level off asks to remove the declaration", async () => {
    const user = userEvent.setup()
    const group = await openPanel(
      grokAgent({ custom_reasoning_efforts: ["high"] })
    )
    await user.click(within(group).getByRole("button", { name: "high" }))
    expect(screen.getByText(/^No levels declared\./)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Save Grok Config" }))
    expect((await savedGrokStructured())?.customReasoningEfforts).toEqual([])
  })
})
