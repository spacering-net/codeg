import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useVoiceInput } from "./use-voice-input"

describe("useVoiceInput", () => {
  let mockRecognitionInstance: any

  beforeEach(() => {
    mockRecognitionInstance = {
      start: vi.fn(),
      stop: vi.fn(),
      abort: vi.fn(),
      continuous: false,
      interimResults: false,
      lang: "",
      onresult: null,
      onerror: null,
      onend: null,
    }

    ;(window as any).SpeechRecognition = vi.fn(() => mockRecognitionInstance)
  })

  afterEach(() => {
    delete (window as any).SpeechRecognition
    delete (window as any).webkitSpeechRecognition
    vi.clearAllMocks()
  })

  it("initializes with idle status and web-speech support", () => {
    const { result } = renderHook(() => useVoiceInput())
    expect(result.current.status).toBe("idle")
    expect(result.current.isSupported).toBe(true)
    expect(result.current.interimText).toBe("")
  })

  it("starts listening on startListening() in web-speech mode", async () => {
    const onTranscript = vi.fn()
    const { result } = renderHook(() => useVoiceInput({ onTranscript }))

    await act(async () => {
      await result.current.startListening()
    })

    expect(mockRecognitionInstance.start).toHaveBeenCalled()
    expect(result.current.status).toBe("listening")
    expect(result.current.mode).toBe("web-speech")
  })

  it("delivers finalized speech to onTranscript", async () => {
    const onTranscript = vi.fn()
    const { result } = renderHook(() => useVoiceInput({ onTranscript }))

    await act(async () => {
      await result.current.startListening()
    })

    // Simulate recognition onresult event
    act(() => {
      mockRecognitionInstance.onresult({
        resultIndex: 0,
        results: [
          Object.assign([[{ transcript: "你好，知夏" }]], {
            isFinal: true,
            0: { transcript: "你好，知夏" },
          }),
        ],
      })
    })

    expect(onTranscript).toHaveBeenCalledWith("你好，知夏", true)
  })

  it("handles interim results and flushes them on stopListening()", async () => {
    const onTranscript = vi.fn()
    const onInterim = vi.fn()
    const { result } = renderHook(() =>
      useVoiceInput({ onTranscript, onInterimTranscript: onInterim })
    )

    await act(async () => {
      await result.current.startListening()
    })

    act(() => {
      mockRecognitionInstance.onresult({
        resultIndex: 0,
        results: [
          Object.assign([[{ transcript: "正在说话" }]], {
            isFinal: false,
            0: { transcript: "正在说话" },
          }),
        ],
      })
    })

    expect(result.current.interimText).toBe("正在说话")
    expect(onInterim).toHaveBeenCalledWith("正在说话")

    // Now stop listening: remaining interim text is flushed
    act(() => {
      result.current.stopListening()
    })

    expect(onTranscript).toHaveBeenCalledWith("正在说话", true)
    expect(result.current.status).toBe("idle")
  })

  it("handles permission denial error gracefully", async () => {
    const onError = vi.fn()
    const { result } = renderHook(() => useVoiceInput({ onError }))

    await act(async () => {
      await result.current.startListening()
    })

    act(() => {
      mockRecognitionInstance.onerror({ error: "not-allowed" })
    })

    expect(result.current.status).toBe("error")
    expect(result.current.errorMessage).toBe("micPermissionDenied")
    expect(onError).toHaveBeenCalledWith("micPermissionDenied")
  })

  it("cancels listening and aborts recognition without output", async () => {
    const onTranscript = vi.fn()
    const { result } = renderHook(() => useVoiceInput({ onTranscript }))

    await act(async () => {
      await result.current.startListening()
    })

    act(() => {
      result.current.cancel()
    })

    expect(mockRecognitionInstance.abort).toHaveBeenCalled()
    expect(result.current.status).toBe("idle")
    expect(onTranscript).not.toHaveBeenCalled()
  })
})
