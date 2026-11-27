import { type ReactElement } from "react"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
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
  isChatMode: false,
  isMobile: false,
  isConversations: true,
  openConversations: vi.fn(),
  openPluginScreen: vi.fn(),
  openPluginPanel: vi.fn(),
  toggleAuxPanel: vi.fn(),
  toggleTerminal: vi.fn(),
  toggleSidebar: vi.fn(),
  setSearchOpen: vi.fn(),
  openNewConversationTab: vi.fn(),
  openChatModeTab: vi.fn(),
  openSettingsWindow: vi.fn(() => Promise.resolve()),
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

vi.mock("@/lib/api", () => ({
  openSettingsWindow: mocks.openSettingsWindow,
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => false,
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
          }
        : null,
  }),
}))
vi.mock("@/hooks/use-is-active-chat-mode", () => ({
  useIsActiveChatMode: () => mocks.isChatMode,
}))
vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mocks.isMobile,
}))
vi.mock("@/hooks/use-is-mac", () => ({
  useIsMac: () => false,
}))
vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({ isMac: false, isWindows: false, isLinux: true }),
}))
vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({
    shortcuts: {
      toggle_terminal: "mod+j",
      toggle_aux_panel: "mod+b",
      open_settings: "mod+,",
    },
  }),
}))
vi.mock("@/hooks/use-appearance", () => ({
  useZoomLevel: () => ({ zoomLevel: 100 }),
}))
vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({
    isOpen: false,
    toggle: mocks.toggleAuxPanel,
    openPluginPanel: mocks.openPluginPanel,
  }),
  useOptionalAuxPanelContext: () => ({
    isOpen: false,
    toggle: mocks.toggleAuxPanel,
    openPluginPanel: mocks.openPluginPanel,
  }),
}))
vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => ({
    isOpen: false,
    toggle: mocks.toggleTerminal,
  }),
}))
vi.mock("@/contexts/sidebar-context", () => ({
  useSidebarContext: () => ({
    isOpen: false,
    toggle: mocks.toggleSidebar,
  }),
}))
vi.mock("@/contexts/search-dialog-context", () => ({
  useSearchDialog: () => ({
    setOpen: mocks.setSearchOpen,
  }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({
    openNewConversationTab: mocks.openNewConversationTab,
    openChatModeTab: mocks.openChatModeTab,
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({
    routeId: mocks.isConversations ? "conversations" : "pluginScreen",
    isConversations: mocks.isConversations,
    openConversations: mocks.openConversations,
    openPluginScreen: mocks.openPluginScreen,
  }),
  useOptionalWorkbenchRoute: () => ({
    routeId: mocks.isConversations ? "conversations" : "pluginScreen",
    isConversations: mocks.isConversations,
    openConversations: mocks.openConversations,
    openPluginScreen: mocks.openPluginScreen,
  }),
}))
vi.mock("@/components/workbench/workbench-content", () => ({
  WorkbenchRouteChromeActions: () => null,
}))
vi.mock("./window-controls", () => ({
  WindowControls: () => null,
}))
vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}))

import { FolderTitleBar } from "./folder-title-bar"
import { RightEdgeChrome } from "./right-edge-chrome"
import { resetRightChromeExtraWidthForTests } from "./workspace-header-plugin-actions"

function notifyTransportChange() {
  for (const listener of [...mocks.listeners]) {
    listener()
  }
}

