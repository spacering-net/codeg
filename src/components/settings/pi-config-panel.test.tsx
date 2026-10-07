import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { PiModelCatalog } from "@/lib/api"
import { piRuntimeIsTooOld } from "@/lib/pi-config"
import type { AcpAgentInfo } from "@/lib/types"
import { PiConfigPanel } from "./pi-config-panel"

const api = vi.hoisted(() => ({
  loadPiConfig: vi.fn(),
  listPiModelCapabilities: vi.fn(),
  acpUpdatePiConfig: vi.fn(),
  acpValidatePiCommand: vi.fn(),
  acpPiListTrustEntries: vi.fn(),
  onSaveEnv: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  loadPiConfig: api.loadPiConfig,
  listPiModelCapabilities: api.listPiModelCapabilities,
  acpUpdatePiConfig: api.acpUpdatePiConfig,
  acpValidatePiCommand: api.acpValidatePiCommand,
  acpPiListTrustEntries: api.acpPiListTrustEntries,
  acpPiSetProjectTrust: vi.fn(),
  acpInstallPiBinary: vi.fn(),
  acpUninstallPiBinary: vi.fn(),
}))

const MODELS: PiModelCatalog["models"] = [
  {
    provider: "openai",
    id: "gpt-5.6-sol",
    reasoning: true,
    thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: "max" },
  },
  {
    provider: "openai",
    id: "gpt-4",
    reasoning: false,
    thinkingLevelMap: {},
  },
  {
    // pi's built-in shape for models that cannot switch thinking off.
    provider: "openai",
    id: "always-thinks",
    reasoning: true,
    thinkingLevelMap: { off: null },
  },
]

const ANSWERED: PiModelCatalog = { status: "ok", models: MODELS }

function config(model = "gpt-5.6-sol", thinking = "max") {
  return {
    defaultProvider: "openai",
    defaultModel: model,
    defaultThinkingLevel: thinking,
    authProviders: ["openai"],
    customProviders: [],
  }
}

function panel(env: Record<string, string> = {}) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PiConfigPanel
        agent={{ env, enabled: true } as unknown as AcpAgentInfo}
        saving={false}
        onSaveEnv={api.onSaveEnv}
        onSaved={async () => {}}
      />
    </NextIntlClientProvider>
  )
}

async function renderPanel(
  env: Record<string, string> = {},
  expectModel: string | null = "gpt-5.6-sol"
) {
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(panel(env))
  })
  if (expectModel !== null) {
    await waitFor(() =>
      expect(screen.getByPlaceholderText("claude-sonnet-5-5")).toHaveValue(
        expectModel
      )
    )
  }
  return view
}

function thinkingPicker() {
  return screen.getAllByRole("combobox").slice(-1)[0]
}

async function openThinkingPicker() {
  await userEvent.click(thinkingPicker())
}

function saveConfig() {
  return userEvent.click(screen.getByRole("button", { name: "Save Pi Config" }))
}

function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.loadPiConfig.mockResolvedValue(config())
  api.listPiModelCapabilities.mockResolvedValue(ANSWERED)
  api.acpUpdatePiConfig.mockResolvedValue(undefined)
  api.acpValidatePiCommand.mockResolvedValue({
    found: false,
    resolvedPath: null,
    version: null,
  })
  api.acpPiListTrustEntries.mockResolvedValue([])
  api.onSaveEnv.mockResolvedValue(undefined)
})

