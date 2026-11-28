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
import zhCNMessages from "@/i18n/messages/zh-CN.json"
import { AppearanceProvider } from "@/components/appearance-provider"
import { AppearanceSettings } from "@/components/settings/appearance-settings"
import {
  useCustomStyle,
  usePluginTheme,
  useThemeColor,
} from "@/hooks/use-appearance"
import {
  STORAGE_KEY_CUSTOM_STYLE_SUSPENDED,
  STORAGE_KEY_CUSTOM_THEME,
  STORAGE_KEY_PLUGIN_THEME,
  STORAGE_KEY_THEME_COLOR,
} from "@/lib/appearance-script"
import type { InstalledPlugin } from "@/lib/host-plugins"
import type { Transport } from "@/lib/transport"

const transportState = vi.hoisted(() => ({
  transport: null as Transport | null,
  activeRemoteId: null as number | null,
  listeners: new Set<() => void>(),
}))

vi.mock("next-themes", () => ({
  useTheme: () => ({
    theme: "system",
    resolvedTheme: "light",
    setTheme: vi.fn(),
  }),
}))

vi.mock("@/components/settings/pet-manager-section", () => ({
  PetManagerSection: () => null,
}))
vi.mock("@/components/settings/font-settings-section", () => ({
  FontSettingsSection: () => null,
}))
vi.mock("@/components/settings/workspace-background-section", () => ({
  WorkspaceBackgroundSection: () => null,
}))
vi.mock("@/components/settings/chat-html-settings", () => ({
  ChatHtmlSettingsSection: () => null,
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => {
    if (!transportState.transport) {
      throw new Error("Mock transport not configured")
    }
    return transportState.transport
  },
  getActiveRemoteConnectionId: () => transportState.activeRemoteId,
  subscribeTransportChange: (listener: () => void) => {
    transportState.listeners.add(listener)
    return () => {
      transportState.listeners.delete(listener)
    }
  },
  isDesktop: () => false,
  isRemoteDesktopMode: () => transportState.activeRemoteId !== null,
}))

function notifyMockTransportChanged() {
  for (const listener of transportState.listeners) {
    listener()
  }
}

function createCatalogTransport(initialPlugins: InstalledPlugin[]) {
  let plugins = initialPlugins
  const subscribers = new Map<string, Set<(payload: unknown) => void>>()

  const call = vi.fn(async (method: string) => {
    if (method === "host_plugins_list") {
      return plugins
    }
    return null
  })

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
  }

  return {
    transport,
    call,
    subscribe,
    setPlugins(next: InstalledPlugin[]) {
      plugins = next
      const handlers = subscribers.get("host-plugins://changed")
      if (handlers) {
        for (const handler of handlers) {
          handler(null)
        }
      }
    },
  }
}

function makeThemePlugin(
  overrides?: Partial<InstalledPlugin>
): InstalledPlugin {
  return {
    enabled: overrides?.enabled ?? true,
    manifest: {
      id: "acme.nord",
      name: "Nord Theme Pack",
      nameTranslations: {
        "zh-CN": "北极主题包",
      },
      version: "1.0.0",
      // Theme-only plugin (no client.entry or server.entry)
      contributes: {
        workspacePanels: [],
        commands: [],
        hooks: [],
        themes: [
          {
            id: "arctic",
            title: "Arctic Frost",
            titleTranslations: {
              "zh-CN": "北极霜",
            },
            light: {
              primary: "#1d4ed8",
              background: "#f0f9ff",
              card: "#e0f2fe",
            },
            dark: {
              primary: "#60a5fa",
              background: "#0c4a6e",
              card: "#075985",
            },
          },
          {
            id: "daylight",
            title: "Daylight Only",
            light: {
              primary: "#0284c7",
              background: "#f8fafc",
            },
          },
        ],
      },
      ...overrides?.manifest,
    },
  }
}

function withProviders(ui: ReactElement, locale: "en" | "zh-CN" = "en") {
  const messages = locale === "zh-CN" ? zhCNMessages : enMessages
  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <AppearanceProvider>{ui}</AppearanceProvider>
    </NextIntlClientProvider>
  )
}

