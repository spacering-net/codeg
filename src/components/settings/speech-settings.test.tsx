import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { SpeechCapabilities } from "@/lib/speech-capabilities"
import {
  getSpeechPrefs,
  resetSpeechPrefsCacheForTests,
  saveSpeechPrefs,
} from "@/lib/speech-prefs"
import type { SpeechCloudSettings, SpeechCloudSettingsView } from "@/lib/types"

const getSettings = vi.fn<() => Promise<SpeechCloudSettingsView>>()
const updateSettings =
  vi.fn<
    (
      s: SpeechCloudSettings,
      k: string | null
    ) => Promise<SpeechCloudSettingsView>
  >()
const mockAssistantGetSettings = vi.fn()
const mockAssistantSetSettings = vi.fn()
const mockAssistantReset = vi.fn()
const toastError = vi.fn()
const toastSuccess = vi.fn()
let caps: SpeechCapabilities

vi.mock("@/lib/api", () => ({
  speechGetSettings: () => getSettings(),
  speechUpdateSettings: (s: SpeechCloudSettings, k: string | null) =>
    updateSettings(s, k),
  assistantGetSettings: () => mockAssistantGetSettings(),
  assistantSetSettings: (s: unknown) => mockAssistantSetSettings(s),
  assistantReset: () => mockAssistantReset(),
}))
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({
    agents: [
      {
        agent_type: "claude_code",
        name: "Claude Code",
        installed_version: "1.0.0",
      },
      {
        agent_type: "codex",
        name: "Codex",
        installed_version: "1.0.0",
      },
      {
        agent_type: "pi",
        name: "Pi",
        installed_version: "1.0.0",
      },
      {
        agent_type: "open_claw",
        name: "OpenClaw",
        installed_version: "1.0.0",
      },
    ],
    fresh: true,
    reload: vi.fn(),
  }),
}))
vi.mock("@/lib/speech-capabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/speech-capabilities")>()),
  detectSpeechCapabilities: () => caps,
}))
vi.mock("sonner", () => ({
  toast: {
    error: (m: string) => toastError(m),
    success: (m: string) => toastSuccess(m),
  },
}))

import { SpeechSettings } from "./speech-settings"

const CLOUD: SpeechCloudSettings = {
  baseUrl: "https://api.openai.com/v1",
  sttModel: "whisper-1",
  ttsModel: "tts-1",
  ttsVoice: "alloy",
}

function view(apiKeySet: boolean, settings = CLOUD): SpeechCloudSettingsView {
  return { settings, apiKeySet }
}

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SpeechSettings />
    </NextIntlClientProvider>
  )
}

function enableInput(engine: "auto" | "browser" | "cloud" = "auto") {
  saveSpeechPrefs({ input: { enabled: true, engine, language: "" } })
}

beforeEach(() => {
  localStorage.clear()
  resetSpeechPrefsCacheForTests()
  caps = { browserStt: true, mediaCapture: true, secureContext: true }
  getSettings.mockReset()
  updateSettings.mockReset()
  mockAssistantGetSettings.mockReset()
  mockAssistantSetSettings.mockReset()
  mockAssistantReset.mockReset()
  toastError.mockClear()
  toastSuccess.mockClear()
  getSettings.mockResolvedValue(view(false))
  mockAssistantGetSettings.mockResolvedValue({
    agentType: "claude_code",
    allowSessionControl: false,
    allowPermissionAnswers: false,
  })
  mockAssistantSetSettings.mockResolvedValue(undefined)
  mockAssistantReset.mockResolvedValue(undefined)
})
afterEach(() => cleanup())

