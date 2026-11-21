import { type ReactElement } from "react"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import esMessages from "@/i18n/messages/es.json"
import zhCnMessages from "@/i18n/messages/zh-CN.json"
import type { InstalledPlugin } from "@/lib/host-plugins"
import type { Transport } from "@/lib/transport"

const mocks = vi.hoisted(() => ({
  transport: null as Transport | null,
  activeRemoteId: null as number | null,
  listeners: new Set<() => void>(),
  activeFolderId: 1 as number | null,
  activeFolderKind: "regular" as "regular" | "chat",
  activeTabId: null as string | null,
  tabs: [] as Array<{
    id: string
    kind: "conversation"
    folderId: number
    conversationId: number | null
    isChat?: boolean
  }>,
  openTab: vi.fn(),
  openConversations: vi.fn(),
  openPluginScreen: vi.fn(),
  openFilePreview: vi.fn(),
  revealInFileTree: vi.fn(),
  openPluginPanel: vi.fn(),
  resetFileTree: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => {
    if (!mocks.transport) {
      throw new Error("Mock transport not configured")
    }
    return mocks.transport
  },
  getActiveRemoteConnectionId: () => mocks.activeRemoteId,
  subscribeTransportChange: (listener: () => void) => {
    mocks.listeners.add(listener)
    return () => {
      mocks.listeners.delete(listener)
    }
  },
  isDesktop: () => false,
  isRemoteDesktopMode: () => mocks.activeRemoteId !== null,
}))

vi.mock("@/components/agent-icon", () => ({ AgentIcon: () => null }))
vi.mock("@/lib/api", () => ({
  listAllConversations: vi.fn(async () => []),
  openProjectBootWindow: vi.fn(() => Promise.resolve()),
}))
vi.mock("@/contexts/tab-context", () => {
  const getState = () => ({
    activeTabId: mocks.activeTabId,
    tabs: mocks.tabs,
  })
  const useTabStore = (
    selector: (state: ReturnType<typeof getState>) => unknown
  ) => selector(getState())
  useTabStore.getState = getState
  return {
    useTabActions: () => ({ openTab: mocks.openTab }),
    useTabStore,
  }
})
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({
    routeId: "conversations",
    setRoute: vi.fn(),
    openConversations: mocks.openConversations,
    openPluginScreen: mocks.openPluginScreen,
  }),
}))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({ openFilePreview: mocks.openFilePreview }),
  useOptionalWorkspaceActions: () => ({ openBrowserTab: null }),
}))
vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({
    revealInFileTree: mocks.revealInFileTree,
    openPluginPanel: mocks.openPluginPanel,
  }),
  useOptionalAuxPanelContext: () => ({
    revealInFileTree: mocks.revealInFileTree,
    openPluginPanel: mocks.openPluginPanel,
  }),
}))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({
    activeFolderId: mocks.activeFolderId,
    activeFolder:
      mocks.activeFolderId != null
        ? {
            id: mocks.activeFolderId,
            name: `repo-${mocks.activeFolderId}`,
            path: `/repo-${mocks.activeFolderId}`,
            kind: mocks.activeFolderKind,
          }
        : null,
  }),
}))
vi.mock("@/stores/app-workspace-store", () => {
  const getState = () => ({
    conversations: [] as unknown[],
    activeFolderId: mocks.activeFolderId,
    allFolders:
      mocks.activeFolderId != null
        ? [{ id: mocks.activeFolderId, kind: mocks.activeFolderKind }]
        : [],
  })
  const useStore = (
    selector: (state: ReturnType<typeof getState>) => unknown
  ) => selector(getState())
  useStore.getState = getState
  return { useAppWorkspaceStore: useStore }
})
vi.mock("@/hooks/use-file-tree", () => ({
  useFileTree: () => ({
    allFiles: [],
    loading: false,
    reset: mocks.resetFileTree,
  }),
}))
vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}))

import { SearchCommandDialog } from "./search-command-dialog"

function notifyTransportChange() {
  for (const listener of [...mocks.listeners]) {
    listener()
  }
}

function setActiveTab(
  options: {
    conversationId: number | null
    folderId?: number
    isChat?: boolean
  } | null
) {
  if (!options) {
    mocks.activeTabId = null
    mocks.tabs = []
    return
  }
  mocks.activeTabId = "tab-active"
  mocks.tabs = [
    {
      id: "tab-active",
      kind: "conversation",
      folderId: options.folderId ?? 1,
      conversationId: options.conversationId,
      isChat: options.isChat,
    },
  ]
}