function makeHeaderActionsPlugin(overrides?: {
  enabled?: boolean
  headerActions?: InstalledPlugin["manifest"]["contributes"]["headerActions"]
}): InstalledPlugin {
  return {
    enabled: overrides?.enabled ?? true,
    manifest: {
      id: "codeg.header-actions",
      name: "Workspace Header Actions",
      nameTranslations: {
        es: "Acciones de cabecera",
        "zh-CN": "工作区头部操作",
      },
      version: "1.0.0",
      client: { entry: "actions.html" },
      server: { entry: "actions.mjs", methods: ["describe", "fail"] },
      contributes: {
        workspacePanels: [
          { id: "workspace", title: "Workspace Details", view: "client" },
        ],
        commands: [],
        hooks: [],
        screens: [{ id: "overview", title: "Plugin Overview" }],
        headerActions: overrides?.headerActions ?? [
          {
            id: "show-panel",
            title: "Open Workspace Panel",
            titleTranslations: {
              es: "Abrir panel del espacio de trabajo",
              "zh-CN": "打开工作区面板",
            },
            label: "Workspace",
            labelTranslations: {
              es: "Espacio de trabajo",
              "zh-CN": "工作区",
            },
            action: { type: "openWorkspacePanel", panelId: "workspace" },
          },
          {
            id: "show-overview",
            title: "Open Plugin Overview",
            titleTranslations: {
              es: "Abrir resumen del complemento",
              "zh-CN": "打开插件概览",
            },
            action: { type: "openScreen", screenId: "overview" },
          },
          {
            id: "check-workspace",
            title: "Check Workspace",
            titleTranslations: {
              es: "Comprobar espacio de trabajo",
              "zh-CN": "检查工作区",
            },
            label: "Check",
            labelTranslations: {
              es: "Comprobar",
              "zh-CN": "检查",
            },
            action: { type: "callMethod", method: "describe" },
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
      if (method === "host_plugins_list") {
        return plugins
      }
      if (method === "host_plugins_call") {
        if (options.onCallMethod) {
          return options.onCallMethod(params)
        }
        const folderId = (params?.input as { folderId?: number } | undefined)
          ?.folderId
        return `Workspace #${folderId} is active.`
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

async function openDropdown(trigger: HTMLElement) {
  await act(async () => {
    for (const type of ["pointerdown", "pointerup", "click"]) {
      fireEvent(
        trigger,
        new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function renderWithIntl(
  ui: ReactElement,
  locale: "en" | "es" | "zh-CN" = "en"
) {
  const messages =
    locale === "es"
      ? esMessages
      : locale === "zh-CN"
        ? zhCnMessages
        : enMessages
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("WorkspaceHeaderPluginActions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState({}, "", "/workspace")
    mocks.transport = null
    mocks.activeRemoteId = null
    mocks.listeners.clear()
    mocks.activeFolderId = 1
    mocks.isChatMode = false
    mocks.isMobile = false
    mocks.isConversations = true
    resetRightChromeExtraWidthForTests()
  })

  afterEach(() => {
    cleanup()
    resetRightChromeExtraWidthForTests()
  })

  it("renders up to 2 inline desktop actions before native buttons, folds extras into overflow, executes all three action types, and localizes in place", async () => {
    const host = createMockTransport({
      initialPlugins: [makeHeaderActionsPlugin()],
    })
    mocks.transport = host.transport

    const view = renderWithIntl(<RightEdgeChrome />, "en")

    // First 2 actions render inline: #1 has label "Workspace", #2 has no label (compact icon button)
    const panelBtn = await screen.findByRole("button", {
      name: "Open Workspace Panel",
    })
    expect(panelBtn).toHaveTextContent("Workspace")
    expect(panelBtn).toHaveAttribute("title", "Open Workspace Panel")

    const screenBtn = screen.getByRole("button", {
      name: "Open Plugin Overview",
    })
    expect(screenBtn.textContent).toBe("")
    expect(screenBtn).toHaveAttribute("title", "Open Plugin Overview")

    // Native right-edge buttons remain present and follow the plugin actions
    const settingsBtn = screen.getByTitle(/Settings/)
    expect(
      panelBtn.compareDocumentPosition(settingsBtn) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    // 3rd action ("Check Workspace") is folded into the desktop overflow menu
    expect(screen.queryByRole("button", { name: "Check Workspace" })).toBeNull()
    const overflowBtn = screen.getByRole("button", {
      name: enMessages.HostPlugins.moreHeaderActions,
    })
    expect(overflowBtn).toHaveTextContent("+1")

    // 1) openWorkspacePanel -> switches to conversations + opens right aux panel plugin tab
    fireEvent.click(panelBtn)
    expect(mocks.openConversations).toHaveBeenCalledTimes(1)
    expect(mocks.openPluginPanel).toHaveBeenCalledWith(
      "codeg.header-actions:workspace"
    )

    // 2) openScreen -> opens same-plugin workbench screen
    fireEvent.click(screenBtn)
    expect(mocks.openPluginScreen).toHaveBeenCalledWith({
      pluginId: "codeg.header-actions",
      screenId: "overview",
    })

    // 3) callMethod via overflow menu -> calls host_plugins_call with { folderId: 1 } and shows success toast
    await openDropdown(overflowBtn)
    await act(async () => {
      screen.getByRole("menuitem", { name: /Check Workspace/ }).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(host.call).toHaveBeenCalledWith("host_plugins_call", {
      pluginId: "codeg.header-actions",
      method: "describe",
      input: { folderId: 1 },
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Check Workspace", {
      description: "Workspace #1 is active.",
    })

    // Localization switches cleanly in place (es & zh-CN)
    view.rerender(
      <NextIntlClientProvider locale="es" messages={esMessages}>
        <RightEdgeChrome />
      </NextIntlClientProvider>
    )
    const esPanelBtn = screen.getByRole("button", {
      name: "Abrir panel del espacio de trabajo",
    })
    expect(esPanelBtn).toHaveTextContent("Espacio de trabajo")
    expect(
      screen.getByRole("button", { name: "Abrir resumen del complemento" })
    ).toBeInTheDocument()

    view.rerender(
      <NextIntlClientProvider locale="zh-CN" messages={zhCnMessages}>
        <RightEdgeChrome />
      </NextIntlClientProvider>
    )
    const zhPanelBtn = screen.getByRole("button", { name: "打开工作区面板" })
    expect(zhPanelBtn).toHaveTextContent("工作区")
  })

  it("handles object { message } feedback and error toasts for callMethod, and renders zero DOM without an active folder or in chat mode", async () => {
    let nextResult: { ok: true; value: unknown } | { ok: false; error: Error } =
      {
        ok: true,
        value: { message: "Lint clean in repo-1" },
      }
    const host = createMockTransport({
      initialPlugins: [
        makeHeaderActionsPlugin({
          headerActions: [
            {
              id: "check-workspace",
              title: "Check Workspace",
              label: "Check",
              action: { type: "callMethod", method: "describe" },
            },
          ],
        }),
      ],
      onCallMethod: async () => {
        if (!nextResult.ok) throw nextResult.error
        return nextResult.value
      },
    })
    mocks.transport = host.transport

    const view = renderWithIntl(<RightEdgeChrome />, "en")
    const checkBtn = await screen.findByRole("button", {
      name: "Check Workspace",
    })

    await act(async () => {
      fireEvent.click(checkBtn)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Check Workspace", {
      description: "Lint clean in repo-1",
    })

    nextResult = { ok: false, error: new Error("Server timed out") }
    await act(async () => {
      fireEvent.click(checkBtn)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(mocks.toastError).toHaveBeenCalledWith("Check Workspace failed", {
      description: "Server timed out",
    })

    // Chat mode withdraws plugin header actions completely (zero DOM node)
    mocks.isChatMode = true
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <RightEdgeChrome />
      </NextIntlClientProvider>
    )
    expect(
      document.querySelector('[data-slot="workspace-header-plugin-actions"]')
    ).toBeNull()

    // Folderless state also renders zero DOM node
    mocks.isChatMode = false
    mocks.activeFolderId = null
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <RightEdgeChrome />
      </NextIntlClientProvider>
    )
    expect(
      document.querySelector('[data-slot="workspace-header-plugin-actions"]')
    ).toBeNull()
  })

  it("collapses all header actions into a single overflow menu button on narrow/mobile FolderTitleBar without crowding existing buttons", async () => {
    mocks.isMobile = true
    const host = createMockTransport({
      initialPlugins: [makeHeaderActionsPlugin()],
    })
    mocks.transport = host.transport

    renderWithIntl(<FolderTitleBar />, "en")

    const overflowTrigger = await screen.findByRole("button", {
      name: enMessages.HostPlugins.headerActions,
    })
    // No inline action pills rendered on mobile
    expect(
      screen.queryByRole("button", { name: "Open Workspace Panel" })
    ).toBeNull()
    expect(
      screen.queryByRole("button", { name: "Open Plugin Overview" })
    ).toBeNull()
    expect(screen.queryByRole("button", { name: "Check Workspace" })).toBeNull()

    // Native mobile header buttons stay intact
    expect(
      screen.getByRole("button", {
        name: enMessages.Folder.folderTitleBar.toggleTerminal,
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", {
        name: enMessages.Folder.folderTitleBar.toggleAuxPanel,
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", {
        name: enMessages.Folder.folderTitleBar.openSettings,
      })
    ).toBeInTheDocument()

    // Opening the mobile overflow menu exposes all 3 actions and executes them
    await openDropdown(overflowTrigger)
    expect(
      screen.getByRole("menuitem", { name: /Open Workspace Panel/ })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("menuitem", { name: /Open Plugin Overview/ })
    ).toBeInTheDocument()
    await act(async () => {
      screen.getByRole("menuitem", { name: /Check Workspace/ }).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Check Workspace", {
      description: "Workspace #1 is active.",
    })
  })

  it("silently drops stale callMethod responses after workspace switch, plugin disable/withdrawal, or Transport replacement under the same remoteConnectionId", async () => {
    const pendingResolvers: Array<{
      resolve: (value: unknown) => void
      reject: (reason?: unknown) => void
    }> = []

    const createDeferredHost = (plugins: InstalledPlugin[]) =>
      createMockTransport({
        initialPlugins: plugins,
        onCallMethod: () =>
          new Promise((resolve, reject) => {
            pendingResolvers.push({ resolve, reject })
          }),
      })

    const singleCallPlugin = makeHeaderActionsPlugin({
      headerActions: [
        {
          id: "check-workspace",
          title: "Check Workspace",
          label: "Check",
          action: { type: "callMethod", method: "describe" },
        },
      ],
    })

    const hostA = createDeferredHost([singleCallPlugin])
    const hostB = createDeferredHost([singleCallPlugin])

    window.history.replaceState({}, "", "/workspace?remoteConnectionId=9")
    mocks.activeRemoteId = 9
    mocks.transport = hostA.transport

    const view = renderWithIntl(<RightEdgeChrome />, "en")
    const triggerCheck = async () => {
      const btn = await screen.findByRole("button", { name: "Check Workspace" })
      fireEvent.click(btn)
    }

    // Case 1: Workspace switches from folder 1 -> folder 2 before callMethod resolves
    await triggerCheck()
    expect(pendingResolvers).toHaveLength(1)
    mocks.activeFolderId = 2
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <RightEdgeChrome />
      </NextIntlClientProvider>
    )
    await act(async () => {
      pendingResolvers[0].resolve("Stale response for folder 1")
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()

    // Case 2: Plugin is disabled while callMethod is in-flight -> action withdraws & rejection is silently dropped
    await triggerCheck()
    expect(pendingResolvers).toHaveLength(2)
    act(() => {
      hostA.setPlugins([{ ...singleCallPlugin, enabled: false }])
    })
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Check Workspace" })
      ).toBeNull()
    })
    await act(async () => {
      pendingResolvers[1].reject(new Error("Stale failure after disable"))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()

    // Re-enable plugin on hostA
    act(() => {
      hostA.setPlugins([singleCallPlugin])
    })

    // Case 3: Transport replaced under the SAME remoteConnectionId=9 before callMethod resolves
    await triggerCheck()
    expect(pendingResolvers).toHaveLength(3)
    act(() => {
      mocks.transport = hostB.transport
      notifyTransportChange()
    })
    await act(async () => {
      pendingResolvers[2].resolve("Stale response from old transport")
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()

    // Fresh call on new hostB succeeds normally for active folder 2
    await triggerCheck()
    expect(pendingResolvers).toHaveLength(4)
    await act(async () => {
      pendingResolvers[3].resolve("Fresh response on hostB for folder 2")
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Check Workspace", {
      description: "Fresh response on hostB for folder 2",
    })
  })

  it("never queries local transport while a remote window is booting (?remoteConnectionId=N) and withdraws immediately on host switch", async () => {
    const localHost = createMockTransport({
      initialPlugins: [makeHeaderActionsPlugin()],
    })
    const remoteHost7 = createMockTransport({
      initialPlugins: [
        makeHeaderActionsPlugin({
          headerActions: [
            {
              id: "remote-only",
              title: "Remote Check",
              label: "Remote",
              action: { type: "callMethod", method: "describe" },
            },
          ],
        }),
      ],
    })
    const remoteHost8 = createMockTransport({
      initialPlugins: [],
    })

    // Remote window targeting connection 7 before remote transport attaches
    window.history.replaceState({}, "", "/workspace?remoteConnectionId=7")
    mocks.activeRemoteId = null
    mocks.transport = localHost.transport

    renderWithIntl(<RightEdgeChrome />, "en")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(localHost.call).not.toHaveBeenCalled()
    expect(
      document.querySelector('[data-slot="workspace-header-plugin-actions"]')
    ).toBeNull()

    // Attach remote transport 7 -> loads remote action without touching localHost
    act(() => {
      mocks.activeRemoteId = 7
      mocks.transport = remoteHost7.transport
      notifyTransportChange()
    })
    expect(
      await screen.findByRole("button", { name: "Remote Check" })
    ).toBeInTheDocument()
    expect(localHost.call).not.toHaveBeenCalled()

    // Switch to remote host 8 (no plugins) -> immediately withdraws remote 7 actions
    window.history.replaceState({}, "", "/workspace?remoteConnectionId=8")
    act(() => {
      mocks.activeRemoteId = 8
      mocks.transport = remoteHost8.transport
      notifyTransportChange()
    })
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Remote Check" })).toBeNull()
    })
  })
})
