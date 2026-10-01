import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SpeechCapabilities } from "@/lib/speech-capabilities"
import type { SpeechPrefs } from "@/lib/speech-prefs"

vi.mock("next-intl", () => ({ useLocale: () => "en" }))

vi.mock("@/lib/api", () => ({
  speechGetSettings: vi.fn(),
  speechTranscribe: vi.fn(),
}))

let prefs: SpeechPrefs = {
  input: { enabled: true, engine: "auto", language: "" },
}
vi.mock("@/lib/speech-prefs", () => ({ useSpeechPrefs: () => prefs }))

let caps: SpeechCapabilities = {
  browserStt: true,
  mediaCapture: true,
  secureContext: true,
}
vi.mock("@/lib/speech-capabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/speech-capabilities")>()),
  detectSpeechCapabilities: () => caps,
}))

import { speechGetSettings, speechTranscribe } from "@/lib/api"
import { MAX_RECORDING_MS, useSpeechInput } from "./use-speech-input"

const mockGetSettings = vi.mocked(speechGetSettings)
const mockTranscribe = vi.mocked(speechTranscribe)

type ResultInit = { transcript: string; isFinal: boolean }

class FakeRecognition {
  static instances: FakeRecognition[] = []
  continuous = false
  interimResults = false
  lang = ""
  onresult: ((event: unknown) => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  start = vi.fn()
  stop = vi.fn(() => this.onend?.())
  abort = vi.fn()

  constructor() {
    FakeRecognition.instances.push(this)
  }

  emit(results: ResultInit[], resultIndex = 0) {
    this.onresult?.({
      resultIndex,
      results: results.map((r) =>
        Object.assign([{ transcript: r.transcript }], { isFinal: r.isFinal })
      ),
    })
  }
}

class FakeTrack {
  stop = vi.fn()
}

class FakeRecorder {
  static instances: FakeRecorder[] = []
  static isTypeSupported = vi.fn((type: string) => type.startsWith("audio/ogg"))
  state: "inactive" | "recording" = "inactive"
  mimeType: string
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null

  constructor(
    public stream: { getTracks: () => FakeTrack[] },
    options?: { mimeType?: string }
  ) {
    this.mimeType = options?.mimeType ?? ""
    FakeRecorder.instances.push(this)
  }

  start() {
    this.state = "recording"
  }