function makeCommandPalettePlugin(overrides?: {
  enabled?: boolean
  commands?: InstalledPlugin["manifest"]["contributes"]["commands"]
}): InstalledPlugin {
  return {
    enabled: overrides?.enabled ?? true,
    manifest: {
      id: "codeg.command-palette",
      name: "Command Palette",
      nameTranslations: { es: "Paleta de comandos", "zh-CN": "命令面板" },
      version: "1.0.0",
      client: { entry: "guide.html" },
      server: { entry: "commands.mjs", methods: ["describe-context"] },
      contributes: {
        workspacePanels: [
          {
            id: "notes",
            title: "Workspace Notes",
            view: "text",
            text: "Opened from command.",
          },
        ],
        screens: [{ id: "guide", title: "Command Guide" }],
        hooks: [],
        commands: overrides?.commands ?? [
          {
            id: "open-guide",
            title: "Open Command Guide",
            titleTranslations: {
              es: "Abrir guía de comandos",
              "zh-CN": "打开命令指南",
            },
            description: "See where to use the example commands.",
            descriptionTranslations: {
              es: "Consulta dónde usar los comandos de ejemplo.",
              "zh-CN": "查看示例命令的使用位置。",
            },
            keywords: ["help", "guide", "palette"],
            scope: "global",
            action: { type: "openScreen", screenId: "guide" },
          },
          {
            id: "show-notes",
            title: "Show Workspace Notes",
            titleTranslations: {
              es: "Mostrar notas del espacio de trabajo",
              "zh-CN": "显示工作区备注",
            },
            keywords: ["notes", "panel", "workspace"],
            scope: "workspace",
            action: { type: "openWorkspacePanel", panelId: "notes" },
          },
          {
            id: "check-workspace",
            title: "Check Workspace Context",
            titleTranslations: {
              es: "Comprobar contexto del espacio de trabajo",
              "zh-CN": "检查工作区上下文",
            },
            keywords: ["workspace", "folder", "context"],
            scope: "workspace",
            action: { type: "callMethod", method: "describe-context" },
          },
          {
            id: "check-session",
            title: "Check Session Context",
            titleTranslations: {
              es: "Comprobar contexto de la sesión",
              "zh-CN": "检查会话上下文",
            },
            keywords: ["session", "conversation", "context"],
            scope: "session",
            action: { type: "callMethod", method: "describe-context" },
          },
        ],
      },
    },
  }
}

function createMockTransport(options: {
  initialPlugins: InstalledPlugin[]
  onCallMethod?: (
    params: Record<string, unknown> | undefined
  ) => Promise<unknown>
}) {
  let plugins = options.initialPlugins
  const subscribers = new Map<string, Set<(payload: unknown) => void>>()
  const call = vi.fn(
    async (method: string, params?: Record<string, unknown>) => {
      if (method === "host_plugins_list") return plugins
      if (method === "host_plugins_call") {
        if (options.onCallMethod) return options.onCallMethod(params)
        const input = params?.input as {
          scope?: string
          folderId?: number | null
          conversationId?: number | null
        }
        return `scope=${input.scope},folder=${String(input.folderId)},conv=${String(input.conversationId)}`
      }
      throw new Error(`Unexpected transport call: ${method}`)
    }
  )
  const subscribe = vi.fn(
    async <T,>(channel: string, handler: (payload: T) => void) => {
      let set = subscribers.get(channel)
      if (!set) {
        set = new Set()
        subscribers.set(channel, set)
      }
      const wrapped = handler as (payload: unknown) => void
      set.add(wrapped)
      return () => {
        set?.delete(wrapped)
      }
    }
  )
  const transport: Transport = {
    call: call as Transport["call"],
    subscribe: subscribe as Transport["subscribe"],
    isDesktop: () => false,
  }
  return {
    transport,
    call,
    setPlugins(next: InstalledPlugin[]) {
      plugins = next
      for (const handler of subscribers.get("host-plugins://changed") ?? []) {
        handler(null)
      }
    },
  }
}

function renderPalette(
  open: boolean,
  onOpenChange: (next: boolean) => void,
  locale: "en" | "es" | "zh-CN" = "en"
): ReactElement {
  const messages =
    locale === "es"
      ? esMessages
      : locale === "zh-CN"
        ? zhCnMessages
        : enMessages
  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <SearchCommandDialog open={open} onOpenChange={onOpenChange} />
    </NextIntlClientProvider>
  )
}