describe("Pi default thinking level", () => {
  it("offers every level, max included, before Pi has answered", async () => {
    api.listPiModelCapabilities.mockReturnValue(
      pending<PiModelCatalog>().promise
    )
    await renderPanel()
    await openThinkingPicker()
    for (const name of [
      "Off",
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Extra high",
      "Max",
    ]) {
      expect(screen.getByRole("option", { name })).toBeInTheDocument()
    }
    await userEvent.keyboard("{Escape}")
    await saveConfig()
    await waitFor(() =>
      expect(api.acpUpdatePiConfig).toHaveBeenCalledWith(
        expect.objectContaining({ thinkingLevel: "max" })
      )
    )
  })

  it("persists max and shows it again after reopening", async () => {
    let saved = config("gpt-5.6-sol", "high")
    api.loadPiConfig.mockImplementation(async () => saved)
    api.acpUpdatePiConfig.mockImplementation(
      async (update: { model: string; thinkingLevel?: string }) => {
        saved = config(update.model, update.thinkingLevel ?? "")
      }
    )
    const view = await renderPanel()
    expect(thinkingPicker()).toHaveTextContent("High")
    await openThinkingPicker()
    await userEvent.click(screen.getByRole("option", { name: "Max" }))
    await saveConfig()
    await waitFor(() =>
      expect(api.acpUpdatePiConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "openai",
          model: "gpt-5.6-sol",
          thinkingLevel: "max",
        })
      )
    )
    view.unmount()

    await renderPanel()
    expect(thinkingPicker()).toHaveTextContent("Max")
  })

  it("saves a level the selected model lacks, and says what Pi runs it at", async () => {
    // The reported dead end: a non-reasoning default model made every save —
    // even one that only adds an API key — fail until the GLOBAL level was
    // lowered for every other model too.
    api.loadPiConfig.mockResolvedValue(config("gpt-4", "high"))
    await renderPanel({}, "gpt-4")
    expect(
      await screen.findByText(
        "gpt-4 doesn't offer High, so Pi runs it at Off. Models that offer High still get it."
      )
    ).toBeInTheDocument()
    await userEvent.type(screen.getByPlaceholderText(/saved/), "new-api-key")
    await saveConfig()
    await waitFor(() =>
      expect(api.acpUpdatePiConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gpt-4",
          thinkingLevel: "high",
          apiKey: "new-api-key",
        })
      )
    )
  })

  it("names the higher level Pi moves to when a model cannot switch thinking off", async () => {
    api.loadPiConfig.mockResolvedValue(config("always-thinks", "off"))
    await renderPanel({}, "always-thinks")
    expect(
      await screen.findByText(
        "always-thinks doesn't offer Off, so Pi runs it at Minimal. Models that offer Off still get it."
      )
    ).toBeInTheDocument()
    await saveConfig()
    await waitFor(() =>
      expect(api.acpUpdatePiConfig).toHaveBeenCalledWith(
        expect.objectContaining({ thinkingLevel: "off" })
      )
    )
  })

  it("lists the levels Pi offers for a known model", async () => {
    await renderPanel()
    expect(
      await screen.findByText(
        "gpt-5.6-sol offers: Off · Low · Medium · High · Extra high · Max."
      )
    ).toBeInTheDocument()
  })

  it("follows the model being typed, whenever Pi's answer arrives", async () => {
    const answer = pending<PiModelCatalog>()
    api.listPiModelCapabilities.mockReturnValue(answer.promise)
    await renderPanel()
    fireEvent.change(screen.getByPlaceholderText("claude-sonnet-5-5"), {
      target: { value: "gpt-4" },
    })
    await act(async () => answer.resolve(ANSWERED))
    expect(
      await screen.findByText(
        "gpt-4 doesn't offer Max, so Pi runs it at Off. Models that offer Max still get it."
      )
    ).toBeInTheDocument()
  })

  it("says Pi doesn't list a model only when Pi actually answered", async () => {
    api.loadPiConfig.mockResolvedValue(config("gpt-9-unknown", "high"))
    await renderPanel({}, "gpt-9-unknown")
    expect(
      await screen.findByText(/Pi doesn't list this model for this provider/)
    ).toBeInTheDocument()
  })

  it("says the levels could not be checked when Pi gave no answer", async () => {
    api.listPiModelCapabilities.mockResolvedValue({
      status: "timed_out",
      models: [],
    })
    await renderPanel()
    expect(
      await screen.findByText(
        "Couldn't ask Pi which thinking levels this model offers."
      )
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/Pi doesn't list this model/)
    ).not.toBeInTheDocument()
    await saveConfig()
    await waitFor(() => expect(api.acpUpdatePiConfig).toHaveBeenCalled())
  })

  it("keeps the last answer on screen while re-asking after a save", async () => {
    await renderPanel()
    await screen.findByText(/gpt-5.6-sol offers:/)
    const reasked = pending<PiModelCatalog>()
    api.listPiModelCapabilities.mockReturnValue(reasked.promise)
    await saveConfig()
    await waitFor(() =>
      expect(api.listPiModelCapabilities).toHaveBeenCalledTimes(2)
    )
    expect(screen.getByText(/gpt-5.6-sol offers:/)).toBeInTheDocument()
    await act(async () => reasked.resolve(ANSWERED))
  })

  it("re-asks Pi after a saved key makes the provider's models visible", async () => {
    api.listPiModelCapabilities
      .mockResolvedValueOnce({ status: "ok", models: [] })
      .mockResolvedValueOnce(ANSWERED)
    await renderPanel()
    await screen.findByText(/Pi doesn't list this model/)
    await userEvent.type(screen.getByPlaceholderText(/saved/), "new-api-key")
    await saveConfig()
    expect(await screen.findByText(/gpt-5.6-sol offers:/)).toBeInTheDocument()
  })

  it("re-asks Pi when the default pi is rechecked", async () => {
    await renderPanel()
    await waitFor(() =>
      expect(api.listPiModelCapabilities).toHaveBeenCalledTimes(1)
    )
    await userEvent.click(screen.getByTitle("Recheck"))
    await waitFor(() =>
      expect(api.listPiModelCapabilities).toHaveBeenCalledTimes(2)
    )
  })

  it("never shows another runtime's answer", async () => {
    const oldRuntime = pending<PiModelCatalog>()
    api.listPiModelCapabilities
      .mockReturnValueOnce(oldRuntime.promise)
      .mockReturnValueOnce(pending<PiModelCatalog>().promise)
    const view = await renderPanel()
    view.rerender(panel({ PI_ACP_PI_COMMAND: "/tmp/other-pi" }))
    await waitFor(() =>
      expect(api.listPiModelCapabilities).toHaveBeenCalledTimes(2)
    )
    await act(async () => oldRuntime.resolve(ANSWERED))
    expect(screen.queryByText(/gpt-5.6-sol offers:/)).not.toBeInTheDocument()
  })

  it("still refuses a custom model's default level outside its own declaration", async () => {
    api.loadPiConfig.mockResolvedValue({
      defaultProvider: "my-proxy",
      defaultModel: "local-model",
      defaultThinkingLevel: "max",
      authProviders: [],
      customProviders: [
        {
          id: "my-proxy",
          baseUrl: "https://proxy.example/v1",
          api: "openai-completions",
          models: [
            {
              id: "local-model",
              reasoning: true,
              thinkingLevelMap: { minimal: null, xhigh: null, max: null },
            },
          ],
        },
      ],
    })
    await renderPanel({}, "local-model")
    expect(
      await screen.findByText(
        "This level isn't in the available list above — pi would clamp it."
      )
    ).toBeInTheDocument()
    await saveConfig()
    expect(api.acpUpdatePiConfig).not.toHaveBeenCalled()
  })
})

