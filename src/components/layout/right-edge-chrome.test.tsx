import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { getSpeechPrefs, saveSpeechPrefs } from "@/lib/speech-prefs"
import { RightEdgeChrome } from "./right-edge-chrome"

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: null }),
}))

vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({ isOpen: false, toggle: vi.fn() }),
}))

vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => ({ isOpen: false, toggle: vi.fn() }),
}))

vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ isConversations: true }),
}))

vi.mock("@/hooks/use-is-active-chat-mode", () => ({
  useIsActiveChatMode: () => true,
}))

vi.mock("@/hooks/use-is-mac", () => ({
  useIsMac: () => false,
}))

vi.mock("@/hooks/use-appearance", () => ({
  useZoomLevel: () => ({ zoomLevel: 100 }),
}))

vi.mock("@/lib/api", () => ({
  openSettingsWindow: vi.fn(),
}))

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RightEdgeChrome />
    </NextIntlClientProvider>
  )
}

describe("RightEdgeChrome voice mode button", () => {
  const initialPrefs = getSpeechPrefs()

  afterEach(() => {
    saveSpeechPrefs(initialPrefs)
  })

  it("hides top-bar voice mode button when voiceMode.enabled is false", () => {
    saveSpeechPrefs({
      ...initialPrefs,
      voiceMode: {
        ...initialPrefs.voiceMode,
        enabled: false,
      },
    })
    mount()

    expect(screen.queryByTestId("topbar-voice-mode-btn")).toBeNull()
  })

  it("shows top-bar voice mode button when voiceMode.enabled is true", () => {
    saveSpeechPrefs({
      ...initialPrefs,
      voiceMode: {
        ...initialPrefs.voiceMode,
        enabled: true,
      },
    })
    mount()

    expect(screen.getByTestId("topbar-voice-mode-btn")).toBeInTheDocument()
  })
})