describe("Scoped plugin commands in SearchCommandDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState({}, "", "/workspace")
    mocks.transport = null
    mocks.activeRemoteId = null
    mocks.listeners.clear()
    mocks.activeFolderId = 1
    mocks.activeFolderKind = "regular"
    setActiveTab(null)
  })

  afterEach(() => {
    cleanup()
    setActiveTab(null)
  })

  it("filters commands by scope (global/workspace/session), supports keyword search, localizes text, and executes all three action types", async () => {
    const host = createMockTransport({
      initialPlugins: [makeCommandPalettePlugin()],
    })
    mocks.transport = host.transport
    const onOpenChange = vi.fn()
    const user = userEvent.setup()

    // 1) No folder & no saved conversation -> ONLY global command is visible
    mocks.activeFolderId = null
    setActiveTab(null)
    const view = render(renderPalette(true, onOpenChange, "en"))

    const commandsTab = await screen.findByRole("button", {
      name: enMessages.Folder.search.tabCommands,
    })
    await user.click(commandsTab)

    expect(screen.getByText("Open Command Guide")).toBeInTheDocument()
    expect(
      screen.getByText("See where to use the example commands.")
    ).toBeInTheDocument()
    expect(screen.getByText("Global")).toBeInTheDocument()
    expect(screen.queryByText("Show Workspace Notes")).toBeNull()
    expect(screen.queryByText("Check Workspace Context")).toBeNull()
    expect(screen.queryByText("Check Session Context")).toBeNull()

    // 2) Active workspace without saved conversation -> global + workspace commands visible, session hidden
    mocks.activeFolderId = 7
    setActiveTab({ conversationId: null, folderId: 7 })
    view.rerender(renderPalette(true, onOpenChange, "en"))

    expect(await screen.findByText("Show Workspace Notes")).toBeInTheDocument()
    expect(screen.getByText("Check Workspace Context")).toBeInTheDocument()
    expect(screen.queryByText("Check Session Context")).toBeNull()

    // 3) Saved conversation in workspace -> all 4 commands visible
    setActiveTab({ conversationId: 42, folderId: 7 })
    view.rerender(renderPalette(true, onOpenChange, "en"))
    expect(await screen.findByText("Check Session Context")).toBeInTheDocument()
    expect(screen.getByText("Session")).toBeInTheDocument()

    // Keyword search matches "help" (keyword only, not in title/pluginName) -> narrows strictly to Open Command Guide
    const input = screen.getByPlaceholderText(
      enMessages.Folder.search.commandPlaceholder
    )
    await user.type(input, "help")
    expect(screen.getByText("Open Command Guide")).toBeInTheDocument()
    expect(screen.queryByText("Show Workspace Notes")).toBeNull()
    expect(screen.queryByText("Check Session Context")).toBeNull()

    // Execute openScreen
    await user.click(screen.getByText("Open Command Guide"))
    expect(mocks.openPluginScreen).toHaveBeenCalledWith({
      pluginId: "codeg.command-palette",
      screenId: "guide",
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)

    // Clear query & execute openWorkspacePanel
    await user.clear(input)
    await user.click(screen.getByText("Show Workspace Notes"))
    expect(mocks.openConversations).toHaveBeenCalled()
    expect(mocks.openPluginPanel).toHaveBeenCalledWith(
      "codeg.command-palette:notes"
    )

    // Execute callMethod (session scope) -> passes { scope: "session", folderId: 7, conversationId: 42 }
    await user.click(screen.getByText("Check Session Context"))
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Check Session Context", {
        description: "scope=session,folder=7,conv=42",
      })
    })
    expect(host.call).toHaveBeenCalledWith("host_plugins_call", {
      pluginId: "codeg.command-palette",
      method: "describe-context",
      input: { scope: "session", folderId: 7, conversationId: 42 },
    })

    // Folderless chat session sends folderId: null with conversationId: 42 and hides workspace commands
    mocks.activeFolderKind = "chat"
    setActiveTab({ conversationId: 42, folderId: 7, isChat: true })
    view.rerender(renderPalette(true, onOpenChange, "en"))
    expect(screen.queryByText("Show Workspace Notes")).toBeNull()
    expect(screen.queryByText("Check Workspace Context")).toBeNull()
    await user.click(screen.getByText("Check Session Context"))
    await waitFor(() => {
      expect(host.call).toHaveBeenLastCalledWith("host_plugins_call", {
        pluginId: "codeg.command-palette",
        method: "describe-context",
        input: { scope: "session", folderId: null, conversationId: 42 },
      })
    })

    // Localization switches cleanly (es & zh-CN)
    mocks.activeFolderKind = "regular"
    setActiveTab({ conversationId: 42, folderId: 7 })
    view.rerender(renderPalette(true, onOpenChange, "zh-CN"))
    expect(screen.getByText("打开命令指南")).toBeInTheDocument()
    expect(screen.getByText("查看示例命令的使用位置。")).toBeInTheDocument()
    expect(screen.getAllByText("工作区")).toHaveLength(2)

    view.rerender(renderPalette(true, onOpenChange, "es"))
    expect(screen.getByText("Abrir guía de comandos")).toBeInTheDocument()
    expect(
      screen.getByText("Consulta dónde usar los comandos de ejemplo.")
    ).toBeInTheDocument()
  })

  it("drops stale callMethod responses after session/workspace switch, plugin disable, or Transport replacement under same remoteConnectionId", async () => {
    const pending: Array<{
      resolve: (v: unknown) => void
      reject: (err?: unknown) => void
    }> = []
    const makeDeferredHost = (plugins: InstalledPlugin[]) =>
      createMockTransport({
        initialPlugins: plugins,
        onCallMethod: () =>
          new Promise((resolve, reject) => {
            pending.push({ resolve, reject })
          }),
      })

    const plugin = makeCommandPalettePlugin()
    const hostA = makeDeferredHost([plugin])
    const hostB = makeDeferredHost([plugin])

    window.history.replaceState({}, "", "/workspace?remoteConnectionId=5")
    mocks.activeRemoteId = 5
    mocks.transport = hostA.transport
    mocks.activeFolderId = 1
    setActiveTab({ conversationId: 10, folderId: 1 })

    const onOpenChange = vi.fn()
    const view = render(renderPalette(true, onOpenChange, "en"))
    const user = userEvent.setup()

    await user.click(
      await screen.findByRole("button", {
        name: enMessages.Folder.search.tabCommands,
      })
    )

    // 1) Trigger session command -> switch saved conversation 10 -> 20 before settlement -> stale response ignored!
    await user.click(screen.getByText("Check Session Context"))
    expect(pending).toHaveLength(1)
    setActiveTab({ conversationId: 20, folderId: 1 })
    view.rerender(renderPalette(false, onOpenChange, "en"))
    await act(async () => {
      pending[0].resolve("Stale response for conversation 10")
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()

    // 2) Reopen, trigger workspace command -> disable plugin before rejection -> stale error ignored!
    view.rerender(renderPalette(true, onOpenChange, "en"))
    await user.click(
      await screen.findByRole("button", {
        name: enMessages.Folder.search.tabCommands,
      })
    )
    await user.click(screen.getByText("Check Workspace Context"))
    expect(pending).toHaveLength(2)
    act(() => {
      hostA.setPlugins([{ ...plugin, enabled: false }])
    })
    await act(async () => {
      pending[1].reject(new Error("Stale error after disable"))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()

    // 3) Re-enable plugin, trigger command -> replace Transport under SAME remoteConnectionId=5 -> stale response ignored!
    act(() => {
      hostA.setPlugins([plugin])
    })
    view.rerender(renderPalette(true, onOpenChange, "en"))
    await user.click(
      await screen.findByRole("button", {
        name: enMessages.Folder.search.tabCommands,
      })
    )
    await user.click(screen.getByText("Check Workspace Context"))
    expect(pending).toHaveLength(3)
    act(() => {
      mocks.transport = hostB.transport
      notifyTransportChange()
    })
    await act(async () => {
      pending[2].resolve("Stale response from replaced transport")
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()

    // Fresh call on hostB succeeds normally!
    view.rerender(renderPalette(true, onOpenChange, "en"))
    await user.click(
      await screen.findByRole("button", {
        name: enMessages.Folder.search.tabCommands,
      })
    )
    await user.click(screen.getByText("Check Workspace Context"))
    expect(pending).toHaveLength(4)
    await act(async () => {
      pending[3].resolve({ message: "Fresh hostB result" })
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Check Workspace Context", {
      description: "Fresh hostB result",
    })
  })

  it("never queries local transport while a remote window is booting (?remoteConnectionId=N) and supports legacy commands without scope", async () => {
    const localHost = createMockTransport({
      initialPlugins: [makeCommandPalettePlugin()],
    })
    const remoteHost = createMockTransport({
      initialPlugins: [
        makeCommandPalettePlugin({
          commands: [
            {
              id: "legacy-panel",
              title: "Legacy Workspace Panel",
              action: { type: "openWorkspacePanel", panelId: "notes" },
            },
          ],
        }),
      ],
    })

    window.history.replaceState({}, "", "/workspace?remoteConnectionId=11")
    mocks.activeRemoteId = null
    mocks.transport = localHost.transport
    mocks.activeFolderId = 3

    render(renderPalette(true, vi.fn(), "en"))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15))
    })
    expect(localHost.call).not.toHaveBeenCalled()
    expect(
      screen.queryByRole("button", {
        name: enMessages.Folder.search.tabCommands,
      })
    ).toBeNull()

    // Attach remote transport 11 -> legacy command loads with default workspace scope
    act(() => {
      mocks.activeRemoteId = 11
      mocks.transport = remoteHost.transport
      notifyTransportChange()
    })
    const commandsTab = await screen.findByRole("button", {
      name: enMessages.Folder.search.tabCommands,
    })
    expect(localHost.call).not.toHaveBeenCalled()
    fireEvent.click(commandsTab)
    expect(screen.getByText("Legacy Workspace Panel")).toBeInTheDocument()
    expect(screen.getByText("Workspace")).toBeInTheDocument()
  })
})