describe("Pi native config source", () => {
  it("reloads native config from the newly selected Pi agent directory", async () => {
    api.loadPiConfig
      .mockResolvedValueOnce(config("gpt-5.6-sol", "max"))
      .mockResolvedValueOnce(config("gpt-4", "off"))
    const view = await renderPanel()
    view.rerender(panel({ PI_CODING_AGENT_DIR: "/tmp/another-agent" }))
    await waitFor(() => expect(api.loadPiConfig).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getByPlaceholderText("claude-sonnet-5-5")).toHaveValue(
        "gpt-4"
      )
    )
  })

  it("keeps unsaved edits when a change leaves the agent directory alone", async () => {
    const view = await renderPanel()
    fireEvent.change(screen.getByPlaceholderText("claude-sonnet-5-5"), {
      target: { value: "gpt-5.6-sol-edited" },
    })
    view.rerender(
      panel({
        PI_ACP_PI_COMMAND: "/tmp/other-pi",
        PI_CODING_AGENT_SESSION_DIR: "/tmp/sessions",
      })
    )
    await waitFor(() =>
      expect(api.listPiModelCapabilities).toHaveBeenCalledTimes(2)
    )
    expect(api.loadPiConfig).toHaveBeenCalledTimes(1)
    expect(screen.getByPlaceholderText("claude-sonnet-5-5")).toHaveValue(
      "gpt-5.6-sol-edited"
    )
  })

  it("drops the previous directory's values when the new one cannot be read", async () => {
    api.loadPiConfig
      .mockResolvedValueOnce(config("gpt-5.6-sol", "max"))
      .mockRejectedValueOnce(new Error("database is locked"))
    const view = await renderPanel()
    view.rerender(panel({ PI_CODING_AGENT_DIR: "/tmp/another-agent" }))
    expect(
      await screen.findByText("Couldn't read Pi's settings: database is locked")
    ).toBeInTheDocument()
    expect(screen.getByPlaceholderText("claude-sonnet-5-5")).toHaveValue("")
    await saveConfig()
    expect(api.acpUpdatePiConfig).not.toHaveBeenCalled()
  })

  it("shows why Pi's settings could not be read", async () => {
    api.loadPiConfig.mockRejectedValue(
      new Error("Cannot read Pi agent settings from the Codeg database: boom")
    )
    await renderPanel({}, null)
    expect(
      await screen.findByText(
        "Couldn't read Pi's settings: Cannot read Pi agent settings from the Codeg database: boom"
      )
    ).toBeInTheDocument()
  })
})

