import {
  act,
  createEvent,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_SHORTCUTS } from "@/lib/keyboard-shortcuts"
import {
  CLOSE_SHORTCUT_EVENT,
  type CloseShortcutPayload,
} from "@/lib/menu-close-shortcut"

import { WorkspaceChromeController } from "./workspace-chrome-controller"

const state = vi.hoisted(() => ({
  mode: "fusion" as "conversation" | "fusion",
  activePane: "conversation" as "conversation" | "files",
  filesMaximized: false,
  activeTabId: "conv-1" as string | null,
  activeFileTabId: "browser:tab-1" as string | null,
  desktop: true,
  shortcuts: {} as Record<string, string>,
  listeners: new Map<string, (payload: unknown) => void>(),
}))

const spies = vi.hoisted(() => ({
  closeTab: vi.fn(),
  closeFileTab: vi.fn(),
  setActivePane: vi.fn(),
  closeCurrentWindow: vi.fn(() => Promise.resolve()),
  subscribe: vi.fn(),
}))

vi.mock("@/lib/api", () => ({ openSettingsWindow: vi.fn() }))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: { id: 1, path: "/repo" } }),
}))
vi.mock("@/hooks/use-is-active-chat-mode", () => ({
  useIsActiveChatMode: () => false,
}))
vi.mock("@/contexts/sidebar-context", () => ({
  useSidebarContext: () => ({ toggle: vi.fn() }),
}))
vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({ toggle: vi.fn() }),
}))
vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => ({ toggle: vi.fn() }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({
    openNewConversationTab: vi.fn(),
    openTab: vi.fn(),
    switchTab: vi.fn(),
    closeTab: spies.closeTab,
  }),
  useTabStore: <T,>(
    selector: (s: { tabs: { id: string }[]; activeTabId: string | null }) => T
  ) =>
    selector({
      tabs: state.activeTabId ? [{ id: state.activeTabId }] : [],
      activeTabId: state.activeTabId,
    }),
}))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceView: () => ({
    mode: state.mode,
    activePane: state.activePane,
    filesMaximized: state.filesMaximized,
  }),
  useWorkspaceFileTabs: () => ({
    activeFileTabId: state.activeFileTabId,
    fileTabs: state.activeFileTabId ? [{ id: state.activeFileTabId }] : [],
  }),
  useWorkspaceActions: () => ({
    closeFileTab: spies.closeFileTab,
    closeAllFileTabs: vi.fn(),
    switchFileTab: vi.fn(),
    openFilePreview: vi.fn(),
    openBrowserTab: vi.fn(),
    setActivePane: spies.setActivePane,
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: vi.fn() }),
}))
vi.mock("@/contexts/search-dialog-context", () => ({
  useSearchDialog: () => ({ open: false, setOpen: vi.fn() }),
}))
vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({ shortcuts: state.shortcuts }),
}))
vi.mock("@/stores/app-workspace-store", () => ({
  isConversationDeleted: () => false,
  useAppWorkspaceStore: { getState: () => ({ getFolder: () => null }) },
}))
vi.mock("@/lib/closed-tab-stack", () => ({ popClosedTab: () => null }))
vi.mock("@/components/conversations/search-command-dialog", () => ({
  SearchCommandDialog: () => null,
}))
vi.mock("@/components/layout/workspace-folder-dialog", () => ({
  WorkspaceFolderDialog: () => null,
}))
vi.mock("@/lib/transport", () => ({
  isDesktop: () => state.desktop,
  getShellTransport: () => ({ subscribe: spies.subscribe }),
}))
vi.mock("@/lib/platform", () => ({
  closeCurrentWindow: spies.closeCurrentWindow,
}))
vi.mock("@/lib/browser/window-label", () => ({
  getCurrentWindowLabel: () => "main",
}))

/** Render, and hand back the ⌘W the app menu would deliver. */
async function renderController(): Promise<
  (payload: CloseShortcutPayload) => void
> {
  render(<WorkspaceChromeController />)
  await waitFor(() =>
    expect(state.listeners.has(CLOSE_SHORTCUT_EVENT)).toBe(true)
  )
  return (payload) => {
    act(() => state.listeners.get(CLOSE_SHORTCUT_EVENT)?.(payload))
  }
}

function mount(html: string): void {
  document.body.insertAdjacentHTML("beforeend", html)
}

function focusIframe(id: string): void {
  const frame = document.getElementById(id)
  vi.spyOn(document, "hasFocus").mockReturnValue(true)
  vi.spyOn(document, "activeElement", "get").mockReturnValue(frame)
}

