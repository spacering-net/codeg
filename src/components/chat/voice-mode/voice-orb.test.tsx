import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  patchVoiceMode,
  resetVoiceModeStoreForTests,
  setVoiceLevel,
  setVoiceModeController,
  setVoicePhase,
} from "@/lib/voice-mode/voice-mode-store"

const mockOpenTab = vi.fn()

vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({
    openTab: mockOpenTab,
  }),
}))

import { VoiceOrb } from "./voice-orb"

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <VoiceOrb />
    </NextIntlClientProvider>
  )
}

describe("VoiceOrb", () => {
  const stopController = vi.fn()
  const startController = vi.fn()

  beforeEach(() => {
    resetVoiceModeStoreForTests()
    setVoiceModeController({
      start: startController,
      stop: stopController,
    })
    mockOpenTab.mockReset()
    stopController.mockReset()
    startController.mockReset()
  })

  afterEach(() => {
    resetVoiceModeStoreForTests()
  })

  it("renders nothing when phase is off", () => {
    const { container } = mount()
    expect(container.firstChild).toBeNull()
  })

  it("renders orb with polite aria-live label for active phase", () => {
    act(() => {
      setVoicePhase("listening")
    })
    mount()

    const orb = screen.getByTestId("voice-orb")
    expect(orb).toBeInTheDocument()
    expect(orb).toHaveAttribute("data-phase", "listening")

    const ariaLive = screen.getByTestId("voice-orb-aria-live")
    expect(ariaLive).toHaveAttribute("aria-live", "polite")
  })

  it("includes reduced-motion utility classes", () => {
    act(() => {
      setVoicePhase("speaking")
    })
    mount()

    const orb = screen.getByTestId("voice-orb")
    expect(orb.className).toContain("motion-reduce:animate-none")
  })

  it("updates voice level custom property on capturing phase", () => {
    act(() => {
      setVoicePhase("capturing")
      setVoiceLevel(0.8)
    })
    mount()

    const orb = screen.getByTestId("voice-orb")
    expect(orb).toHaveAttribute("data-level", "0.8")
    expect(orb.style.getPropertyValue("--voice-level")).toBe("0.8")
  })

  it("exits voice mode on close button click", () => {
    act(() => {
      setVoicePhase("listening")
    })
    mount()

    const closeBtn = screen.getByTestId("voice-orb-close-btn")
    fireEvent.click(closeBtn)

    expect(stopController).toHaveBeenCalledTimes(1)
  })

  it("opens transcript tab when assistant is present and transcript button is clicked", () => {
    act(() => {
      setVoicePhase("listening")
      patchVoiceMode({
        assistant: {
          connectionId: "conn-1",
          conversationId: 42,
          folderId: 10,
          agentType: "claude_code",
          primer: null,
        },
      })
    })
    mount()

    const transcriptBtn = screen.getByTestId("voice-orb-transcript-btn")
    expect(transcriptBtn).not.toBeDisabled()

    fireEvent.click(transcriptBtn)
    expect(mockOpenTab).toHaveBeenCalledWith(10, 42, "claude_code", true)
  })
})
