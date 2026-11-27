import { useState } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useLocale, useTranslations } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import { WorkspacePluginPanels } from "@/components/layout/workspace-plugin-panels"
import { pluginPanelKey, type InstalledPlugin } from "@/lib/host-plugins"
import { LANGUAGE_SETTINGS_STORAGE_KEY } from "@/lib/i18n"
import type { SystemLanguageSettings } from "@/lib/types"

const api = vi.hoisted(() => ({
  getSystemLanguageSettings: vi.fn<() => Promise<SystemLanguageSettings>>(),
}))
vi.mock("@/lib/api", () => api)

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AppI18nProvider, useAppI18n } from "./i18n-provider"

function renderTabs() {
  render(
    <AppI18nProvider>
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
        </TabsList>
        <TabsContent value="one">Body</TabsContent>
      </Tabs>
    </AppI18nProvider>
  )
}

const tabsRoot = () => screen.getByText("Body").closest('[data-slot="tabs"]')

describe("AppI18nProvider direction", () => {
  afterEach(() => {
    document.documentElement.dir = ""
    window.localStorage.clear()
  })

  // Radix components read their direction from context, not from the page:
  // without a provider a Tabs root stamps `dir="ltr"` on itself, and
  // everything inside it — switches, rows, menus — stays left-to-right in an
  // Arabic window whose page is right-to-left.
  it("hands Radix components the page's right-to-left direction", async () => {
    api.getSystemLanguageSettings.mockResolvedValue({
      mode: "manual",
      language: "ar",
    })
    renderTabs()
    await waitFor(() => expect(tabsRoot()).toHaveAttribute("dir", "rtl"))
    expect(document.documentElement.dir).toBe("rtl")
  })

  it("keeps them left-to-right otherwise", async () => {
    api.getSystemLanguageSettings.mockResolvedValue({
      mode: "manual",
      language: "en",
    })
    renderTabs()
    await waitFor(() => expect(tabsRoot()).toHaveAttribute("dir", "ltr"))
    expect(document.documentElement.dir).toBe("ltr")
  })

  it("gates initial render until the configured initial locale finishes loading, then preserves mounted consumer state across subsequent locale switches", async () => {
    let resolveInitialSettings!: (value: SystemLanguageSettings) => void
    api.getSystemLanguageSettings.mockReturnValue(
      new Promise<SystemLanguageSettings>((resolve) => {
        resolveInitialSettings = resolve
      })
    )

    function StatefulPluginPanelConsumer() {
      const locale = useLocale()
      const tLanguage = useTranslations("Language")
      const { setLanguageSettings } = useAppI18n()
      const [selectedPanel, setSelectedPanel] = useState<string>("closed")

      return (
        <div>
          <span data-testid="active-locale">{locale}</span>
          <span data-testid="spanish-label">{tLanguage("spanish")}</span>
          <span data-testid="selected-panel">{selectedPanel}</span>
          <span data-testid="panel-title">
            {selectedPanel === "notes"
              ? locale === "es"
                ? "Notas"
                : "Notes"
              : "None"}
          </span>
          <button type="button" onClick={() => setSelectedPanel("notes")}>
            Open Notes
          </button>
          <button
            type="button"
            onClick={() =>
              setLanguageSettings({ mode: "manual", language: "es" })
            }
          >
            Switch to Spanish
          </button>
        </div>
      )
    }

    render(
      <AppI18nProvider>
        <StatefulPluginPanelConsumer />
      </AppI18nProvider>
    )

    // Initial boot gate stays active until initial settings + locale messages resolve.
    expect(screen.queryByTestId("selected-panel")).not.toBeInTheDocument()

    resolveInitialSettings({ mode: "manual", language: "en" })

    await waitFor(() => {
      expect(screen.getByTestId("active-locale")).toHaveTextContent("en")
    })
    expect(screen.getByTestId("selected-panel")).toHaveTextContent("closed")

    // User opens a workspace plugin panel (local state inside mounted tree).
    fireEvent.click(screen.getByRole("button", { name: "Open Notes" }))
    expect(screen.getByTestId("selected-panel")).toHaveTextContent("notes")
    expect(screen.getByTestId("panel-title")).toHaveTextContent("Notes")

    // Switching language via storage event from a second tab (Settings -> System)
    // must keep the mounted subtree alive while loading the new locale bundle.
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: LANGUAGE_SETTINGS_STORAGE_KEY,
        newValue: JSON.stringify({ mode: "manual", language: "es" }),
      })
    )

    // Immediately after the storage event, the mounted consumer is still present.
    expect(screen.getByTestId("selected-panel")).toHaveTextContent("notes")

    await waitFor(() => {
      expect(screen.getByTestId("active-locale")).toHaveTextContent("es")
    })
    expect(screen.getByTestId("selected-panel")).toHaveTextContent("notes")
    expect(screen.getByTestId("panel-title")).toHaveTextContent("Notas")

    // Direct in-tab language change also preserves mounted consumer state.
    fireEvent.click(screen.getByRole("button", { name: "Switch to Spanish" }))
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: LANGUAGE_SETTINGS_STORAGE_KEY,
        newValue: JSON.stringify({ mode: "manual", language: "ja" }),
      })
    )
    expect(screen.getByTestId("selected-panel")).toHaveTextContent("notes")

    await waitFor(() => {
      expect(screen.getByTestId("active-locale")).toHaveTextContent("ja")
    })
    expect(screen.getByTestId("selected-panel")).toHaveTextContent("notes")
  })

  it("keeps an opened WorkspacePluginPanels selection mounted and translates Notes to Notas on cross-tab Spanish switch", async () => {
    api.getSystemLanguageSettings.mockResolvedValue({
      mode: "manual",
      language: "en",
    })

    const plugins: InstalledPlugin[] = [
      {
        enabled: true,
        trust: "official",
        installPath: "/plugins/notes",
        manifest: {
          id: "notes",
          name: "Workspace Notes",
          nameTranslations: {
            es: "Notas del espacio",
          },
          version: "1.0.0",
          apiVersion: 1,
          contributes: {
            workspacePanels: [
              {
                id: "overview",
                title: "Overview",
                titleTranslations: { es: "Resumen" },
                view: "text",
                text: "Overview body",
              },
              {
                id: "notes",
                title: "Notes",
                titleTranslations: { es: "Notas" },
                view: "text",
                text: "English note",
                textTranslations: { es: "Nota en español" },
              },
            ],
            commands: [],
          },
        },
      },
    ]

    function WorkspaceHarness() {
      const [activeTab, setActiveTab] = useState<"session_details" | "plugins">(
        "session_details"
      )
      const [selectedPanel, setSelectedPanel] = useState<string | null>(null)

      return (
        <div>
          <button
            type="button"
            onClick={() => {
              setSelectedPanel(pluginPanelKey("notes", "notes"))
              setActiveTab("plugins")
            }}
          >
            Quick Action: Open Notes
          </button>
          {activeTab === "session_details" ? (
            <div data-testid="session-details">Session details</div>
          ) : (
            <WorkspacePluginPanels
              plugins={plugins}
              folderId={1}
              selected={selectedPanel}
              onSelect={setSelectedPanel}
            />
          )}
        </div>
      )
    }

    render(
      <AppI18nProvider>
        <WorkspaceHarness />
      </AppI18nProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId("session-details")).toBeInTheDocument()
    })

    fireEvent.click(
      screen.getByRole("button", { name: "Quick Action: Open Notes" })
    )
    expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument()
    expect(screen.getByText("English note")).toBeInTheDocument()

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: LANGUAGE_SETTINGS_STORAGE_KEY,
        newValue: JSON.stringify({ mode: "manual", language: "es" }),
      })
    )

    await waitFor(() => {
      expect(document.documentElement.lang).toBe("es")
      expect(screen.getByRole("heading", { name: "Notas" })).toBeInTheDocument()
    })
    expect(screen.getByText("Nota en español")).toBeInTheDocument()
    expect(screen.queryByTestId("session-details")).not.toBeInTheDocument()
  })
})
