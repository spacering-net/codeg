/**
 * The Codex card's saves now leave the keys codeg manages to the backend:
 * - an edit of the model list does not patch `model_catalog_json` or root
 *   `model` into config.toml, and the save carries the text the draft was
 *   loaded from, so a hand edit of either can be told apart;
 * - switching to the subscription drops the provider source from the list
 *   and leaves the provider table for the backend to prune;
 * - a save refused for a catalog reason says so in the user's language.
 */
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"

import enMessages from "@/i18n/messages/en.json"
import {
  acpListAgents,
  acpUpdateAgentConfig,
  acpUpdateAgentEnv,
  codexBundledCatalog,
  listModelProviders,
} from "@/lib/api"
import type { AcpAgentInfo, CodexModelInfo } from "@/lib/types"

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
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}))

const API_KEY_AUTH = JSON.stringify({ OPENAI_API_KEY: "sk-test" })

const CONFIG = [
  "# mine",
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

const OFFICIALS: CodexModelInfo[] = [
  { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
  { slug: "gpt-5.5-mini", display_name: "GPT-5.5 mini", visibility: "list" },
]

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
    codex_auth_json: API_KEY_AUTH,
    cline_secrets_json: null,
    codex_config_toml: CONFIG,
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

async function save(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Save Codex Config" }))
  await waitFor(() => expect(acpUpdateAgentConfig).toHaveBeenCalledTimes(1))
  return vi.mocked(acpUpdateAgentConfig).mock.calls[0][1]
}

describe("AcpAgentSettings — Codex saves and the keys codeg manages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listModelProviders).mockResolvedValue([])
    vi.mocked(acpUpdateAgentEnv).mockResolvedValue(0)
    vi.mocked(acpUpdateAgentConfig).mockResolvedValue(0)
    vi.mocked(codexBundledCatalog).mockResolvedValue(OFFICIALS)
  })

  it("leaves model_catalog_json and root model to the backend once the list is customized", async () => {
    const user = userEvent.setup()
    await openPanel(codexAgent())
    const row = (await screen.findByText("GPT-5.5 mini")).closest(
      "[data-model-row]"
    ) as HTMLElement
    await user.click(within(row).getByRole("button", { name: "Remove" }))

    const saved = await save(user)
    expect(saved.codex_config_toml).toBe(CONFIG)
    expect(saved.codex_config_toml_baseline).toBe(CONFIG)
    expect(JSON.parse(saved.codex_model_catalog ?? "")).toEqual({
      customs: [],
      excludedOfficials: ["gpt-5.5-mini"],
    })
  })

  it("keeps the star as root model while codex's own list is in use", async () => {
    const user = userEvent.setup()
    await openPanel(codexAgent())
    const row = (await screen.findByText("GPT-5.5 mini")).closest(
      "[data-model-row]"
    ) as HTMLElement
    await user.click(
      within(row).getByRole("button", { name: "Set as default" })
    )

    const saved = await save(user)
    expect(saved.codex_config_toml?.trimEnd()).toBe(
      CONFIG.replace('model = "gpt-5.5"', 'model = "gpt-5.5-mini"').trimEnd()
    )
    expect(saved.codex_config_toml_baseline).toBe(CONFIG)
  })

  it("does not count a star placed before the list was customized as a hand edit", async () => {
    const user = userEvent.setup()
    await openPanel(codexAgent())
    const mini = (await screen.findByText("GPT-5.5 mini")).closest(
      "[data-model-row]"
    ) as HTMLElement
    await user.click(
      within(mini).getByRole("button", { name: "Set as default" })
    )
    // Now customized: root `model` is the backend's again.
    await user.click(within(mini).getByRole("button", { name: "Remove" }))

    const saved = await save(user)
    expect(saved.codex_config_toml).toContain('model = "gpt-5.5"')
    expect(saved.codex_config_toml).not.toContain("gpt-5.5-mini")
    expect(saved.codex_config_toml_baseline).toBe(CONFIG)
  })

  it("keeps an edit made while the save was in flight", async () => {
    const user = userEvent.setup()
    let finish: (n: number) => void = () => {}
    vi.mocked(acpUpdateAgentConfig).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    await openPanel(codexAgent())
    await user.click(screen.getByRole("button", { name: "Save Codex Config" }))
    await waitFor(() => expect(acpUpdateAgentConfig).toHaveBeenCalledTimes(1))

    const label = screen.getByText("config.toml (native)", {
      selector: "label",
    })
    const editor = within(label.parentElement as HTMLElement).getByRole(
      "textbox"
    ) as HTMLTextAreaElement
    await user.type(editor, "# typed meanwhile")
    finish(0)
    // The save's reseed reads the agent list again; the typed text stays.
    await waitFor(() => expect(acpListAgents).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(editor.value).toContain("# typed meanwhile")
  })

  it("drops the provider source when switching to the subscription", async () => {
    const user = userEvent.setup()
    await openPanel(
      codexAgent({
        codex_model_catalog: '{"customs":[],"catalog":{"format":"native"}}',
      })
    )
    const label = screen.getByText("Auth Mode", { selector: "label" })
    await user.click(
      within(label.parentElement as HTMLElement).getByRole("combobox")
    )
    const list = await screen.findByRole("listbox")
    await user.click(
      within(list).getByRole("option", { name: "Official Subscription" })
    )

    const saved = await save(user)
    // `model_provider` goes; the table stays for the backend to judge.
    expect(saved.codex_config_toml).not.toContain('model_provider = "codeg"')
    expect(saved.codex_config_toml).toContain("[model_providers.codeg]")
    expect(saved.codex_model_catalog ?? "").toBe("")
  })

  it("says why a save was refused, in the user's language", async () => {
    const user = userEvent.setup()
    vi.mocked(acpUpdateAgentConfig).mockRejectedValue(
      new Error(
        'no model is left\n[codexCatalog] {"code":"no_usable_models","params":{}}'
      )
    )
    await openPanel(codexAgent())
    await user.click(screen.getByRole("button", { name: "Save Codex Config" }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Failed to save Codex native config",
        {
          description:
            "No usable models: every entry is hidden or only for ChatGPT sign-in. Keep at least one.",
        }
      )
    )
  })
})
