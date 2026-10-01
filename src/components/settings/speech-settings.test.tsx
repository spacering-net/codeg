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
const toastError = vi.fn()
const toastSuccess = vi.fn()
let caps: SpeechCapabilities

vi.mock("@/lib/api", () => ({
  speechGetSettings: () => getSettings(),
  speechUpdateSettings: (s: SpeechCloudSettings, k: string | null) =>
    updateSettings(s, k),
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
  toastError.mockClear()
  toastSuccess.mockClear()
  getSettings.mockResolvedValue(view(false))
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
