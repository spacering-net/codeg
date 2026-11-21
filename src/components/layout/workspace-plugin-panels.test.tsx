import { useState, type ReactElement } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import zhCNMessages from "@/i18n/messages/zh-CN.json"
import type { InstalledPlugin } from "@/lib/host-plugins"

vi.mock("@/components/host-plugin-surface", () => ({
  HostPluginSurface: ({
    pluginId,
    title,
  }: {
    pluginId: string
    title: string
  }) => <div data-testid="client-panel-surface">{`${pluginId}:${title}`}</div>,
}))

import { WorkspacePluginPanels } from "./workspace-plugin-panels"

function withIntl(
  ui: ReactElement,
  locale = "en",
  messages: typeof enMessages = enMessages
) {
  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      {ui}
    </NextIntlClientProvider>
  )
}

const PLUGINS: InstalledPlugin[] = [
  {
    enabled: true,
    manifest: {
      id: "acme.panels",
      name: "Workspace Companion",
      nameTranslations: {
        zh: "工作区助手（通用）",
        "zh-CN": "工作区助手",
      },
      version: "1.0.0",
      client: { entry: "panel.html" },
      contributes: {
        workspacePanels: [
          {
            id: "notes",
            view: "text",
            title: "Team Notes",
            titleTranslations: {
              zh: "团队笔记（通用）",
              "zh-CN": "团队笔记",
            },
            text: "Default note body",
            textTranslations: {
              zh: "通用中文正文",
              "zh-CN": "简体中文正文",
            },
          },
          {
            id: "inspector",
            view: "client",
            title: "Live Inspector",
            titleTranslations: {
              zh: "实时检查器（通用）",
              "zh-CN": "实时检查器",
            },
          },
        ],
        commands: [],
        hooks: [],
      },
    },
  },
  {
    enabled: true,
    manifest: {
      id: "acme.plain",
      name: "Plain Plugin",
      version: "1.0.0",
      contributes: {
        workspacePanels: [
          {
            id: "plain-text",
            view: "text",
            title: "Plain Title",
            text: "Plain Body",
          },
        ],
        commands: [],
        hooks: [],
      },
    },
  },
]

function Harness() {
  const [selected, setSelected] = useState<string | null>("acme.panels:notes")
  return (
    <WorkspacePluginPanels
      plugins={PLUGINS}
      folderId={7}
      selected={selected}
      onSelect={setSelected}
    />
  )
}

describe("WorkspacePluginPanels localized contributions", () => {
  afterEach(() => {
    cleanup()
  })

  it("localizes panel titles, text view content, and preserves the selected panel across locale updates", async () => {
    const user = userEvent.setup()
    const { rerender } = render(withIntl(<Harness />, "en"))

    expect(
      screen.getByRole("heading", { name: "Team Notes" })
    ).toBeInTheDocument()
    expect(screen.getByText("Default note body")).toBeInTheDocument()

    // Switch to zh-CN while on the text panel -> updates heading, body, and select options
    rerender(withIntl(<Harness />, "zh-CN", zhCNMessages))
    expect(
      screen.getByRole("heading", { name: "团队笔记" })
    ).toBeInTheDocument()
    expect(screen.getByText("简体中文正文")).toBeInTheDocument()
    expect(
      screen.getByRole("option", { name: "工作区助手 · 团队笔记" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("option", { name: "Plain Plugin · Plain Title" })
    ).toBeInTheDocument()

    // Select the second (client) panel, then switch to zh-TW (base language fallback -> zh)
    await user.selectOptions(
      screen.getByRole("combobox"),
      "acme.panels:inspector"
    )
    expect(screen.getByTestId("client-panel-surface")).toHaveTextContent(
      "acme.panels:实时检查器"
    )

    rerender(withIntl(<Harness />, "zh-TW", zhCNMessages))
    // Selection state (`acme.panels:inspector`) is preserved across locale change
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(
      "acme.panels:inspector"
    )
    expect(
      screen.getByRole("heading", { name: "实时检查器（通用）" })
    ).toBeInTheDocument()
    expect(screen.getByTestId("client-panel-surface")).toHaveTextContent(
      "acme.panels:实时检查器（通用）"
    )
  })
})