beforeEach(() => {
  state.mode = "fusion"
  state.activePane = "conversation"
  state.filesMaximized = false
  state.activeTabId = "conv-1"
  state.activeFileTabId = "browser:tab-1"
  state.desktop = true
  state.shortcuts = { ...DEFAULT_SHORTCUTS }
  state.listeners.clear()
  spies.closeTab.mockClear()
  spies.closeFileTab.mockClear()
  spies.setActivePane.mockClear()
  spies.closeCurrentWindow.mockClear()
  spies.subscribe.mockReset()
  spies.subscribe.mockImplementation(
    async (event: string, handler: (payload: unknown) => void) => {
      state.listeners.set(event, handler)
      return () => state.listeners.delete(event)
    }
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ""
})

describe("WorkspaceChromeController — ⌘W from the app menu", () => {
  it("closes the tab of the page that had focus, not the active pane's", async () => {
    mount(
      `<div data-workspace-pane="files"><div data-browser-surface="tab-1"></div></div>`
    )
    const press = await renderController()
    press({ window: "main", surfaceTabId: "tab-1" })
    expect(spies.closeFileTab).toHaveBeenCalledWith("browser:tab-1")
    expect(spies.closeTab).not.toHaveBeenCalled()
    expect(spies.setActivePane).toHaveBeenCalledWith("files")
    expect(spies.closeCurrentWindow).not.toHaveBeenCalled()
  })

  it("closes the conversation tab from an iframe in the transcript", async () => {
    state.activePane = "files"
    mount(
      `<div data-workspace-pane="conversation"><iframe id="frame"></iframe></div>`
    )
    focusIframe("frame")
    const press = await renderController()
    press({ window: "main", surfaceTabId: null })
    expect(spies.closeTab).toHaveBeenCalledWith("conv-1")
    expect(spies.closeFileTab).not.toHaveBeenCalled()
    expect(spies.setActivePane).toHaveBeenCalledWith("conversation")
    expect(spies.closeCurrentWindow).not.toHaveBeenCalled()
  })

  it("routes a page outside both panes the way the workspace routes ⌘W", async () => {
    state.activePane = "files"
    state.activeFileTabId = "file:%2Frepo%2Fa.html"
    // The side panel over a full-page route.
    mount(`<div><div data-browser-surface="tab-1"></div></div>`)
    const press = await renderController()
    press({ window: "main", surfaceTabId: "tab-1" })
    expect(spies.closeFileTab).toHaveBeenCalledWith("file:%2Frepo%2Fa.html")
    expect(spies.setActivePane).not.toHaveBeenCalled()
  })

  it("routes ⌘W that no view held by the active pane", async () => {
    // The page that had the keyboard was just closed by the previous ⌘W.
    state.activePane = "files"
    vi.spyOn(document, "hasFocus").mockReturnValue(false)
    const press = await renderController()
    press({ window: "main", surfaceTabId: null })
    expect(spies.closeFileTab).toHaveBeenCalledWith("browser:tab-1")
    expect(spies.closeCurrentWindow).not.toHaveBeenCalled()
  })

  it("still closes the window when the page heard ⌘W and let it through", async () => {
    mount(`<button id="button">x</button>`)
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
    document.getElementById("button")?.focus()
    const press = await renderController()
    press({ window: "main", surfaceTabId: null })
    expect(spies.closeCurrentWindow).toHaveBeenCalledTimes(1)
    expect(spies.closeTab).not.toHaveBeenCalled()
    expect(spies.closeFileTab).not.toHaveBeenCalled()
  })

  it("closes the window when the pane it was pressed in has no tab", async () => {
    state.activeFileTabId = null
    mount(
      `<div data-workspace-pane="files"><div data-browser-surface="tab-1"></div></div>`
    )
    const press = await renderController()
    press({ window: "main", surfaceTabId: "tab-1" })
    expect(spies.closeCurrentWindow).toHaveBeenCalledTimes(1)
    expect(spies.closeTab).not.toHaveBeenCalled()
  })

  it("keeps ⌘W on the window for someone who moved close-tab elsewhere", async () => {
    state.shortcuts = { ...DEFAULT_SHORTCUTS, close_current_tab: "mod+shift+x" }
    mount(
      `<div data-workspace-pane="files"><div data-browser-surface="tab-1"></div></div>`
    )
    const press = await renderController()
    press({ window: "main", surfaceTabId: "tab-1" })
    expect(spies.closeCurrentWindow).toHaveBeenCalledTimes(1)
    expect(spies.closeFileTab).not.toHaveBeenCalled()
  })

  it("does nothing for a surface this window does not show", async () => {
    const press = await renderController()
    press({ window: "main", surfaceTabId: "tab-9" })
    expect(spies.closeTab).not.toHaveBeenCalled()
    expect(spies.closeFileTab).not.toHaveBeenCalled()
    expect(spies.closeCurrentWindow).not.toHaveBeenCalled()
  })

  it("ignores ⌘W pressed in another workspace window", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false)
    const press = await renderController()
    press({ window: "remote-workspace-2", surfaceTabId: null })
    expect(spies.closeTab).not.toHaveBeenCalled()
    expect(spies.closeFileTab).not.toHaveBeenCalled()
    expect(spies.closeCurrentWindow).not.toHaveBeenCalled()
  })

  it("listens only in the desktop app", () => {
    state.desktop = false
    render(<WorkspaceChromeController />)
    expect(spies.subscribe).not.toHaveBeenCalled()
  })
})

describe("WorkspaceChromeController — ⌘W the page hears", () => {
  it("closes the active pane's tab and keeps the keystroke from the menu", () => {
    render(<WorkspaceChromeController />)
    const event = createEvent.keyDown(document, { key: "w", metaKey: true })
    fireEvent(document, event)
    expect(spies.closeTab).toHaveBeenCalledWith("conv-1")
    expect(event.defaultPrevented).toBe(true)
  })

  it("lets it through when the active pane has nothing to close", () => {
    state.activePane = "files"
    state.activeFileTabId = null
    render(<WorkspaceChromeController />)
    const event = createEvent.keyDown(document, { key: "w", metaKey: true })
    fireEvent(document, event)
    expect(spies.closeFileTab).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })
})
