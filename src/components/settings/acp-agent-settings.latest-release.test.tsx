/**
 * Version Status offers an agent's unreviewed latest release, looked up once
 * each time the agent is opened. These drive the real panel: when the lookup
 * runs (and when it must not run again), which answer may surface, where the
 * offer sits, and what confirming it installs.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { toast } from "sonner"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  acpClearBinaryCache,
  acpDetectAgentLocalVersion,
  acpDownloadAgentBinary,
  acpFetchAgentLatestRelease,
  acpGetAgentStatus,
  acpListAgents,
  acpPreflight,
  acpPrepareNpxAgent,
  listModelProviders,
} from "@/lib/api"
import type { AcpAgentInfo, AgentLatestRelease, AgentType } from "@/lib/types"

import { AcpAgentSettings } from "./acp-agent-settings"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  // Every function is stubbed so nothing here can reach the real transport;
  // the calls the panel makes that a test does not set up never settle.
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
// An install subscribes to its log stream before it starts.
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  subscribe: vi.fn(async () => () => {}),
}))
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

function agent(overrides: Partial<AcpAgentInfo>): AcpAgentInfo {
  return {
    agent_type: "gemini",
    skills_capable: true,
    registry_id: "gemini",
    registry_version: "0.60.0",
    supports_custom_version: true,
    name: "Gemini CLI",
    description: "",
    available: true,
    distribution_type: "npx",
    is_acp_adapter: false,
    custom_source: null,
    enabled: true,
    sort_order: 0,
    installed_version: "0.60.0",
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

const GEMINI = agent({})
const GROK = agent({
  agent_type: "grok",
  registry_id: "grok-build",
  registry_version: "1.0.41",
  name: "Grok",
  sort_order: 1,
  installed_version: "1.0.41",
})
const OPENCODE = agent({
  agent_type: "open_code",
  registry_id: "opencode",
  registry_version: "1.18.33",
  name: "OpenCode",
  distribution_type: "binary",
  installed_version: "1.18.33",
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const OFFER = /^Upgrade to unreviewed latest /

function lookups(): AgentType[] {
  return vi
    .mocked(acpFetchAgentLatestRelease)
    .mock.calls.map(([agentType]) => agentType)
}

function openAgent(agentType: AgentType) {
  const row = document.querySelector<HTMLElement>(
    `[data-agent-type="${agentType}"]`
  )
  if (!row) throw new Error(`no list row for ${agentType}`)
  return userEvent.setup().click(row)
}

async function renderPanel(agents: AcpAgentInfo[]) {
  vi.mocked(acpListAgents).mockResolvedValue(agents)
  vi.mocked(listModelProviders).mockResolvedValue([])
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AcpAgentSettings />
    </NextIntlClientProvider>
  )
  await screen.findByText("Version Status")
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("AcpAgentSettings — unreviewed latest release", () => {
  it("asks once per visit, and again only when the agent is opened anew", async () => {
    vi.mocked(acpFetchAgentLatestRelease).mockResolvedValue(null)
    await renderPanel([GEMINI, GROK])
    await waitFor(() => expect(lookups()).toEqual(["gemini"]))

    await openAgent("grok")
    await waitFor(() => expect(lookups()).toEqual(["gemini", "grok"]))
    await openAgent("gemini")
    await waitFor(() => expect(lookups()).toEqual(["gemini", "grok", "gemini"]))
  })

  it("does not ask again when the open agent's details change", async () => {
    vi.mocked(acpFetchAgentLatestRelease).mockResolvedValue(null)
    // The preflight round settles and reports a newly detected version, which
    // replaces the agent in the list.
    vi.mocked(acpPreflight).mockImplementation(async (agentType) => ({
      agent_type: agentType,
      agent_name: "",
      passed: true,
      checks: [],
      adapter: null,
    }))
    vi.mocked(acpDetectAgentLocalVersion).mockResolvedValue("0.60.1")
    vi.mocked(acpGetAgentStatus).mockImplementation(async (agentType) => ({
      agent_type: agentType,
      available: true,
      enabled: true,
      installed_version: "0.60.1",
      is_acp_adapter: false,
    }))
    await renderPanel([GEMINI])

    const user = userEvent.setup()
    await user.click(screen.getByText("Version Status"))
    await screen.findByText(/Local: 0\.60\.1/)
    expect(lookups()).toEqual(["gemini"])
  })

  it("keeps an answer to the visit that asked for it", async () => {
    const firstVisit = deferred<AgentLatestRelease | null>()
    const secondVisit = deferred<AgentLatestRelease | null>()
    vi.mocked(acpFetchAgentLatestRelease)
      .mockImplementationOnce(() => firstVisit.promise)
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(() => secondVisit.promise)
    await renderPanel([GEMINI, GROK])
    await waitFor(() => expect(lookups()).toEqual(["gemini"]))

    // Leave before the answer arrives, then come back.
    await openAgent("grok")
    await openAgent("gemini")
    await waitFor(() => expect(lookups()).toEqual(["gemini", "grok", "gemini"]))

    // The first visit's answer lands during the second visit: not its answer.
    await act(async () => {
      firstVisit.resolve({ version: "0.61.0" })
    })
    await act(async () => {
      secondVisit.resolve(null)
    })
    expect(screen.queryByRole("button", { name: OFFER })).toBeNull()
  })

  it("offers nothing, and says nothing, when the lookup fails", async () => {
    vi.mocked(acpFetchAgentLatestRelease).mockRejectedValue(
      new Error("offline")
    )
    await renderPanel([agent({ installed_version: null })])
    await waitFor(() => expect(console.warn).toHaveBeenCalled())

    // Not installed, so the card is open: the offer would be showing.
    expect(screen.getByRole("button", { name: "Custom install" })).toBeVisible()
    expect(screen.queryByRole("button", { name: OFFER })).toBeNull()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("holds the start of a row it shares only with Custom install", async () => {
    vi.mocked(acpFetchAgentLatestRelease).mockResolvedValue({
      version: "0.61.0",
    })
    await renderPanel([GEMINI])

    const offer = await screen.findByRole("button", {
      name: "Upgrade to unreviewed latest 0.61.0",
    })
    const customInstall = screen.getByRole("button", {
      name: "Custom install",
    })
    expect(offer.nextElementSibling).toBe(customInstall)
    expect(offer.parentElement?.children).toHaveLength(2)
    expect(offer.parentElement).toHaveClass("flex-nowrap", "justify-end")
    // Its auto end margin keeps Custom install at the far end.
    expect(offer).toHaveClass("me-auto")
    // The Uninstall action keeps its place in the row above.
    expect(
      screen.getByRole("button", { name: "Uninstall" }).parentElement
    ).not.toBe(offer.parentElement)
    expect(
      screen.getByText(/A newer, unreviewed release is available/)
    ).toBeVisible()
  })

  it("is offered to an agent that is not installed yet", async () => {
    vi.mocked(acpFetchAgentLatestRelease).mockResolvedValue({
      version: "0.61.0",
    })
    await renderPanel([agent({ installed_version: null })])

    const offer = await screen.findByRole("button", {
      name: "Upgrade to unreviewed latest 0.61.0",
    })
    expect(offer.nextElementSibling).toBe(
      screen.getByRole("button", { name: "Custom install" })
    )
    expect(screen.getByRole("button", { name: "Install" })).toBeVisible()
  })

  it("unfolds a passing card for the offer", async () => {
    const lookup = deferred<AgentLatestRelease | null>()
    vi.mocked(acpFetchAgentLatestRelease).mockReturnValue(lookup.promise)
    await renderPanel([GEMINI])
    // A pass starts folded.
    expect(screen.queryByRole("button", { name: "Custom install" })).toBeNull()

    await act(async () => {
      lookup.resolve({ version: "0.61.0" })
    })
    expect(
      await screen.findByRole("button", {
        name: "Upgrade to unreviewed latest 0.61.0",
      })
    ).toBeVisible()
  })

  it("leaves a card the user folded by hand", async () => {
    const lookup = deferred<AgentLatestRelease | null>()
    vi.mocked(acpFetchAgentLatestRelease).mockReturnValue(lookup.promise)
    await renderPanel([GEMINI])

    const user = userEvent.setup()
    await user.click(screen.getByText("Version Status"))
    await user.click(screen.getByText("Version Status"))
    await act(async () => {
      lookup.resolve({ version: "0.61.0" })
    })
    expect(screen.queryByRole("button", { name: OFFER })).toBeNull()

    // Unfolding it shows the offer that arrived meanwhile.
    await user.click(screen.getByText("Version Status"))
    expect(
      screen.getByRole("button", {
        name: "Upgrade to unreviewed latest 0.61.0",
      })
    ).toBeVisible()
  })

  it("confirms first, then installs the offered version the way Custom install does", async () => {
    vi.mocked(acpFetchAgentLatestRelease).mockResolvedValue({
      version: "0.61.0",
    })
    await renderPanel([GEMINI])

    const user = userEvent.setup()
    await user.click(
      await screen.findByRole("button", {
        name: "Upgrade to unreviewed latest 0.61.0",
      })
    )
    const dialog = await screen.findByRole("alertdialog")
    expect(
      within(dialog).getByText("Upgrade Gemini CLI to unreviewed 0.61.0?")
    ).toBeVisible()
    expect(
      within(dialog).getByText(/reinstall the recommended version 0\.60\.0\./)
    ).toBeVisible()
    expect(acpPrepareNpxAgent).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole("button", { name: "Upgrade" }))
    await waitFor(() =>
      expect(acpPrepareNpxAgent).toHaveBeenCalledWith(
        "gemini",
        "0.60.0",
        expect.any(String),
        true,
        "0.61.0"
      )
    )
  })

  it("downloads the offered version of a binary agent into a cleared cache", async () => {
    vi.mocked(acpFetchAgentLatestRelease).mockResolvedValue({
      version: "1.19.0",
    })
    vi.mocked(acpClearBinaryCache).mockResolvedValue(undefined)
    await renderPanel([OPENCODE])

    const user = userEvent.setup()
    await user.click(
      await screen.findByRole("button", {
        name: "Upgrade to unreviewed latest 1.19.0",
      })
    )
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Upgrade" }))
    await waitFor(() =>
      expect(acpDownloadAgentBinary).toHaveBeenCalledWith(
        "open_code",
        expect.any(String),
        "1.19.0"
      )
    )
    expect(acpClearBinaryCache).toHaveBeenCalledWith("open_code")
  })

  it("installs nothing when the confirmation is cancelled", async () => {
    vi.mocked(acpFetchAgentLatestRelease).mockResolvedValue({
      version: "0.61.0",
    })
    await renderPanel([GEMINI])

    const user = userEvent.setup()
    await user.click(
      await screen.findByRole("button", {
        name: "Upgrade to unreviewed latest 0.61.0",
      })
    )
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(acpPrepareNpxAgent).not.toHaveBeenCalled()
  })

  it("never asks for an agent Custom install could not follow", async () => {
    vi.mocked(acpFetchAgentLatestRelease).mockResolvedValue({
      version: "9.9.9",
    })
    await renderPanel([
      agent({
        agent_type: "custom:goose",
        registry_id: "goose",
        name: "Goose",
        custom_source: "manual",
      }),
      agent({
        agent_type: "custom:fast-agent",
        registry_id: "fast-agent",
        name: "Fast Agent",
        sort_order: 1,
        distribution_type: "uvx",
        supports_custom_version: false,
      }),
    ])
    await screen.findByRole("switch", { name: "Goose enable switch" })
    await openAgent("custom:fast-agent")
    await screen.findByRole("switch", { name: "Fast Agent enable switch" })
    expect(acpFetchAgentLatestRelease).not.toHaveBeenCalled()
  })
})