  stop() {
    this.state = "inactive"
    this.ondataavailable?.({ data: new Blob(["voice"], { type: "audio/ogg" }) })
    this.onstop?.()
  }
}

let tracks: FakeTrack[] = []
const getUserMedia = vi.fn()

function lastRecognition() {
  return FakeRecognition.instances[FakeRecognition.instances.length - 1]
}

function lastRecorder() {
  return FakeRecorder.instances[FakeRecorder.instances.length - 1]
}

function renderSpeech() {
  const onFinalText = vi.fn()
  const onError = vi.fn()
  const hook = renderHook(() => useSpeechInput({ onFinalText, onError }))
  return { ...hook, onFinalText, onError }
}

beforeEach(() => {
  prefs = { input: { enabled: true, engine: "auto", language: "" } }
  caps = { browserStt: true, mediaCapture: true, secureContext: true }
  FakeRecognition.instances = []
  FakeRecorder.instances = []
  tracks = [new FakeTrack()]
  getUserMedia.mockReset()
  getUserMedia.mockImplementation(async () => ({ getTracks: () => tracks }))
  mockGetSettings.mockReset()
  mockGetSettings.mockResolvedValue({
    settings: {
      baseUrl: "https://api.openai.com/v1",
      sttModel: "whisper-1",
      ttsModel: "tts-1",
      ttsVoice: "alloy",
    },
    apiKeySet: true,
  })
  mockTranscribe.mockReset()
  vi.stubGlobal("SpeechRecognition", FakeRecognition)
  vi.stubGlobal("MediaRecorder", FakeRecorder)
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("useSpeechInput - browser engine", () => {
  it("streams interim text and hands each final result to onFinalText", async () => {
    const { result, onFinalText } = renderSpeech()
    await waitFor(() => expect(result.current.status).toBe("idle"))

    act(() => result.current.start())
    await waitFor(() => expect(result.current.status).toBe("listening"))

    const recognition = lastRecognition()
    expect(recognition.continuous).toBe(true)
    expect(recognition.interimResults).toBe(true)
    expect(recognition.lang).toBe("en-US")

    act(() => recognition.emit([{ transcript: "hello wor", isFinal: false }]))
    expect(result.current.interimText).toBe("hello wor")

    act(() =>
      recognition.emit([{ transcript: " hello world ", isFinal: true }])
    )
    expect(onFinalText).toHaveBeenCalledWith("hello world")
    expect(result.current.interimText).toBe("")

    act(() => result.current.stop())
    expect(recognition.stop).toHaveBeenCalled()
    expect(result.current.status).toBe("idle")
  })

  it("reports mic-denied and releases the recognizer", async () => {
    const { result, onError } = renderSpeech()
    act(() => result.current.start())
    await waitFor(() => expect(result.current.status).toBe("listening"))

    const recognition = lastRecognition()
    act(() => recognition.onerror?.({ error: "not-allowed" }))

    expect(onError).toHaveBeenCalledWith("mic-denied")
    expect(recognition.abort).toHaveBeenCalled()
    expect(result.current.status).toBe("idle")
  })

  it("maps a network failure to engine-failed", async () => {
    const { result, onError } = renderSpeech()
    act(() => result.current.start())
    await waitFor(() => expect(result.current.status).toBe("listening"))

    act(() => lastRecognition().onerror?.({ error: "network" }))
    expect(onError).toHaveBeenCalledWith("engine-failed")
  })

  it("returns to idle when the engine ends on its own", async () => {
    const { result } = renderSpeech()
    act(() => result.current.start())
    await waitFor(() => expect(result.current.status).toBe("listening"))

    act(() => lastRecognition().onend?.())
    expect(result.current.status).toBe("idle")
  })
})

describe("useSpeechInput - cloud engine", () => {
  beforeEach(() => {
    prefs = { input: { enabled: true, engine: "cloud", language: "de-DE" } }
  })

  it("records, transcribes with the bare mime type and language, then inserts", async () => {
    mockTranscribe.mockResolvedValue("  hallo welt ")
    const { result, onFinalText } = renderSpeech()

    act(() => result.current.start())
    await waitFor(() => expect(result.current.status).toBe("listening"))
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(lastRecorder().mimeType).toBe("audio/ogg;codecs=opus")

    act(() => result.current.stop())
    await waitFor(() => expect(onFinalText).toHaveBeenCalledWith("hallo welt"))

    const [audio, mimeType, language] = mockTranscribe.mock.calls[0]
    expect(atob(audio)).toBe("voice")
    expect(mimeType).toBe("audio/ogg")
    expect(language).toBe("de-DE")
    expect(tracks[0].stop).toHaveBeenCalled()
    expect(result.current.status).toBe("idle")
  })

  it("cancel discards the recording, sends nothing and stops the tracks", async () => {
    const { result, onFinalText } = renderSpeech()
    act(() => result.current.start())
    await waitFor(() => expect(result.current.status).toBe("listening"))

    act(() => result.current.cancel())

    expect(mockTranscribe).not.toHaveBeenCalled()
    expect(onFinalText).not.toHaveBeenCalled()
    expect(tracks[0].stop).toHaveBeenCalled()
    expect(result.current.status).toBe("idle")
  })

  it("stops the tracks when unmounted mid-recording", async () => {
    const { result, unmount } = renderSpeech()
    act(() => result.current.start())
    await waitFor(() => expect(result.current.status).toBe("listening"))

    unmount()

    expect(tracks[0].stop).toHaveBeenCalled()
    expect(mockTranscribe).not.toHaveBeenCalled()
  })

  it("maps authentication_failed to cloud-auth", async () => {
    mockTranscribe.mockRejectedValue({
      code: "authentication_failed",
      message: "Unauthorized",
    })
    const { result, onError, onFinalText } = renderSpeech()
    act(() => result.current.start())
    await waitFor(() => expect(result.current.status).toBe("listening"))

    act(() => result.current.stop())
    await waitFor(() => expect(onError).toHaveBeenCalledWith("cloud-auth"))
    expect(onFinalText).not.toHaveBeenCalled()
    expect(result.current.status).toBe("idle")
  })

  it("reports mic-denied when getUserMedia is refused", async () => {
    getUserMedia.mockRejectedValue(
      Object.assign(new Error("denied"), { name: "NotAllowedError" })
    )
    const { result, onError } = renderSpeech()
    act(() => result.current.start())

    await waitFor(() => expect(onError).toHaveBeenCalledWith("mic-denied"))
    expect(result.current.status).toBe("idle")
  })

  it("stops recording on its own at the time cap", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mockTranscribe.mockResolvedValue("long take")
    const { result, onFinalText } = renderSpeech()
    act(() => result.current.start())
    await waitFor(() => expect(result.current.status).toBe("listening"))

    act(() => {
      vi.advanceTimersByTime(MAX_RECORDING_MS)
    })

    await waitFor(() => expect(onFinalText).toHaveBeenCalledWith("long take"))
    expect(tracks[0].stop).toHaveBeenCalled()
  })
})

describe("useSpeechInput - availability", () => {
  it("is unavailable with a reason when no engine can run", async () => {
    caps = { browserStt: false, mediaCapture: false, secureContext: false }
    const { result } = renderSpeech()

    await waitFor(() => expect(result.current.status).toBe("unavailable"))
    expect(result.current.unavailableReason).toBe("insecure-context")
  })

  it("reports cloud-not-configured on start when the key is missing", async () => {
    caps = { browserStt: false, mediaCapture: true, secureContext: true }
    mockGetSettings.mockResolvedValue({
      settings: {
        baseUrl: "https://api.openai.com/v1",
        sttModel: "whisper-1",
        ttsModel: "tts-1",
        ttsVoice: "alloy",
      },
      apiKeySet: false,
    })
    const { result, onError } = renderSpeech()
    await waitFor(() => expect(result.current.status).toBe("unavailable"))

    act(() => result.current.start())
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("cloud-not-configured")
    )
    expect(getUserMedia).not.toHaveBeenCalled()
  })
})