describe("Pi runtime minimum", () => {
  it("warns when a saved custom runtime predates the minimum", async () => {
    api.acpValidatePiCommand.mockImplementation(async (command: string) =>
      command === "/tmp/old-pi"
        ? { found: true, resolvedPath: command, version: "0.80.9" }
        : { found: false, resolvedPath: null, version: null }
    )
    await renderPanel({ PI_ACP_PI_COMMAND: "/tmp/old-pi" })
    expect(api.acpValidatePiCommand).toHaveBeenCalledWith("/tmp/old-pi")
    expect(
      await screen.findByText(/Codeg needs Pi 0\.81\.0 or newer/)
    ).toBeInTheDocument()
  })

  it("flags only versions known to predate the minimum", () => {
    expect(piRuntimeIsTooOld("0.80.9")).toBe(true)
    expect(piRuntimeIsTooOld("pi 0.81.0")).toBe(false)
    expect(piRuntimeIsTooOld("0.87.1")).toBe(false)
    expect(piRuntimeIsTooOld("1.0.0")).toBe(false)
    // A prerelease counts as the release it leads up to.
    expect(piRuntimeIsTooOld("0.81.0-rc.1")).toBe(false)
    // What pi prints without a package version (a source build): unknown.
    expect(piRuntimeIsTooOld("0.0.0")).toBe(false)
    expect(piRuntimeIsTooOld(null)).toBe(false)
  })
})

describe("Pi runtime path identity", () => {
  it("blocks a newly entered relative Pi agent directory", async () => {
    await renderPanel({ PI_ACP_PI_COMMAND: "/tmp/pi" })
    fireEvent.change(screen.getByPlaceholderText("~/.pi/agent"), {
      target: { value: "./agent" },
    })
    expect(
      await screen.findByText(/absolute Pi agent directory/)
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Save Runtime" }))
    expect(api.onSaveEnv).not.toHaveBeenCalled()
  })

  it("does not read or write native config under a saved relative agent directory", async () => {
    await renderPanel(
      {
        PI_ACP_PI_COMMAND: "/tmp/pi",
        PI_CODING_AGENT_DIR: "./agent",
      },
      null
    )
    expect(
      await screen.findAllByText(/absolute Pi agent directory/)
    ).toHaveLength(2)
    expect(api.loadPiConfig).not.toHaveBeenCalled()
    expect(api.listPiModelCapabilities).not.toHaveBeenCalled()
    expect(api.acpPiListTrustEntries).not.toHaveBeenCalled()
    await saveConfig()
    expect(api.acpUpdatePiConfig).not.toHaveBeenCalled()
  })

  it("keeps bare PATH commands and home-relative agent directories valid", async () => {
    await renderPanel({ PI_ACP_PI_COMMAND: "pi" })
    fireEvent.change(screen.getByPlaceholderText("~/.pi/agent"), {
      target: { value: "~/pi-agent" },
    })
    await userEvent.click(screen.getByRole("button", { name: "Save Runtime" }))
    expect(api.onSaveEnv).toHaveBeenCalledWith(
      expect.objectContaining({
        PI_ACP_PI_COMMAND: "pi",
        PI_CODING_AGENT_DIR: "~/pi-agent",
      }),
      true
    )
  })

  it("neither runs nor queries a saved relative Pi command, nor saves a new one", async () => {
    await renderPanel({ PI_ACP_PI_COMMAND: "./pi-test.sh" })
    expect(
      await screen.findByText(/absolute Pi command path/)
    ).toBeInTheDocument()
    expect(api.listPiModelCapabilities).not.toHaveBeenCalled()
    expect(api.acpValidatePiCommand).not.toHaveBeenCalledWith("./pi-test.sh")
    await userEvent.click(screen.getByRole("button", { name: "Save Runtime" }))
    expect(api.onSaveEnv).not.toHaveBeenCalled()
  })
})
