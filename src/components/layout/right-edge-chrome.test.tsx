import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { RightEdgeChrome } from "./right-edge-chrome"
import enMessages from "@/i18n/messages/en.json"

const spies = vi.hoisted(() => ({
  toggleTerminal: vi.fn(),
  toggleAuxPanel: vi.fn(),
  openBrowserTab: vi.fn(),
  toggleConversationMaximized: vi.fn(),
  mode: "conversation",
  conversationMaximized: false,
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({
    activeFolder: { id: 1, name: "repo", path: "/repo" },
  }),
}))
vi.mock("@/hooks/use-is-active-chat-mode", () => ({
  useIsActiveChatMode: () => false,
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ isConversations: true }),
}))
vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => ({ isOpen: false, toggle: spies.toggleTerminal }),
}))
vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({ isOpen: false, toggle: spies.toggleAuxPanel }),
}))
vi.mock("@/contexts/workspace-context", () => ({
  useOptionalWorkspaceView: () => ({
    mode: spies.mode,
    activePane: "conversation",
    filesMaximized: false,
    conversationMaximized: spies.conversationMaximized,
  }),
  useOptionalWorkspaceActions: () => ({
    openBrowserTab: spies.openBrowserTab,
    toggleConversationMaximized: spies.toggleConversationMaximized,
  }),
}))
vi.mock("@/components/workbench/workbench-content", () => ({
  WorkbenchRouteChromeActions: () => null,
}))
vi.mock("@/hooks/use-is-mac", () => ({ useIsMac: () => false }))
vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({
    shortcuts: {
      toggle_terminal: "ctrl+`",
      toggle_aux_panel: "ctrl+shift+e",
      open_settings: "ctrl+,",
    },
  }),
}))
vi.mock("@/hooks/use-appearance", () => ({
  useZoomLevel: () => ({ zoomLevel: 100, setZoomLevel: () => {} }),
}))

function renderChrome() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RightEdgeChrome />
    </NextIntlClientProvider>
  )
}

describe("RightEdgeChrome", () => {
  beforeEach(() => {
    spies.toggleTerminal.mockClear()
    spies.toggleAuxPanel.mockClear()
    spies.openBrowserTab.mockClear()
    spies.toggleConversationMaximized.mockClear()
    spies.mode = "conversation"
    spies.conversationMaximized = false
  })

  it("opens a new browser tab when no tabs are open", () => {
    spies.mode = "conversation"
    renderChrome()

    const browserBtn = screen.getByRole("button", { name: "New Browser Tab" })
    expect(browserBtn).toBeInTheDocument()
    expect(browserBtn.className).not.toContain("bg-accent")

    fireEvent.click(browserBtn)
    expect(spies.openBrowserTab).toHaveBeenCalledWith("about:blank")
    expect(spies.toggleConversationMaximized).not.toHaveBeenCalled()
  })

  it("toggles panel collapse when tabs already exist and panel is visible", () => {
    spies.mode = "fusion"
    spies.conversationMaximized = false
    renderChrome()

    const browserBtn = screen.getByRole("button", {
      name: "Toggle Browser Panel",
    })
    expect(browserBtn).toBeInTheDocument()
    expect(browserBtn.className).toContain("bg-accent")

    fireEvent.click(browserBtn)
    expect(spies.toggleConversationMaximized).toHaveBeenCalled()
    expect(spies.openBrowserTab).not.toHaveBeenCalled()
  })

  it("toggles panel expand when tabs exist but panel is hidden", () => {
    spies.mode = "fusion"
    spies.conversationMaximized = true
    renderChrome()

    const browserBtn = screen.getByRole("button", {
      name: "Toggle Browser Panel",
    })
    expect(browserBtn).toBeInTheDocument()
    expect(browserBtn.className).not.toContain("bg-accent")

    fireEvent.click(browserBtn)
    expect(spies.toggleConversationMaximized).toHaveBeenCalled()
    expect(spies.openBrowserTab).not.toHaveBeenCalled()
  })
})
