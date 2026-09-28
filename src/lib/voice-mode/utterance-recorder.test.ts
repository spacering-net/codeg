import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { speechTranscribe } from "@/lib/api"

import { createUtteranceRecorder, MAX_UTTERANCE_MS } from "./utterance-recorder"

vi.mock("@/lib/api", () => ({ speechTranscribe: vi.fn() }))

const transcribe = vi.mocked(speechTranscribe)

interface FakeResult {
  isFinal: boolean
  length: number
  0: { transcript: string }
}

function result(transcript: string, isFinal: boolean): FakeResult {
  return { isFinal, length: 1, 0: { transcript } }
}

class FakeRecognition {
  static instances: FakeRecognition[] = []
  continuous = false
  interimResults = false
  lang = ""
  onresult:
    | ((event: { resultIndex: number; results: FakeResult[] }) => void)
    | null = null
  onerror: ((event: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  start = vi.fn()
  stop = vi.fn()
  abort = vi.fn()
  constructor() {
    FakeRecognition.instances.push(this)
  }
  emit(resultIndex: number, results: FakeResult[]) {
    this.onresult?.({ resultIndex, results })
  }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported = (type: string) => type === "audio/webm;codecs=opus"
  state: "inactive" | "recording" = "inactive"
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor(
    readonly stream: MediaStream,
    readonly options?: { mimeType?: string }
  ) {
    FakeMediaRecorder.instances.push(this)
  }
  get mimeType() {
    return this.options?.mimeType ?? ""
  }
  start = vi.fn(() => {
    this.state = "recording"
  })
  stop = vi.fn(() => {
    this.state = "inactive"
    this.ondataavailable?.({
      data: new Blob(["audio"], { type: "audio/webm" }),
    })
    this.onstop?.()
  })
}

const stream = {} as MediaStream

beforeEach(() => {
  FakeRecognition.instances = []
  FakeMediaRecorder.instances = []
  transcribe.mockReset()
  vi.stubGlobal("SpeechRecognition", FakeRecognition)
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("utterance recorder - browser engine", () => {
  it("resolves with the finals plus the last interim, then aborts", async () => {
    const recorder = createUtteranceRecorder("browser", stream, "en-US")
    recorder.beginUtterance()
    const recognition = FakeRecognition.instances[0]
    expect(recognition.continuous).toBe(true)
    expect(recognition.interimResults).toBe(true)
    expect(recognition.lang).toBe("en-US")
    expect(recognition.start).toHaveBeenCalledOnce()

    recognition.emit(0, [result("Open the ", true)])
    recognition.emit(1, [result("Open the ", true), result("pull", false)])
    recognition.emit(1, [
      result("Open the ", true),
      result("pull request", false),
    ])

    await expect(recorder.endUtterance()).resolves.toBe("Open the pull request")
    expect(recognition.abort).toHaveBeenCalledOnce()
    expect(recognition.onresult).toBeNull()
  })

  it("abort discards the utterance and a later end resolves empty", async () => {
    const recorder = createUtteranceRecorder("browser", stream, "en-US")
    recorder.beginUtterance()
    const recognition = FakeRecognition.instances[0]
    recognition.emit(0, [result("never mind", true)])

    recorder.abort()

    expect(recognition.abort).toHaveBeenCalledOnce()
    await expect(recorder.endUtterance()).resolves.toBe("")
    expect(transcribe).not.toHaveBeenCalled()
  })
})

describe("utterance recorder - cloud engine", () => {
  it("records on the shared stream and transcribes on end", async () => {
    transcribe.mockResolvedValue("  run the tests  ")
    const recorder = createUtteranceRecorder("cloud", stream, "de-DE")
    recorder.beginUtterance()
    const media = FakeMediaRecorder.instances[0]
    expect(media.stream).toBe(stream)
    expect(media.options).toEqual({ mimeType: "audio/webm;codecs=opus" })
    expect(media.start).toHaveBeenCalledOnce()

    await expect(recorder.endUtterance()).resolves.toBe("run the tests")
    expect(media.stop).toHaveBeenCalledOnce()
    expect(transcribe).toHaveBeenCalledOnce()
    const [base64, mimeType, language] = transcribe.mock.calls[0]
    expect(atob(base64)).toBe("audio")
    expect(mimeType).toBe("audio/webm")
    expect(language).toBe("de-DE")
  })

  it("rejects when transcription fails", async () => {
    transcribe.mockRejectedValue(new Error("authentication_failed"))
    const recorder = createUtteranceRecorder("cloud", stream, "")
    recorder.beginUtterance()

    await expect(recorder.endUtterance()).rejects.toThrow(
      "authentication_failed"
    )
    expect(transcribe.mock.calls[0][2]).toBeNull()
  })

  it("stops capture at the cap and still transcribes on end", async () => {
    vi.useFakeTimers()
    transcribe.mockResolvedValue("long request")
    const recorder = createUtteranceRecorder("cloud", stream, "en-US")
    recorder.beginUtterance()
    const media = FakeMediaRecorder.instances[0]

    vi.advanceTimersByTime(MAX_UTTERANCE_MS - 1)
    expect(media.stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(media.stop).toHaveBeenCalledOnce()
    expect(transcribe).not.toHaveBeenCalled()
    // jsdom's FileReader (used by blobToBase64) schedules its load on a timer.
    vi.useRealTimers()

    await expect(recorder.endUtterance()).resolves.toBe("long request")
    expect(media.stop).toHaveBeenCalledOnce()
  })

  it("abort stops the recorder and sends nothing", async () => {
    const recorder = createUtteranceRecorder("cloud", stream, "en-US")
    recorder.beginUtterance()
    const media = FakeMediaRecorder.instances[0]

    recorder.abort()

    expect(media.stop).toHaveBeenCalledOnce()
    await expect(recorder.endUtterance()).resolves.toBe("")
    expect(transcribe).not.toHaveBeenCalled()
  })
})
