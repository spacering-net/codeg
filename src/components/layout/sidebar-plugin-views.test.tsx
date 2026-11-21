import { type ReactElement } from "react"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import esMessages from "@/i18n/messages/es.json"
import { Sidebar } from "@/components/layout/sidebar"
import { HarnessViewProvider } from "@/contexts/harness-view-context"
import { WorkbenchRouteProvider } from "@/contexts/workbench-route-context"
import type { InstalledPlugin } from "@/lib/host-plugins"
import {
  SIDEBAR_PLUGIN_VIEW_KEY,
  loadSidebarPluginViewMap,
  saveSidebarPluginView,
} from "@/lib/sidebar-view-mode-storage"
import type { Transport } from "@/lib/transport"

const mocks = vi.hoisted(() => ({
  transport: null as Transport | null,
  activeRemoteId: null as number | null,
  listeners: new Set<() => void>(),
  isMobile: false,
  toggleSidebar: vi.fn(),
  openNewConversationTab: vi.fn(),
  openChatModeTab: vi.fn(),
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

vi.mock("@/components/conversations/sidebar-conversation-list", () => ({
  SidebarConversationList: () => <div data-testid="conversation-list" />,
}))
vi.mock("@/components/conversations/conversation-tags-manager", () => ({
  openConversationTagsManager: vi.fn(),
}))
vi.mock("@/contexts/sidebar-context", () => ({
  useSidebarContext: () => ({ isOpen: true, toggle: mocks.toggleSidebar }),
}))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: { id: 1, path: "/repo" } }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({
    openNewConversationTab: mocks.openNewConversationTab,
    openChatModeTab: mocks.openChatModeTab,
  }),
}))
vi.mock("@/contexts/automations-view-context", () => ({
  useAutomationsView: () => ({
    automations: [],
    unseenFailures: 0,
    refetch: async () => {},
  }),
}))
vi.mock("@/contexts/tasks-view-context", () => ({
  useTasksView: () => ({
    tasks: [],
    attentionCount: 0,
    refetch: async () => {},
  }),
}))
vi.mock("@/hooks/use-is-mac", () => ({ useIsMac: () => false }))
vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({ isMac: false, isWindows: false, isLinux: true }),
}))
vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({
    shortcuts: { toggle_search: "mod+k", new_conversation: "mod+t" },
  }),
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mocks.isMobile }))
vi.mock("@/hooks/use-appearance", () => ({
  useZoomLevel: () => ({ zoomLevel: 100, setZoomLevel: () => {} }),
}))

