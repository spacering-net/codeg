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
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import esMessages from "@/i18n/messages/es.json"
import { Sidebar } from "@/components/layout/sidebar"
import {
  WorkbenchRoutePage,
  WorkbenchRouteStrip,
} from "@/components/workbench/workbench-content"
import { HarnessViewProvider } from "@/contexts/harness-view-context"
import {
  WorkbenchRouteProvider,
  useWorkbenchRoute,
} from "@/contexts/workbench-route-context"
import type { InstalledPlugin } from "@/lib/host-plugins"
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

function createPluginTransport(initialPlugins: InstalledPlugin[]) {
  let plugins = initialPlugins
  const subscribers = new Map<string, Set<(payload: unknown) => void>>()

  const call = vi.fn(
    async (method: string, params?: Record<string, unknown>) => {
      if (method === "host_plugins_list") {
        return plugins
      }
      if (method === "host_plugins_client_html") {
        return `<main data-plugin="${String(params?.pluginId ?? "")}">Screen body</main>`
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

function makeNavigationPlugin(
  overrides?: Partial<InstalledPlugin> & {
    version?: string
    clientEntry?: string | null
    screens?: InstalledPlugin["manifest"]["contributes"]["screens"]
    sidebarItems?: InstalledPlugin["manifest"]["contributes"]["sidebarItems"]
  }
): InstalledPlugin {
  return {
    enabled: overrides?.enabled ?? true,
    manifest: {
      id: "codeg.plugin-navigation",
      name: "Plugin Navigation",
      nameTranslations: { es: "Navegación de complementos" },
      version: overrides?.version ?? "1.0.0",
      client:
        overrides?.clientEntry === null
          ? undefined
          : { entry: overrides?.clientEntry ?? "navigation.html" },
      contributes: {
        workspacePanels: [],
        commands: [],
        hooks: [],
        screens: overrides?.screens ?? [
          {
            id: "overview",
            title: "Plugin Overview",
            titleTranslations: { es: "Resumen del complemento" },
          },
          {
            id: "help",
            title: "Plugin Navigation Help",
            titleTranslations: { es: "Ayuda de navegación" },
          },
        ],
        sidebarItems: overrides?.sidebarItems ?? [
          {
            id: "overview",
            title: "Plugin Overview",
            titleTranslations: { es: "Resumen del complemento" },
            placement: "header",
            screenId: "overview",
          },
          {
            id: "help",
            title: "Plugin Navigation Help",
            titleTranslations: { es: "Ayuda de navegación" },
            placement: "footer",
            screenId: "help",
          },
        ],
      },
    },
  }
}

function RouteInspector() {
  const { routeId, isConversations } = useWorkbenchRoute()
  return (
    <div data-testid="route-inspector">
      {routeId}:{String(isConversations)}
    </div>
  )
}

function WorkbenchHarness({
  locale = "en",
}: {
  locale?: "en" | "es"
}): ReactElement {
  const messages = locale === "es" ? esMessages : enMessages
  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <HarnessViewProvider>
        <WorkbenchRouteProvider>
          <RouteInspector />
          <Sidebar />
          <div data-testid="route-strip">
            <WorkbenchRouteStrip />
          </div>
          <div data-testid="route-page">
            <WorkbenchRoutePage />
          </div>
        </WorkbenchRouteProvider>
      </HarnessViewProvider>
    </NextIntlClientProvider>
  )
}

describe("Plugin screens and sidebar header/footer navigation", () => {
  const originalUrl = window.location.pathname + window.location.search

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.transport = null
    mocks.activeRemoteId = null
    mocks.listeners.clear()
    mocks.isMobile = false
    window.history.replaceState({}, "", "/workspace")
  })

  afterEach(() => {
    cleanup()
    window.history.replaceState({}, "", originalUrl || "/")
  })

  it("renders header and footer sidebar entries, navigates to full-page screens, supports localization, mobile collapse, and back-to-conversations", async () => {
    const host = createPluginTransport([makeNavigationPlugin()])
    mocks.transport = host.transport
    window.history.replaceState(
      {},
      "",
      "/workspace?remoteConnectionId=7&remoteWindowId=rw-7"
    )
    mocks.activeRemoteId = 7

    const { rerender } = render(<WorkbenchHarness locale="en" />)

    // Header and footer regions mount while built-in sidebar entries remain usable
    const headerRegion = await screen.findByTestId("sidebar-plugin-header")
    const footerRegion = await screen.findByTestId("sidebar-plugin-footer")
    const overviewBtn = within(headerRegion).getByRole("button", {
      name: "Plugin Overview",
    })
    const helpBtn = within(footerRegion).getByRole("button", {
      name: "Plugin Navigation Help",
    })
    expect(
      screen.getByRole("button", { name: /^New chat/ })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Automations" })
    ).toBeInTheDocument()
    expect(overviewBtn).toHaveAttribute("data-sidebar-placement", "header")
    expect(helpBtn).toHaveAttribute("data-sidebar-placement", "footer")

    // Open header screen -> dedicated full-page route renders HostPluginSurface iframe
    fireEvent.click(overviewBtn)
    expect(screen.getByTestId("route-inspector")).toHaveTextContent(
      "pluginScreen:false"
    )
    expect(overviewBtn).toHaveAttribute("aria-current", "page")

    const page = await screen.findByTestId("host-plugin-screen-page")
    const iframe = (await waitFor(() =>
      within(page).getByTitle("Plugin Overview")
    )) as HTMLIFrameElement
    expect(iframe.getAttribute("srcdoc")).not.toContain("api.composer =")
    expect(
      within(screen.getByTestId("route-strip")).getByRole("heading", {
        name: "Plugin Overview",
      })
    ).toBeInTheDocument()
    expect(window.location.search).toBe(
      "?remoteConnectionId=7&remoteWindowId=rw-7"
    )

    // Switch locale to Spanish -> sidebar items and active screen title localize in place
    rerender(<WorkbenchHarness locale="es" />)
    expect(
      within(screen.getByTestId("sidebar-plugin-header")).getByRole("button", {
        name: "Resumen del complemento",
      })
    ).toHaveAttribute("aria-current", "page")
    expect(
      within(screen.getByTestId("route-strip")).getByRole("heading", {
        name: "Resumen del complemento",
      })
    ).toBeInTheDocument()

    // Mobile mode: clicking footer entry collapses mobile drawer and switches to help screen
    mocks.isMobile = true
    rerender(<WorkbenchHarness locale="en" />)
    fireEvent.click(
      within(screen.getByTestId("sidebar-plugin-footer")).getByRole("button", {
        name: "Plugin Navigation Help",
      })
    )
    expect(mocks.toggleSidebar).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(
        within(screen.getByTestId("host-plugin-screen-page")).getByTitle(
          "Plugin Navigation Help"
        )
      ).toBeInTheDocument()
    })

    // Close / Back to conversations unmounts iframe and preserves remote URL query params
    fireEvent.click(
      within(screen.getByTestId("route-strip")).getByRole("button", {
        name: "Back to Conversations",
      })
    )
    expect(screen.getByTestId("route-inspector")).toHaveTextContent(
      "conversations:true"
    )
    expect(
      screen.queryByTestId("host-plugin-screen-page")
    ).not.toBeInTheDocument()
    expect(window.location.search).toBe(
      "?remoteConnectionId=7&remoteWindowId=rw-7"
    )
  })

  it("unmounts the iframe and returns to conversations on plugin disable, uninstall, or version revocation", async () => {
    const host = createPluginTransport([makeNavigationPlugin()])
    mocks.transport = host.transport

    render(<WorkbenchHarness />)

    fireEvent.click(
      await screen.findByRole("button", { name: "Plugin Overview" })
    )
    await waitFor(() => {
      expect(
        within(screen.getByTestId("host-plugin-screen-page")).getByTitle(
          "Plugin Overview"
        )
      ).toBeInTheDocument()
    })

    // 1) Version update removes the opened screen -> iframe immediately unmounts and route closes
    act(() => {
      host.setPlugins([
        makeNavigationPlugin({
          version: "2.0.0",
          screens: [{ id: "help", title: "Plugin Navigation Help" }],
          sidebarItems: [
            {
              id: "help",
              title: "Plugin Navigation Help",
              placement: "footer",
              screenId: "help",
            },
          ],
        }),
      ])
    })

    await waitFor(() => {
      expect(screen.getByTestId("route-inspector")).toHaveTextContent(
        "conversations:true"
      )
      expect(
        screen.queryByTestId("host-plugin-screen-page")
      ).not.toBeInTheDocument()
    })

    // 2) Open remaining screen, then disable plugin -> iframe unmounts and re-enabling does not auto-reopen
    fireEvent.click(
      await screen.findByRole("button", { name: "Plugin Navigation Help" })
    )
    await waitFor(() => {
      expect(
        within(screen.getByTestId("host-plugin-screen-page")).getByTitle(
          "Plugin Navigation Help"
        )
      ).toBeInTheDocument()
    })

    act(() => {
      host.setPlugins([makeNavigationPlugin({ enabled: false })])
    })

    await waitFor(() => {
      expect(screen.getByTestId("route-inspector")).toHaveTextContent(
        "conversations:true"
      )
      expect(
        screen.queryByTestId("host-plugin-screen-page")
      ).not.toBeInTheDocument()
    })

    // Re-enable -> sidebar entry returns, but screen stays closed until clicked again
    act(() => {
      host.setPlugins([makeNavigationPlugin({ enabled: true })])
    })
    expect(
      await screen.findByRole("button", { name: "Plugin Overview" })
    ).toBeInTheDocument()
    expect(screen.getByTestId("route-inspector")).toHaveTextContent(
      "conversations:true"
    )
  })

  it("never queries a local transport for a booting remote window and immediately withdraws screens on host switch without wrong-host HTML calls", async () => {
    const localHost = createPluginTransport([makeNavigationPlugin()])
    const remoteHost7 = createPluginTransport([
      makeNavigationPlugin({
        screens: [{ id: "remote-dash", title: "Remote Dashboard" }],
        sidebarItems: [
          {
            id: "remote-dash",
            title: "Remote Dashboard",
            placement: "header",
            screenId: "remote-dash",
          },
        ],
      }),
    ])
    const remoteHost9 = createPluginTransport([])

    // Boot remote window ?remoteConnectionId=7 BEFORE remote transport is configured
    window.history.replaceState(
      {},
      "",
      "/workspace?remoteConnectionId=7&remoteWindowId=rw-7"
    )
    mocks.transport = localHost.transport
    mocks.activeRemoteId = null

    render(<WorkbenchHarness />)

    // Must not touch localHost while remoteConnectionId=7 is not configured yet
    expect(localHost.call).not.toHaveBeenCalled()
    expect(
      screen.queryByTestId("sidebar-plugin-header")
    ).not.toBeInTheDocument()

    // Configure remote transport 7
    act(() => {
      mocks.transport = remoteHost7.transport
      mocks.activeRemoteId = 7
      notifyTransportChange()
    })

    const remoteBtn = await screen.findByRole("button", {
      name: "Remote Dashboard",
    })
    expect(localHost.call).not.toHaveBeenCalled()

    // Open remote screen on host 7
    fireEvent.click(remoteBtn)
    await waitFor(() => {
      expect(
        within(screen.getByTestId("host-plugin-screen-page")).getByTitle(
          "Remote Dashboard"
        )
      ).toBeInTheDocument()
    })

    // Switch host to remote host 9 -> iframe immediately unmounts, route closes,
    // and remoteHost9 NEVER receives a host_plugins_client_html call for host 7's plugin
    window.history.replaceState(
      {},
      "",
      "/workspace?remoteConnectionId=9&remoteWindowId=rw-9"
    )
    act(() => {
      mocks.transport = remoteHost9.transport
      mocks.activeRemoteId = 9
      notifyTransportChange()
    })

    await waitFor(() => {
      expect(screen.getByTestId("route-inspector")).toHaveTextContent(
        "conversations:true"
      )
      expect(
        screen.queryByTestId("host-plugin-screen-page")
      ).not.toBeInTheDocument()
    })
    expect(
      remoteHost9.call.mock.calls.filter(
        ([method]) => method === "host_plugins_client_html"
      )
    ).toEqual([])
  })

  it("unmounts the open iframe and refreshes the catalog when the transport instance is replaced under the same remoteConnectionId", async () => {
    const initialTransport7 = createPluginTransport([
      makeNavigationPlugin({
        screens: [{ id: "v1-screen", title: "Connection 7 V1" }],
        sidebarItems: [
          {
            id: "v1-nav",
            title: "Connection 7 V1",
            placement: "header",
            screenId: "v1-screen",
          },
        ],
      }),
    ])
    const reconfiguredTransport7 = createPluginTransport([
      makeNavigationPlugin({
        screens: [{ id: "v2-screen", title: "Connection 7 Reconnected" }],
        sidebarItems: [
          {
            id: "v2-nav",
            title: "Connection 7 Reconnected",
            placement: "header",
            screenId: "v2-screen",
          },
        ],
      }),
    ])

    window.history.replaceState(
      {},
      "",
      "/workspace?remoteConnectionId=7&remoteWindowId=rw-7"
    )
    mocks.transport = initialTransport7.transport
    mocks.activeRemoteId = 7

    render(<WorkbenchHarness />)

    // Open V1 screen on remoteConnectionId=7
    fireEvent.click(
      await screen.findByRole("button", { name: "Connection 7 V1" })
    )
    await waitFor(() => {
      expect(
        within(screen.getByTestId("host-plugin-screen-page")).getByTitle(
          "Connection 7 V1"
        )
      ).toBeInTheDocument()
    })

    // Replace the Transport object under the SAME remoteConnectionId=7 (e.g. token refresh / reconnect)
    act(() => {
      mocks.transport = reconfiguredTransport7.transport
      // activeRemoteId stays 7 and URL stays ?remoteConnectionId=7&remoteWindowId=rw-7
      notifyTransportChange()
    })

    // Old iframe unmounts immediately, route closes, no stale HTML call on new transport,
    // and sidebar updates to the reconfigured transport's catalog
    await waitFor(() => {
      expect(screen.getByTestId("route-inspector")).toHaveTextContent(
        "conversations:true"
      )
      expect(
        screen.queryByTestId("host-plugin-screen-page")
      ).not.toBeInTheDocument()
      expect(
        screen.getByRole("button", { name: "Connection 7 Reconnected" })
      ).toBeInTheDocument()
    })
    expect(
      screen.queryByRole("button", { name: "Connection 7 V1" })
    ).not.toBeInTheDocument()
    expect(
      reconfiguredTransport7.call.mock.calls.filter(
        ([method]) => method === "host_plugins_client_html"
      )
    ).toEqual([])
  })
})
