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
  conversationMaximized: false,
  activeTabId: "conv-1" as string | null,
  activeFileTabId: "browser:tab-1" as string | null,
  desktop: true,
  shortcuts: {} as Record<string, string>,
  listeners: new Map<string, (payload: unknown) => void>(),
  // Floating-ball action context: the active tab row and the agent universe.
  activeTab: null as {
    id: string
    conversationId: number | null
    agentType: string
  } | null,
  sortedAgentTypes: ["zcode", "codex"] as string[],
  favoriteAgents: [] as string[],
  activeFolder: { id: 1, path: "/repo" } as { id: number; path: string } | null,
}))

const spies = vi.hoisted(() => ({
  closeTab: vi.fn(),
  closeFileTab: vi.fn(),
  switchTab: vi.fn(),
  switchFileTab: vi.fn(),
  closeAllFileTabs: vi.fn(),
  setActivePane: vi.fn(),
  closeCurrentWindow: vi.fn(() => Promise.resolve()),
  subscribe: vi.fn(),
  setRoute: vi.fn(),
  openSettingsWindow: vi.fn(() => Promise.resolve()),
  auxOpenTab: vi.fn(),
  confirmDraftAgent: vi.fn(),
  openChatModeTab: vi.fn(),
  openNewConversationTab: vi.fn(),
}))

/** Captured from the (stubbed) FloatingBall: the controller's action handler. */
let ballAction: ((action: string) => void) | null = null