describe("SpeechSettings", () => {
  it("persists the voice input switch to prefs", async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole("switch", { name: "Voice input" }))

    expect(getSpeechPrefs().input.enabled).toBe(true)
    expect(await screen.findByText("Recognition engine")).toBeInTheDocument()
  })

  it("persists the engine choice", async () => {
    const user = userEvent.setup()
    enableInput()
    renderPage()

    await user.click(
      await screen.findByRole("combobox", { name: "Recognition engine" })
    )
    await user.click(await screen.findByRole("option", { name: "Cloud" }))

    expect(getSpeechPrefs().input.engine).toBe("cloud")
  })

  it("sends no key when the key field is untouched", async () => {
    const user = userEvent.setup()
    getSettings.mockResolvedValue(view(true))
    updateSettings.mockResolvedValue(view(true))
    renderPage()

    await user.click(await screen.findByRole("button", { name: "Save" }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1))
    expect(updateSettings.mock.calls[0][1]).toBeNull()
    expect(toastSuccess).toHaveBeenCalledWith("Speech settings saved")
  })

  it("sends a typed key and then shows it as saved", async () => {
    const user = userEvent.setup()
    updateSettings.mockResolvedValue(view(true))
    renderPage()

    await user.type(await screen.findByLabelText("API key"), "sk-test")
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith(CLOUD, "sk-test")
    )
    const keyInput = await screen.findByLabelText("API key")
    expect(keyInput).toHaveValue("")
    expect(keyInput).toHaveAttribute("placeholder", "Saved")
  })

  it("Remove key sends an empty key", async () => {
    const user = userEvent.setup()
    getSettings.mockResolvedValue(view(true))
    updateSettings.mockResolvedValue(view(false))
    renderPage()

    await user.click(await screen.findByRole("button", { name: "Remove key" }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(CLOUD, ""))
    expect(
      screen.queryByRole("button", { name: "Remove key" })
    ).not.toBeInTheDocument()
  })

  it("reports a rejected save and keeps the key state", async () => {
    const user = userEvent.setup()
    updateSettings.mockRejectedValue(new Error("invalid base url"))
    renderPage()

    const baseUrl = await screen.findByLabelText("Base URL")
    await user.clear(baseUrl)
    await user.type(baseUrl, "ftp://x")
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(toastError.mock.calls[0][0]).toContain("invalid base url")
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("status line names the unavailable reason", async () => {
    caps = { browserStt: false, mediaCapture: true, secureContext: true }
    enableInput("auto")
    renderPage()

    expect(await screen.findByTestId("speech-engine-status")).toHaveTextContent(
      "Unavailable: the cloud service has no API key yet."
    )
  })

  it("status line names the engine in use", async () => {
    caps = { browserStt: false, mediaCapture: true, secureContext: true }
    getSettings.mockResolvedValue(view(true))
    enableInput("auto")
    renderPage()

    expect(await screen.findByTestId("speech-engine-status")).toHaveTextContent(
      "Using: Cloud"
    )
  })
})

describe("SpeechSettings read aloud", () => {
  const m = enMessages.SpeechSettings

  afterEach(() => vi.unstubAllGlobals())

  it("enables read aloud and shows its controls", async () => {
    vi.stubGlobal("speechSynthesis", {
      getVoices: () => [
        { voiceURI: "fr", name: "Amelie", lang: "fr-FR" },
        { voiceURI: "en", name: "Samantha", lang: "en-US" },
      ],
    })
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByLabelText(m.outputTitle))
    expect(getSpeechPrefs().output.enabled).toBe(true)
    expect(await screen.findByTestId("speech-output-status")).toHaveTextContent(
      "Using: Browser"
    )
    expect(screen.getByLabelText(m.rateLabel)).toBeInTheDocument()
    expect(screen.getByLabelText(m.voiceLabel)).toBeInTheDocument()

    await user.click(screen.getByLabelText(m.autoReadLabel))
    expect(getSpeechPrefs().output.autoRead).toBe(true)

    await user.click(screen.getByLabelText(m.outputTitle))
    expect(getSpeechPrefs().output).toMatchObject({
      enabled: false,
      autoRead: false,
    })
  })

  it("reports missing voices and key when nothing can speak", async () => {
    vi.stubGlobal("speechSynthesis", undefined)
    saveSpeechPrefs({
      output: {
        enabled: true,
        engine: "auto",
        browserVoiceUri: "",
        rate: 1,
        autoRead: false,
      },
    })
    renderPage()
    expect(await screen.findByTestId("speech-output-status")).toHaveTextContent(
      m.reasonCloudNotConfigured
    )
    expect(screen.queryByLabelText(m.voiceLabel)).not.toBeInTheDocument()
  })

  it("saves the TTS model and voice with the cloud settings", async () => {
    updateSettings.mockResolvedValue(view(false))
    const user = userEvent.setup()
    renderPage()
    const model = await screen.findByLabelText(m.ttsModel)
    await user.clear(model)
    await user.type(model, "gpt-4o-mini-tts")
    const voice = screen.getByLabelText(m.ttsVoice)
    await user.clear(voice)
    await user.type(voice, "nova")
    await user.click(screen.getByRole("button", { name: m.save }))
    await waitFor(() => expect(updateSettings).toHaveBeenCalled())
    expect(updateSettings.mock.calls[0][0]).toMatchObject({
      ttsModel: "gpt-4o-mini-tts",
      ttsVoice: "nova",
    })
  })
})

