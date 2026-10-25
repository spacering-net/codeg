import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ComposerVoiceButton } from "./composer-voice-button"
import type { UseVoiceInputReturn } from "./use-voice-input"

function createMockVoice(overrides: Partial<UseVoiceInputReturn> = {}): UseVoiceInputReturn {
  return {
    status: "idle",
    mode: "web-speech",
    isSupported: true,
    volume: 0,
    interimText: "",
    errorMessage: null,
    startListening: vi.fn(),
    stopListening: vi.fn(),
    cancel: vi.fn(),
    ...overrides,
  }
}

describe("ComposerVoiceButton", () => {
  it("renders idle button with microphone icon", () => {
    const voice = createMockVoice()
    render(<ComposerVoiceButton voice={voice} />)

    const button = screen.getByTestId("composer-voice-button")
    expect(button).toBeInTheDocument()
    expect(button).not.toBeDisabled()
  })

  it("calls startListening on click when idle", () => {
    const voice = createMockVoice()
    render(<ComposerVoiceButton voice={voice} />)

    fireEvent.click(screen.getByTestId("composer-voice-button"))
    expect(voice.startListening).toHaveBeenCalled()
  })

  it("renders active state and calls stopListening on click when listening", () => {
    const voice = createMockVoice({ status: "listening" })
    render(<ComposerVoiceButton voice={voice} />)

    const button = screen.getByTestId("composer-voice-button")
    expect(button.className).toContain("text-red-500")

    fireEvent.click(button)
    expect(voice.stopListening).toHaveBeenCalled()
  })

  it("shows interim text bubble when speaking", () => {
    const voice = createMockVoice({
      status: "listening",
      interimText: "测试语音内容",
    })
    render(<ComposerVoiceButton voice={voice} />)

    const bubble = screen.getByTestId("voice-interim-bubble")
    expect(bubble).toBeInTheDocument()
    expect(bubble).toHaveTextContent("测试语音内容")
  })

  it("cancels on Escape key while listening", () => {
    const voice = createMockVoice({ status: "listening" })
    render(<ComposerVoiceButton voice={voice} />)

    fireEvent.keyDown(window, { key: "Escape" })
    expect(voice.cancel).toHaveBeenCalled()
  })

  it("disables button when transcribing", () => {
    const voice = createMockVoice({ status: "transcribing" })
    render(<ComposerVoiceButton voice={voice} />)

    const button = screen.getByTestId("composer-voice-button")
    expect(button).toBeDisabled()
  })
})