function ThemeControllerProbe() {
  const {
    pluginThemes,
    selectedPluginThemeKey,
    activePluginTheme,
    setPluginThemeKey,
  } = usePluginTheme()
  const { themeColor, setThemeColor } = useThemeColor()
  const { setCustomThemeToken, setCustomStyleSuspended, activeTokenOverrides } =
    useCustomStyle()

  return (
    <div>
      <span data-testid="theme-count">{pluginThemes.length}</span>
      <span data-testid="selected-key">{selectedPluginThemeKey ?? "none"}</span>
      <span data-testid="active-key">{activePluginTheme?.key ?? "none"}</span>
      <span data-testid="preset-color">{themeColor}</span>
      <span data-testid="effective-primary">
        {activeTokenOverrides.primary ?? "none"}
      </span>
      {pluginThemes.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => setPluginThemeKey(t.key)}
        >
          select:{t.title}
        </button>
      ))}
      <button type="button" onClick={() => setPluginThemeKey(null)}>
        clear-plugin-theme
      </button>
      <button type="button" onClick={() => setThemeColor("violet")}>
        preset-violet
      </button>
      <button
        type="button"
        onClick={() => setCustomThemeToken("primary", "#ef4444")}
      >
        custom-primary-red
      </button>
      <button
        type="button"
        onClick={() => setCustomThemeToken("primary", null)}
      >
        reset-custom-primary
      </button>
      <button type="button" onClick={() => setCustomStyleSuspended(true)}>
        suspend-style
      </button>
      <button type="button" onClick={() => setCustomStyleSuspended(false)}>
        resume-style
      </button>
    </div>
  )
}