function notifyTransportChange() {
  for (const listener of mocks.listeners) {
    listener()
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class FakeMessagePort {
  onmessage: ((event: { data: unknown }) => void) | null = null
  closed = false
  peer!: FakeMessagePort

  postMessage(data: unknown) {
    if (this.closed) return
    if (this.peer && !this.peer.closed) {
      this.peer.onmessage?.({ data })
    }
  }

  close() {
    this.closed = true
  }
}

class FakeMessageChannel {
  port1 = new FakeMessagePort()
  port2 = new FakeMessagePort()
  constructor() {
    this.port1.peer = this.port2
    this.port2.peer = this.port1
  }
}

function createPluginTransport(
  initialPlugins: InstalledPlugin[],
  options?: {
    listGate?: () => Promise<InstalledPlugin[]>
    htmlLabel?: string
    onSettings?: (request: unknown) => unknown
  }
) {
  let plugins = initialPlugins
  const subscribers = new Map<string, Set<(payload: unknown) => void>>()

  const call = vi.fn(
    async (method: string, params?: Record<string, unknown>) => {
      if (method === "host_plugins_list") {
        if (options?.listGate) return await options.listGate()
        return plugins
      }
      if (method === "host_plugins_client_html") {
        return `<main data-host="${options?.htmlLabel ?? "default"}" data-plugin="${String(params?.pluginId ?? "")}">Notes UI</main>`
      }
      if (method === "host_plugins_settings") {
        if (options?.onSettings) return options.onSettings(params?.request)
        return { revision: 1, value: { note: "Initial note" } }
      }
      return null
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
    subscribe,
    setPlugins(next: InstalledPlugin[]) {
      plugins = next
      for (const handler of subscribers.get("host-plugins://changed") ?? []) {
        handler(null)
      }
    },
  }
}

function makeFocusNotesPlugin(
  overrides?: Partial<InstalledPlugin> & {
    clientEntry?: string | null
    sidebarViews?: InstalledPlugin["manifest"]["contributes"]["sidebarViews"]
  }
): InstalledPlugin {
  return {
    enabled: overrides?.enabled ?? true,
    manifest: {
      id: "codeg.focus-notes",
      name: "Focus Notes",
      nameTranslations: { es: "Notas de enfoque" },
      version: "1.0.0",
      client:
        overrides?.clientEntry === null
          ? undefined
          : { entry: overrides?.clientEntry ?? "notes.html" },
      contributes: {
        workspacePanels: [],
        commands: [],
        hooks: [],
        sidebarViews: overrides?.sidebarViews ?? [
          {
            id: "focus-notes",
            title: "Focus Notes",
            titleTranslations: {
              "zh-CN": "专注笔记",
              es: "Notas de enfoque",
            },
          },
        ],
      },
    },
  }
}

function makeNavPlugin(): InstalledPlugin {
  return {
    enabled: true,
    manifest: {
      id: "codeg.plugin-navigation",
      name: "Plugin Navigation",
      version: "1.0.0",
      client: { entry: "nav.html" },
      contributes: {
        workspacePanels: [],
        commands: [],
        hooks: [],
        screens: [
          { id: "overview", title: "Overview" },
          { id: "help", title: "Help" },
        ],
        sidebarItems: [
          {
            id: "overview",
            title: "Overview",
            placement: "header",
            screenId: "overview",
          },
          {
            id: "help",
            title: "Help",
            placement: "footer",
            screenId: "help",
          },
        ],
      },
    },
  }
}

function renderSidebar(locale: "en" | "es" = "en"): ReturnType<typeof render> {
  const messages = locale === "es" ? esMessages : enMessages
  const tree: ReactElement = (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <HarnessViewProvider>
        <WorkbenchRouteProvider>
          <Sidebar />
        </WorkbenchRouteProvider>
      </HarnessViewProvider>
    </NextIntlClientProvider>
  )
  return render(tree)
}

function extractHandshakeKey(srcDoc: string): string {
  const match = /const key = ("[^"]+");/.exec(srcDoc)
  if (!match) throw new Error("Handshake key not found in srcDoc")
  return JSON.parse(match[1]) as string
}

describe("Sidebar custom plugin views", () => {
  const originalUrl = window.location.pathname + window.location.search
  const OriginalMessageChannel = globalThis.MessageChannel

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.transport = null
    mocks.activeRemoteId = null
    mocks.listeners.clear()
    mocks.isMobile = false
    window.history.replaceState({}, "", "/workspace")
    globalThis.MessageChannel =
      FakeMessageChannel as unknown as typeof MessageChannel
  })

  afterEach(() => {
    cleanup()
    globalThis.MessageChannel = OriginalMessageChannel
    localStorage.clear()
    window.history.replaceState({}, "", originalUrl || "/")
  })

  it("never auto-switches on enable, lets users select a localized sidebar view in View options with sidebarView context/settings bridge, preserves nav and plugin header/footer, and supports desktop + mobile fallback", async () => {
    const host = createPluginTransport([
      makeFocusNotesPlugin(),
      makeNavPlugin(),
    ])
    mocks.transport = host.transport

    const view = renderSidebar("es")

    // Enabling a plugin does NOT auto-switch away from Conversations
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-plugin-header")).toBeTruthy()
      expect(screen.getByTestId("sidebar-plugin-footer")).toBeTruthy()
    })
    expect(screen.getByTestId("conversation-list")).toBeTruthy()
    expect(screen.queryByTestId("sidebar-plugin-view")).toBeNull()

    // Open View options menu -> default Conversations selected, localized Focus Notes offered
    await userEvent.click(
      screen.getByRole("button", {
        name: esMessages.Folder.sidebar.viewOptions,
      })
    )
    const menu = await screen.findByRole("menu")
    expect(
      within(menu).getByRole("menuitemradio", {
        name: esMessages.Folder.sidebar.sidebarViewConversations,
      })
    ).toHaveAttribute("aria-checked", "true")

    await userEvent.click(
      within(menu).getByRole("menuitemradio", { name: "Notas de enfoque" })
    )

    // Sidebar view mounts HostPluginSurface iframe while keeping fixed nav + header/footer intact
    const pluginView = await screen.findByTestId("sidebar-plugin-view")
    expect(screen.queryByTestId("conversation-list")).toBeNull()
    expect(screen.getByTestId("sidebar-plugin-header")).toBeTruthy()
    expect(screen.getByTestId("sidebar-plugin-footer")).toBeTruthy()
    expect(screen.getByText(esMessages.Folder.sidebar.newChat)).toBeTruthy()
    expect(loadSidebarPluginViewMap()).toEqual({
      local: "codeg.focus-notes:focus-notes",
    })

    // Perform real MessagePort handshake to confirm `type: "sidebarView"` context & settings bridge
    const iframe = await waitFor(() => {
      const el = pluginView.querySelector("iframe")
      expect(el).toBeTruthy()
      return el!
    })
    const key = extractHandshakeKey(iframe.getAttribute("srcdoc") ?? "")
    let receivedPort: FakeMessagePort | null = null
    const fakeContentWindow = {
      postMessage: (
        data: { type?: string },
        _origin: string,
        transfer?: unknown[]
      ) => {
        if (data?.type === "codeg-plugin-port" && transfer?.[0]) {
          receivedPort = transfer[0] as FakeMessagePort
        }
      },
    }
    Object.defineProperty(iframe, "contentWindow", {
      value: fakeContentWindow,
      configurable: true,
    })

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "null",
          source: fakeContentWindow as unknown as MessageEventSource,
          data: { type: "codeg-plugin-ready", key },
        })
      )
    })
    expect(receivedPort).not.toBeNull()

    const messages: unknown[] = []
    receivedPort!.onmessage = (ev) => {
      messages.push(ev.data)
    }
    act(() => {
      receivedPort!.postMessage({ type: "authenticate", key })
    })
    expect(messages).toContainEqual({
      type: "context",
      context: {
        type: "sidebarView",
        id: "focus-notes",
        folderId: undefined,
        locale: "es",
      },
    })

    // Settings read over port routes to host_plugins_settings
    await act(async () => {
      receivedPort!.postMessage({
        id: 1,
        operation: "settings",
        json: JSON.stringify({ type: "read" }),
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(host.call).toHaveBeenCalledWith("host_plugins_settings", {
      pluginId: "codeg.focus-notes",
      request: { type: "read" },
    })

    // Desktop fallback via View options menu back to Conversations
    await userEvent.click(
      screen.getByRole("button", {
        name: esMessages.Folder.sidebar.viewOptions,
      })
    )
    const menuAgain = await screen.findByRole("menu")
    await userEvent.click(
      within(menuAgain).getByRole("menuitemradio", {
        name: esMessages.Folder.sidebar.sidebarViewConversations,
      })
    )
    expect(screen.getByTestId("conversation-list")).toBeTruthy()
    expect(screen.queryByTestId("sidebar-plugin-view")).toBeNull()
    expect(loadSidebarPluginViewMap()).toEqual({})

    // Narrow / mobile viewport: select plugin view again and return via inline button without closing Drawer
    mocks.isMobile = true
    view.rerender(
      <NextIntlClientProvider locale="es" messages={esMessages}>
        <HarnessViewProvider>
          <WorkbenchRouteProvider>
            <Sidebar />
          </WorkbenchRouteProvider>
        </HarnessViewProvider>
      </NextIntlClientProvider>
    )
    await userEvent.click(
      screen.getByRole("button", {
        name: esMessages.Folder.sidebar.viewOptions,
      })
    )
    await userEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitemradio", {
        name: "Notas de enfoque",
      })
    )
    expect(await screen.findByTestId("sidebar-plugin-view")).toBeTruthy()

    fireEvent.click(
      screen.getByRole("button", {
        name: esMessages.Folder.sidebar.backToConversations,
      })
    )
    expect(screen.getByTestId("conversation-list")).toBeTruthy()
    expect(screen.queryByTestId("sidebar-plugin-view")).toBeNull()
    expect(mocks.toggleSidebar).not.toHaveBeenCalled()
  })

  it("preserves a valid stored sidebar view preference while catalog is loading or errored and restores once loaded", async () => {
    saveSidebarPluginView("local", "codeg.focus-notes:focus-notes")

    // 1) Pending catalog load must NOT erase stored preference
    const listGate = deferred<InstalledPlugin[]>()
    const host = createPluginTransport([], {
      listGate: () => listGate.promise,
    })
    mocks.transport = host.transport

    renderSidebar("en")

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByTestId("conversation-list")).toBeTruthy()
    expect(localStorage.getItem(SIDEBAR_PLUGIN_VIEW_KEY)).toContain(
      "codeg.focus-notes:focus-notes"
    )

    // Catalog resolves -> saved view automatically restores
    await act(async () => {
      listGate.resolve([makeFocusNotesPlugin()])
      await Promise.resolve()
    })
    expect(await screen.findByTestId("sidebar-plugin-view")).toBeTruthy()

    // 2) Transient catalog error on remount must NOT erase stored preference either
    cleanup()
    const errorHost = createPluginTransport([], {
      listGate: () => Promise.reject(new Error("temporary offline")),
    })
    mocks.transport = errorHost.transport
    renderSidebar("en")

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByTestId("conversation-list")).toBeTruthy()
    expect(loadSidebarPluginViewMap()).toEqual({
      local: "codeg.focus-notes:focus-notes",
    })
  })

  it("gates remote boot, isolates storage per host, unmounts old iframe on same-id transport replacement, and withdraws on disable/remove/contribution removal", async () => {
    saveSidebarPluginView("local", "codeg.focus-notes:focus-notes")
    saveSidebarPluginView("remote:5", "codeg.focus-notes:focus-notes")

    // 1) Remote window booting (?remoteConnectionId=5, activeRemoteId=null):
    // MUST NOT query local transport and MUST NOT clear either host's preference
    window.history.replaceState({}, "", "/workspace?remoteConnectionId=5")
    const localHost = createPluginTransport([makeFocusNotesPlugin()], {
      htmlLabel: "local",
    })
    mocks.transport = localHost.transport
    mocks.activeRemoteId = null

    renderSidebar("en")
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(localHost.call).not.toHaveBeenCalled()
    expect(screen.getByTestId("conversation-list")).toBeTruthy()
    expect(loadSidebarPluginViewMap()).toEqual({
      local: "codeg.focus-notes:focus-notes",
      "remote:5": "codeg.focus-notes:focus-notes",
    })

    // 2) Connect remote transport A for remoteConnectionId=5 -> mounts remote A iframe
    const remoteHostA = createPluginTransport([makeFocusNotesPlugin()], {
      htmlLabel: "remote-a",
    })
    mocks.transport = remoteHostA.transport
    mocks.activeRemoteId = 5
    act(() => {
      notifyTransportChange()
    })

    const iframeA = await waitFor(() => {
      const el = screen
        .getByTestId("sidebar-plugin-view")
        .querySelector("iframe")
      expect(el?.getAttribute("srcdoc")).toContain('data-host="remote-a"')
      return el!
    })
    expect(iframeA).toBeTruthy()

    // 3) Replace Transport under the SAME remoteConnectionId=5 ->
    // old iframe unmounts IMMEDIATELY while catalog loads, preference preserved until new catalog settles
    const remoteBGate = deferred<InstalledPlugin[]>()
    const remoteHostB = createPluginTransport([], {
      listGate: () => remoteBGate.promise,
      htmlLabel: "remote-b",
    })
    mocks.transport = remoteHostB.transport
    mocks.activeRemoteId = 5
    act(() => {
      notifyTransportChange()
    })

    expect(screen.queryByTestId("sidebar-plugin-view")).toBeNull()
    expect(screen.getByTestId("conversation-list")).toBeTruthy()
    expect(loadSidebarPluginViewMap()["remote:5"]).toBe(
      "codeg.focus-notes:focus-notes"
    )

    // Resolve remote B catalog -> mounts fresh iframe bound to remote-b
    let remoteBPlugins = [makeFocusNotesPlugin()]
    remoteHostB.call.mockImplementation(
      async (method: string, params?: Record<string, unknown>) => {
        if (method === "host_plugins_list") return remoteBPlugins
        if (method === "host_plugins_client_html") {
          return `<main data-host="remote-b" data-plugin="${String(params?.pluginId ?? "")}">Notes B</main>`
        }
        return null
      }
    )
    await act(async () => {
      remoteBGate.resolve(remoteBPlugins)
      await Promise.resolve()
    })
    await waitFor(() => {
      const el = screen
        .getByTestId("sidebar-plugin-view")
        .querySelector("iframe")
      expect(el?.getAttribute("srcdoc")).toContain('data-host="remote-b"')
    })

    // 4) Disable plugin -> immediately unmounts iframe, falls back to Conversations,
    // prunes remote:5 stale preference (leaving local untouched!), and re-enabling does NOT auto-switch
    remoteBPlugins = [makeFocusNotesPlugin({ enabled: false })]
    act(() => {
      remoteHostB.setPlugins(remoteBPlugins)
    })
    await waitFor(() => {
      expect(screen.queryByTestId("sidebar-plugin-view")).toBeNull()
      expect(screen.getByTestId("conversation-list")).toBeTruthy()
    })
    expect(loadSidebarPluginViewMap()).toEqual({
      local: "codeg.focus-notes:focus-notes",
    })

    // Re-enable -> MUST stay on Conversations (no auto-switch)
    remoteBPlugins = [makeFocusNotesPlugin({ enabled: true })]
    act(() => {
      remoteHostB.setPlugins(remoteBPlugins)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.queryByTestId("sidebar-plugin-view")).toBeNull()
    expect(screen.getByTestId("conversation-list")).toBeTruthy()

    // 5) Select again, then withdraw sidebarViews contribution (or client.entry) -> immediate unmount & fallback
    await userEvent.click(screen.getByRole("button", { name: "View options" }))
    await userEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitemradio", {
        name: "Focus Notes",
      })
    )
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-plugin-view")).toBeTruthy()
    })

    remoteBPlugins = [makeFocusNotesPlugin({ sidebarViews: [] })]
    act(() => {
      remoteHostB.setPlugins(remoteBPlugins)
    })
    await waitFor(() => {
      expect(screen.queryByTestId("sidebar-plugin-view")).toBeNull()
      expect(screen.getByTestId("conversation-list")).toBeTruthy()
    })
  })
})
