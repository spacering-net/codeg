/**
 * Claude Code's cache mode: two switches backed by the top-level
 * `promptCacheTtl` / `subagentPromptCacheTtl` keys of ~/.claude/settings.json.
 * A switch is on only while its key reads "1h"; on writes "1h", off removes
 * the key (absent = no one-hour cache). The switches follow the native JSON
 * editor both ways.
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
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
} from "@/lib/api"
import type { AcpAgentInfo } from "@/lib/types"

import {
  AcpAgentSettings,
  claudePromptCacheOneHourEnabled,
  setClaudePromptCacheTtlInConfigText,
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
vi.mock("next/navigation", () => {
  const params = new URLSearchParams()
  return { useSearchParams: () => params }
})

const MAIN = "1-hour cache for the main agent"
const SUB = "1-hour cache for subagents"

function claudeAgent(configJson: string | null): AcpAgentInfo {
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
    config_json: configJson,
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

function nativeConfig(): HTMLTextAreaElement {
  const labelEl = screen.getByText("Native JSON Config", { selector: "label" })
  return within(labelEl.parentElement as HTMLElement).getByRole(
    "textbox"
  ) as HTMLTextAreaElement
}

function nativeConfigJson(): Record<string, unknown> {
  return JSON.parse(nativeConfig().value || "{}") as Record<string, unknown>
}

async function openPanel(configJson: string | null) {
  vi.mocked(acpListAgents).mockResolvedValue([claudeAgent(configJson)])
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AcpAgentSettings />
    </NextIntlClientProvider>
  )
  await screen.findByText("Native JSON Config", { selector: "label" })
}

async function savedConfigPatch(
  user: ReturnType<typeof userEvent.setup>
): Promise<Record<string, unknown>> {
  await user.click(
    screen.getByRole("button", { name: "Save Config Management" })
  )
  await waitFor(() => expect(acpUpdateAgentConfig).toHaveBeenCalled())
  const [, payload] = vi.mocked(acpUpdateAgentConfig).mock.calls[0]
  return JSON.parse(payload.config_json ?? "{}") as Record<string, unknown>
}

describe("Claude prompt cache helpers", () => {
  it("reads on only for a literal 1h", () => {
    expect(claudePromptCacheOneHourEnabled("", "promptCacheTtl")).toBe(false)
    expect(
      claudePromptCacheOneHourEnabled(
        '{"promptCacheTtl":"1h"}',
        "promptCacheTtl"
      )
    ).toBe(true)
    expect(
      claudePromptCacheOneHourEnabled(
        '{"promptCacheTtl":"1h"}',
        "subagentPromptCacheTtl"
      )
    ).toBe(false)
    expect(
      claudePromptCacheOneHourEnabled(
        '{"subagentPromptCacheTtl":"5m"}',
        "subagentPromptCacheTtl"
      )
    ).toBe(false)
    expect(
      claudePromptCacheOneHourEnabled('{"promptCacheTtl":', "promptCacheTtl")
    ).toBe(false)
  })

  it("writes 1h or removes the key and keeps everything else", () => {
    const base = '{"model":"opus","env":{"A":"1"},"promptCacheTtl":"5m"}'
    const on = setClaudePromptCacheTtlInConfigText(base, "promptCacheTtl", true)
    expect(JSON.parse(on ?? "")).toEqual({
      model: "opus",
      env: { A: "1" },
      promptCacheTtl: "1h",
    })
    const off = setClaudePromptCacheTtlInConfigText(
      on ?? "",
      "promptCacheTtl",
      false
    )
    expect(JSON.parse(off ?? "")).toEqual({ model: "opus", env: { A: "1" } })
    expect(
      JSON.parse(
        setClaudePromptCacheTtlInConfigText(
          "",
          "subagentPromptCacheTtl",
          true
        ) ?? ""
      )
    ).toEqual({ subagentPromptCacheTtl: "1h" })
  })

  it("refuses invalid JSON instead of rebuilding it from scratch", () => {
    expect(
      setClaudePromptCacheTtlInConfigText("{oops", "promptCacheTtl", true)
    ).toBeNull()
  })
})

describe("AcpAgentSettings — Claude cache mode", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listModelProviders).mockResolvedValue([])
    vi.mocked(acpUpdateAgentEnv).mockResolvedValue(0)
    vi.mocked(acpUpdateAgentConfig).mockResolvedValue(0)
    vi.mocked(acpUpdateClaudeModelPicker).mockResolvedValue(0)
  })

  it("is off without the keys, and turning both on writes 1h to the file", async () => {
    const user = userEvent.setup()
    await openPanel(JSON.stringify({ model: "sonnet" }))
    const main = screen.getByRole("switch", { name: MAIN })
    const sub = screen.getByRole("switch", { name: SUB })
    expect(main).not.toBeChecked()
    expect(sub).not.toBeChecked()

    await user.click(main)
    expect(main).toBeChecked()
    expect(sub).not.toBeChecked()
    expect(nativeConfigJson()).toMatchObject({ promptCacheTtl: "1h" })
    expect(nativeConfigJson()).not.toHaveProperty("subagentPromptCacheTtl")

    await user.click(sub)
    expect(sub).toBeChecked()
    const patch = await savedConfigPatch(user)
    expect(patch).toMatchObject({
      model: "sonnet",
      promptCacheTtl: "1h",
      subagentPromptCacheTtl: "1h",
    })
  })

  it("shows the file's 1h keys as on, and off removes them on save", async () => {
    const user = userEvent.setup()
    await openPanel(
      JSON.stringify({
        model: "sonnet",
        promptCacheTtl: "1h",
        subagentPromptCacheTtl: "1h",
      })
    )
    const main = screen.getByRole("switch", { name: MAIN })
    const sub = screen.getByRole("switch", { name: SUB })
    expect(main).toBeChecked()
    expect(sub).toBeChecked()

    await user.click(main)
    await user.click(sub)
    expect(nativeConfigJson()).toEqual({ model: "sonnet" })
    const patch = await savedConfigPatch(user)
    // `null` is the merge patch's "delete this key from disk".
    expect(patch.promptCacheTtl).toBeNull()
    expect(patch.subagentPromptCacheTtl).toBeNull()
    expect(patch.model).toBe("sonnet")
  })

  it("follows edits in the native JSON editor and locks while it is invalid", async () => {
    await openPanel(JSON.stringify({ promptCacheTtl: "5m" }))
    const main = screen.getByRole("switch", { name: MAIN })
    const sub = screen.getByRole("switch", { name: SUB })
    expect(main).not.toBeChecked()

    fireEvent.change(nativeConfig(), {
      target: { value: '{"subagentPromptCacheTtl": "1h"}' },
    })
    expect(main).not.toBeChecked()
    expect(sub).toBeChecked()

    fireEvent.change(nativeConfig(), {
      target: { value: '{"subagentPromptCacheTtl": "1h"' },
    })
    expect(main).toBeDisabled()
    expect(sub).toBeDisabled()
    expect(sub).not.toBeChecked()
  })
})