describe("SpeechSettings voice assistant section", () => {
  it("persists assistant agent choice via assistantSetSettings", async () => {
    saveSpeechPrefs({
      voiceMode: {
        enabled: true,
        endSilenceMs: 900,
        bargeIn: true,
        announce: "all",
        voiceApprovals: false,
      },
    })
    const user = userEvent.setup()
    renderPage()

    const trigger = await screen.findByTestId("speech-assistant-agent-trigger")
    await user.click(trigger)

    expect(screen.queryByRole("option", { name: "Pi" })).toBeNull()
    expect(screen.queryByRole("option", { name: "OpenClaw" })).toBeNull()

    await user.click(await screen.findByRole("option", { name: "Codex" }))

    await waitFor(() =>
      expect(mockAssistantSetSettings).toHaveBeenCalledWith({
        agentType: "codex",
        allowSessionControl: false,
        allowPermissionAnswers: false,
      })
    )
  })

  it("toggles allowSessionControl and allowPermissionAnswers via assistantSetSettings", async () => {
    saveSpeechPrefs({
      voiceMode: {
        enabled: true,
        endSilenceMs: 900,
        bargeIn: true,
        announce: "all",
        voiceApprovals: false,
      },
    })
    const user = userEvent.setup()
    renderPage()

    const sessionControlSwitch = await screen.findByRole("switch", {
      name: "Session control",
    })
    await user.click(sessionControlSwitch)

    await waitFor(() =>
      expect(mockAssistantSetSettings).toHaveBeenCalledWith({
        agentType: "claude_code",
        allowSessionControl: true,
        allowPermissionAnswers: false,
      })
    )

    const permissionAnswersSwitch = await screen.findByRole("switch", {
      name: "Permission answers",
    })
    await user.click(permissionAnswersSwitch)

    await waitFor(() =>
      expect(mockAssistantSetSettings).toHaveBeenCalledWith({
        agentType: "claude_code",
        allowSessionControl: true,
        allowPermissionAnswers: true,
      })
    )
  })

  it("calls assistantReset when reset button is clicked", async () => {
    saveSpeechPrefs({
      voiceMode: {
        enabled: true,
        endSilenceMs: 900,
        bargeIn: true,
        announce: "all",
        voiceApprovals: false,
      },
    })
    const user = userEvent.setup()
    renderPage()

    const resetBtn = await screen.findByTestId("speech-assistant-reset-btn")
    await user.click(resetBtn)

    await waitFor(() => expect(mockAssistantReset).toHaveBeenCalledTimes(1))
    expect(toastSuccess).toHaveBeenCalledWith(
      "Fresh assistant conversation started."
    )
  })
})