describe("Plugin Themes in AppearanceProvider and AppearanceSettings", () => {
  const originalUrl = window.location.pathname + window.location.search

  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute("style")
    document.documentElement.removeAttribute("data-theme")
    document.documentElement.classList.remove("dark")
    transportState.transport = null
    transportState.activeRemoteId = null
    transportState.listeners.clear()
    window.history.replaceState({}, "", "/settings/appearance")
  })

  afterEach(() => {
    cleanup()
    document.documentElement.removeAttribute("style")
    document.documentElement.removeAttribute("data-theme")
    document.documentElement.classList.remove("dark")
    window.history.replaceState({}, "", originalUrl || "/")
  })

  it("renders enabled plugin themes in Settings -> Appearance, applies tokens only on explicit selection, and switches back to presets without overwriting existing styles", async () => {
    const host = createCatalogTransport([makeThemePlugin()])
    transportState.transport = host.transport
    localStorage.setItem(STORAGE_KEY_THEME_COLOR, "blue")

    render(withProviders(<AppearanceSettings />, "zh-CN"))

    // Localized plugin theme button appears in Settings -> Appearance
    const arcticButton = await screen.findByRole("button", { name: "北极霜" })
    expect(arcticButton).toHaveAttribute("aria-pressed", "false")
    expect(within(arcticButton).getByText("北极主题包")).toBeInTheDocument()

    // Not applied before explicit user click
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      ""
    )

    fireEvent.click(arcticButton)

    await waitFor(() => {
      expect(arcticButton).toHaveAttribute("aria-pressed", "true")
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
        "#1d4ed8"
      )
    })
    expect(
      document.documentElement.style.getPropertyValue("--background")
    ).toBe("#f0f9ff")
    // Preset themeColor in localStorage is untouched
    expect(localStorage.getItem(STORAGE_KEY_THEME_COLOR)).toBe("blue")
    // Custom theme storage is untouched
    expect(localStorage.getItem(STORAGE_KEY_CUSTOM_THEME)).toBeNull()

    // Clicking a preset color clears the plugin theme and activates that preset
    const violetButton = screen.getByRole("button", { name: "Violet" })
    fireEvent.click(violetButton)

    await waitFor(() => {
      expect(arcticButton).toHaveAttribute("aria-pressed", "false")
      expect(violetButton).toHaveAttribute("aria-pressed", "true")
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
        ""
      )
    })
    expect(document.documentElement.getAttribute("data-theme")).toBe("violet")
  })

  it("switches between light and dark palettes automatically and falls back to preset appearance when the active mode palette is absent", async () => {
    const host = createCatalogTransport([makeThemePlugin()])
    transportState.transport = host.transport

    render(withProviders(<ThemeControllerProbe />))

    const selectArctic = await screen.findByRole("button", {
      name: "select:Arctic Frost",
    })
    fireEvent.click(selectArctic)

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
        "#1d4ed8"
      )
      expect(
        document.documentElement.style.getPropertyValue("--background")
      ).toBe("#f0f9ff")
    })

    // Switch to dark mode -> applies dark palette
    act(() => {
      document.documentElement.classList.add("dark")
    })

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
        "#60a5fa"
      )
      expect(
        document.documentElement.style.getPropertyValue("--background")
      ).toBe("#0c4a6e")
    })

    // Select a light-only theme while in dark mode -> falls back to preset appearance ({})
    fireEvent.click(
      screen.getByRole("button", { name: "select:Daylight Only" })
    )

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
        ""
      )
      expect(
        document.documentElement.style.getPropertyValue("--background")
      ).toBe("")
    })

    // Switch back to light mode -> light-only theme's light palette applies
    act(() => {
      document.documentElement.classList.remove("dark")
    })

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
        "#0284c7"
      )
      expect(
        document.documentElement.style.getPropertyValue("--background")
      ).toBe("#f8fafc")
    })
  })

  it("gives user customTheme token overrides precedence over plugin themes and honors safe style mode", async () => {
    const host = createCatalogTransport([makeThemePlugin()])
    transportState.transport = host.transport

    render(withProviders(<ThemeControllerProbe />))

    fireEvent.click(
      await screen.findByRole("button", { name: "select:Arctic Frost" })
    )

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
        "#1d4ed8"
      )
      expect(
        document.documentElement.style.getPropertyValue("--background")
      ).toBe("#f0f9ff")
    })

    // User sets an explicit custom --primary override
    fireEvent.click(screen.getByRole("button", { name: "custom-primary-red" }))

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
        "#ef4444"
      )
    })
    // Non-overridden plugin tokens remain active
    expect(
      document.documentElement.style.getPropertyValue("--background")
    ).toBe("#f0f9ff")
    expect(document.documentElement.style.getPropertyValue("--card")).toBe(
      "#e0f2fe"
    )

    // Suspending custom style (or ?safeStyle=1) suppresses both plugin theme and custom overrides
    fireEvent.click(screen.getByRole("button", { name: "suspend-style" }))

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
        ""
      )
      expect(
        document.documentElement.style.getPropertyValue("--background")
      ).toBe("")
    })
    expect(localStorage.getItem(STORAGE_KEY_CUSTOM_STYLE_SUSPENDED)).toBe("1")

    // Resuming custom style restores merged overrides
    fireEvent.click(screen.getByRole("button", { name: "resume-style" }))

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
        "#ef4444"
      )
      expect(
        document.documentElement.style.getPropertyValue("--background")
      ).toBe("#f0f9ff")
    })

    // Resetting the user's custom --primary falls back to the plugin theme's --primary
    fireEvent.click(
      screen.getByRole("button", { name: "reset-custom-primary" })
    )

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
        "#1d4ed8"
      )
    })
  })

  it("withdraws theme tokens immediately when the plugin is disabled or uninstalled, and restores across restart and cross-window storage events", async () => {
    const host = createCatalogTransport([makeThemePlugin()])
    transportState.transport = host.transport

    const { unmount } = render(withProviders(<ThemeControllerProbe />))

    fireEvent.click(
      await screen.findByRole("button", { name: "select:Arctic Frost" })
    )

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
        "#1d4ed8"
      )
    })

    // Disable plugin -> theme tokens are immediately withdrawn
    act(() => {
      host.setPlugins([makeThemePlugin({ enabled: false })])
    })

    await waitFor(() => {
      expect(screen.getByTestId("active-key")).toHaveTextContent("none")
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
        ""
      )
    })

    // Re-enable plugin -> theme is restored for this host
    act(() => {
      host.setPlugins([makeThemePlugin({ enabled: true })])
    })

    await waitFor(() => {
      expect(screen.getByTestId("active-key")).toHaveTextContent(
        "acme.nord:arctic"
      )
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
        "#1d4ed8"
      )
    })

    // Uninstall plugin -> immediately withdrawn
    act(() => {
      host.setPlugins([])
    })

    await waitFor(() => {
      expect(screen.getByTestId("active-key")).toHaveTextContent("none")
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
        ""
      )
    })

    // Re-install plugin and simulate app restart (unmount + fresh render)
    host.setPlugins([makeThemePlugin({ enabled: true })])
    unmount()
    document.documentElement.removeAttribute("style")

    render(withProviders(<ThemeControllerProbe />))

    await waitFor(() => {
      expect(screen.getByTestId("active-key")).toHaveTextContent(
        "acme.nord:arctic"
      )
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
        "#1d4ed8"
      )
    })

    // Cross-window storage event switches to Daylight Only
    const nextMap = JSON.stringify({ local: "acme.nord:daylight" })
    localStorage.setItem(STORAGE_KEY_PLUGIN_THEME, nextMap)
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: STORAGE_KEY_PLUGIN_THEME,
          newValue: nextMap,
        })
      )
    })

    await waitFor(() => {
      expect(screen.getByTestId("active-key")).toHaveTextContent(
        "acme.nord:daylight"
      )
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
        "#0284c7"
      )
    })
  })

  it("isolates plugin theme selection per host and never queries or applies local plugin themes in a remote window before remote transport is configured", async () => {
    const localHost = createCatalogTransport([makeThemePlugin()])
    const remoteHost7 = createCatalogTransport([
      {
        enabled: true,
        manifest: {
          id: "remote.solar",
          name: "Remote Solar",
          version: "1.0.0",
          contributes: {
            workspacePanels: [],
            commands: [],
            hooks: [],
            themes: [
              {
                id: "amber",
                title: "Solar Amber",
                light: {
                  primary: "#d97706",
                  background: "#fffbeb",
                },
              },
            ],
          },
        },
      },
    ])

    // Local host already has Arctic Frost selected in localStorage
    localStorage.setItem(
      STORAGE_KEY_PLUGIN_THEME,
      JSON.stringify({ local: "acme.nord:arctic" })
    )

    // Remote window boots at ?remoteConnectionId=7 BEFORE RemoteConnectionGate
    // finishes configuring the remote transport (transport still points to localHost,
    // activeRemoteId is still null).
    window.history.replaceState(
      {},
      "",
      "/workspace?remoteConnectionId=7&remoteWindowId=rw-7"
    )
    transportState.transport = localHost.transport
    transportState.activeRemoteId = null

    render(withProviders(<ThemeControllerProbe />))

    // Must NOT call localHost's host_plugins_list or apply localHost's Arctic Frost theme!
    expect(localHost.call).not.toHaveBeenCalled()
    expect(screen.getByTestId("selected-key")).toHaveTextContent("none")
    expect(screen.getByTestId("active-key")).toHaveTextContent("none")
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      ""
    )

    // Now RemoteConnectionGate finishes configuring remote transport for connection 7
    act(() => {
      transportState.transport = remoteHost7.transport
      transportState.activeRemoteId = 7
      notifyMockTransportChanged()
    })

    await waitFor(() => {
      expect(remoteHost7.call).toHaveBeenCalledWith("host_plugins_list")
      expect(screen.getByTestId("theme-count")).toHaveTextContent("1")
    })
    // Local host still never queried, and remote host 7 has no theme selected yet
    expect(localHost.call).not.toHaveBeenCalled()
    expect(screen.getByTestId("selected-key")).toHaveTextContent("none")
    expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
      ""
    )

    // Select Solar Amber on remote host 7
    fireEvent.click(screen.getByRole("button", { name: "select:Solar Amber" }))

    await waitFor(() => {
      expect(screen.getByTestId("active-key")).toHaveTextContent(
        "remote.solar:amber"
      )
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
        "#d97706"
      )
    })

    // Persisted map keeps both "local" and "remote:7" isolated
    expect(
      JSON.parse(localStorage.getItem(STORAGE_KEY_PLUGIN_THEME) ?? "{}")
    ).toEqual({
      local: "acme.nord:arctic",
      "remote:7": "remote.solar:amber",
    })

    // Switching to another remote host (remoteConnectionId=9) immediately withdraws remote:7's colors
    window.history.replaceState(
      {},
      "",
      "/workspace?remoteConnectionId=9&remoteWindowId=rw-9"
    )
    act(() => {
      transportState.activeRemoteId = null
      notifyMockTransportChanged()
    })

    await waitFor(() => {
      expect(screen.getByTestId("active-key")).toHaveTextContent("none")
      expect(document.documentElement.style.getPropertyValue("--primary")).toBe(
        ""
      )
    })
  })
})