vi.mock("@/lib/api", () => ({ openSettingsWindow: spies.openSettingsWindow }))
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
// The floating ball reads the active ACP connection (to stop a turn) and the
// zoom level. Both pull provider modules this test does not exercise, and the
// ACP context imports the workspace store in a shape the stub below does not
// provide; the ⌘W behaviour under test touches neither.
vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => ({ cancel: vi.fn() }),
  // Not a zustand store: it returns the context value directly.
  useConnectionStore: () => ({
    getActiveKey: () => null,
    getConnection: () => null,
  }),
}))
vi.mock("@/hooks/use-appearance", () => ({
  useZoomLevel: () => ({ zoomLevel: 100, setZoomLevel: vi.fn() }),
  useFloatingBall: () => ({
    floatingBallFavoriteAgents: state.favoriteAgents,
  }),
}))
vi.mock("@/hooks/use-sorted-available-agents", () => ({
  useSortedAvailableAgents: () => ({
    sortedTypes: state.sortedAgentTypes,
    fresh: true,
    refresh: () => Promise.resolve(),
  }),
}))
vi.mock("@/components/layout/floating-ball", () => ({
  FloatingBall: ({ onAction }: { onAction: (action: string) => void }) => {
    ballAction = onAction
    return null
  },
}))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: state.activeFolder }),
}))
vi.mock("@/hooks/use-is-active-chat-mode", () => ({
  useIsActiveChatMode: () => false,
}))
vi.mock("@/contexts/sidebar-context", () => ({
  useSidebarContext: () => ({ toggle: vi.fn() }),
}))
vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({ toggle: vi.fn(), openTab: spies.auxOpenTab }),
}))
vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => ({ toggle: vi.fn() }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({
    openNewConversationTab: spies.openNewConversationTab,
    openTab: vi.fn(),
    switchTab: spies.switchTab,
    closeTab: spies.closeTab,
    confirmDraftAgent: spies.confirmDraftAgent,
    openChatModeTab: spies.openChatModeTab,
  }),
  useTabStore: <T,>(
    selector: (s: {
      tabs: { id: string; conversationId: number | null; agentType: string }[]
      activeTabId: string | null
      rawTabs: {
        id: string
        conversationId: number | null
        agentType: string
      }[]
    }) => T
  ) =>
    selector({
      tabs: state.activeTabId
        ? state.activeTab
          ? [state.activeTab]
          : [{ id: state.activeTabId, conversationId: 7, agentType: "zcode" }]
        : [],
      activeTabId: state.activeTabId,
      rawTabs:
        state.activeTabId && state.activeTab
          ? [state.activeTab]
          : state.activeTabId
            ? [{ id: state.activeTabId, conversationId: 7, agentType: "zcode" }]
            : [],
    }),
}))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceView: () => ({
    mode: state.mode,
    activePane: state.activePane,
    filesMaximized: state.filesMaximized,
    conversationMaximized: state.conversationMaximized,
  }),
  useWorkspaceFileTabs: () => ({
    activeFileTabId: state.activeFileTabId,
    fileTabs: state.activeFileTabId ? [{ id: state.activeFileTabId }] : [],
  }),
  useWorkspaceActions: () => ({
    closeFileTab: spies.closeFileTab,
    closeAllFileTabs: spies.closeAllFileTabs,
    switchFileTab: spies.switchFileTab,
    openFilePreview: vi.fn(),
    openBrowserTab: vi.fn(),
    setActivePane: spies.setActivePane,
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({
    openConversations: vi.fn(),
    setRoute: spies.setRoute,
  }),
}))
vi.mock("@/contexts/search-dialog-context", () => ({
  useSearchDialog: () => ({ open: false, setOpen: vi.fn() }),
}))
vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({ shortcuts: state.shortcuts }),
}))
vi.mock("@/stores/app-workspace-store", () => ({
  isConversationDeleted: () => false,
  useAppWorkspaceStore: (selector: (s: { conversations: [] }) => unknown) =>
    selector({ conversations: [] }),
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
  state.conversationMaximized = false
  state.activeTabId = "conv-1"
  state.activeFileTabId = "browser:tab-1"
  state.desktop = true
  state.shortcuts = { ...DEFAULT_SHORTCUTS }
  state.listeners.clear()
  spies.closeTab.mockClear()
  spies.closeFileTab.mockClear()
  spies.switchTab.mockClear()
  spies.switchFileTab.mockClear()
  spies.closeAllFileTabs.mockClear()
  spies.setActivePane.mockClear()
  spies.closeCurrentWindow.mockClear()
  spies.subscribe.mockReset()
  spies.subscribe.mockImplementation(
    async (event: string, handler: (payload: unknown) => void) => {
      state.listeners.set(event, handler)
      return () => state.listeners.delete(event)
    }
  )
  spies.setRoute.mockClear()
  spies.openSettingsWindow.mockClear()
  spies.auxOpenTab.mockClear()
  spies.confirmDraftAgent.mockClear()
  spies.openChatModeTab.mockClear()
  spies.openNewConversationTab.mockClear()
  state.activeTab = { id: "conv-1", conversationId: 7, agentType: "zcode" }
  state.sortedAgentTypes = ["zcode", "codex"]
  state.favoriteAgents = []
  state.activeFolder = { id: 1, path: "/repo" }
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

  // A press traced to a column the other one covers — reachable only where
  // the engine cannot report the hidden placeholder's visibility (no
  // `checkVisibility`, as here in jsdom) — must not move the pane into it,
  // and acts on the strip that is on screen.
  it("never moves the pane into a column a maximized conversation covers", async () => {
    state.conversationMaximized = true
    mount(
      `<div data-workspace-pane="files"><div data-browser-surface="tab-1"></div></div>`
    )
    const press = await renderController()
    press({ window: "main", surfaceTabId: "tab-1" })
    expect(spies.setActivePane).not.toHaveBeenCalled()
    expect(spies.closeTab).toHaveBeenCalledWith("conv-1")
    expect(spies.closeFileTab).not.toHaveBeenCalled()
  })

  // The file strip is hidden under the conversation: a pane last left on
  // "files" must not close a file tab nobody can see.
  it("routes ⌘W that no view held to a maximized conversation", async () => {
    state.activePane = "files"
    state.conversationMaximized = true
    vi.spyOn(document, "hasFocus").mockReturnValue(false)
    const press = await renderController()
    press({ window: "main", surfaceTabId: null })
    expect(spies.closeTab).toHaveBeenCalledWith("conv-1")
    expect(spies.closeFileTab).not.toHaveBeenCalled()
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

  it("closes the conversation tab while the conversation is maximized, whatever the pane", () => {
    state.activePane = "files"
    state.conversationMaximized = true
    render(<WorkspaceChromeController />)
    const event = createEvent.keyDown(document, { key: "w", metaKey: true })
    fireEvent(document, event)
    expect(spies.closeTab).toHaveBeenCalledWith("conv-1")
    expect(spies.closeFileTab).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  // The rest of the strip shortcuts follow the same rule: the numbered jump
  // picks from the conversation strip, and "close all file tabs" declines —
  // with the file strip hidden, it would empty a column nobody can see.
  it("keeps the other tab shortcuts off the hidden file strip while the conversation is maximized", () => {
    state.activePane = "files"
    state.conversationMaximized = true
    render(<WorkspaceChromeController />)

    const jump = createEvent.keyDown(document, {
      key: "1",
      code: "Digit1",
      metaKey: true,
    })
    fireEvent(document, jump)
    expect(spies.switchTab).toHaveBeenCalledWith("conv-1")
    expect(spies.switchFileTab).not.toHaveBeenCalled()
    expect(jump.defaultPrevented).toBe(true)

    const closeAll = createEvent.keyDown(document, {
      key: "w",
      metaKey: true,
      shiftKey: true,
    })
    fireEvent(document, closeAll)
    expect(spies.closeAllFileTabs).not.toHaveBeenCalled()
    expect(closeAll.defaultPrevented).toBe(false)
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

describe("WorkspaceChromeController — floating-ball actions", () => {
  function fire(action: string): void {
    render(<WorkspaceChromeController />)
    expect(typeof ballAction).toBe("function")
    ballAction?.(action)
  }

  it("routes the workspace actions", async () => {
    fire("openTodos")
    expect(spies.setRoute).toHaveBeenCalledWith("tasks")
    fire("openAutomations")
    expect(spies.setRoute).toHaveBeenCalledWith("automations")
    fire("openCanvas")
    expect(spies.setRoute).toHaveBeenCalledWith("canvas")
    fire("openAgents")
    await waitFor(() =>
      expect(spies.openSettingsWindow).toHaveBeenCalledWith("agents")
    )
    fire("openSystemAdmin")
    await waitFor(() =>
      expect(spies.openSettingsWindow).toHaveBeenCalledWith("system")
    )
  })

  it("opens the new-to-do composer even when the tasks route is already active", () => {
    const received: CustomEvent[] = []
    const listener = (e: Event) => received.push(e as CustomEvent)
    window.addEventListener("codeg:create-task-from-text", listener)
    fire("openTodosNew")
    window.removeEventListener("codeg:create-task-from-text", listener)
    expect(spies.setRoute).toHaveBeenCalledWith("tasks")
    expect(received).toHaveLength(1)
  })

  it("renames the active tab's conversation by id", () => {
    const received: unknown[] = []
    const listener = (e: Event) => received.push((e as CustomEvent).detail)
    window.addEventListener("codeg:rename-conversation", listener)
    fire("renameConversation")
    window.removeEventListener("codeg:rename-conversation", listener)
    expect(received).toEqual([{ conversationId: 7 }])
  })

  it("opens the file tree only with a workspace folder", () => {
    fire("openSessionFolder")
    expect(spies.auxOpenTab).toHaveBeenCalledWith("file_tree")

    state.activeFolder = null
    fire("openSessionFolder")
    expect(spies.auxOpenTab).toHaveBeenCalledTimes(1)
  })

  it("cycles the active draft tab's agent and confirms it", () => {
    state.activeTab = {
      id: "conv-1",
      conversationId: null,
      agentType: "zcode",
    }
    fire("cycleAgent")
    expect(spies.confirmDraftAgent).toHaveBeenCalledWith("conv-1", "codex")
    // The store would have applied the switch; reflect it like the real tab
    // row would, so the next stroke continues from codex.
    state.activeTab = {
      id: "conv-1",
      conversationId: null,
      agentType: "codex",
    }
    fire("cycleAgent")
    expect(spies.confirmDraftAgent).toHaveBeenLastCalledWith("conv-1", "zcode")
  })

  it("pins a new draft to the next agent when the active tab is saved", () => {
    fire("cycleAgent")
    expect(spies.confirmDraftAgent).not.toHaveBeenCalled()
    expect(spies.openNewConversationTab).toHaveBeenCalledWith(
      1,
      "/repo",
      expect.objectContaining({ forceAgent: "codex" })
    )
  })

  it("cycles only within the favorite list for cycleFavoriteAgent", () => {
    state.sortedAgentTypes = ["zcode", "codex", "cline"]
    state.favoriteAgents = ["codex", "cline"]
    fire("cycleFavoriteAgent")
    // Current tab agent zcode is not in the list → head of the list.
    expect(spies.openNewConversationTab).toHaveBeenCalledWith(
      1,
      "/repo",
      expect.objectContaining({ forceAgent: "codex" })
    )
  })
})
