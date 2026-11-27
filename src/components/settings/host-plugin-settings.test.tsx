import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { type ReactElement } from "react"
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import zhCNMessages from "@/i18n/messages/zh-CN.json"
import type {
  InstalledPlugin,
  PluginHostSurfaceContribution,
  PluginInstallPreview,
  PluginTextTranslations,
} from "@/lib/host-plugins"
import type { Transport } from "@/lib/transport"

const state = vi.hoisted(() => ({
  transport: null as Transport | null,
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => {
    if (!state.transport) throw new Error("mock transport not configured")
    return state.transport
  },
}))

import { HostPluginSettings } from "./host-plugin-settings"

function createSettingsTransport(
  initialPlugins: InstalledPlugin[],
  preview?: PluginInstallPreview
) {
  let plugins = initialPlugins
  const listeners = new Map<string, Set<(payload: unknown) => void>>()

  const call = vi.fn(
    async (method: string, params?: Record<string, unknown>) => {
      if (method === "host_plugins_list") {
        return plugins
      }
      if (method === "host_plugins_client_html") {
        return `<main data-plugin="${String(params?.pluginId ?? "")}">client-ui</main>`
      }
      if (method === "host_plugins_preview_install") {
        if (!preview) throw new Error("No install preview configured")
        return preview
      }
      if (method === "host_plugins_apply") {
        const mutation = params?.mutation as
          | { type: "setEnabled"; id: string; enabled: boolean }
          | { type: "remove"; id: string }
          | undefined
        if (mutation?.type === "setEnabled") {
          plugins = plugins.map((item) =>
            item.manifest.id === mutation.id
              ? { ...item, enabled: mutation.enabled }
              : item
          )
        } else if (mutation?.type === "remove") {
          plugins = plugins.filter((item) => item.manifest.id !== mutation.id)
        }
        return plugins
      }
      throw new Error(`Unexpected RPC call: ${method}`)
    }
  )

  const subscribe = vi.fn(
    async <T,>(channel: string, handler: (payload: T) => void) => {
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      const wrapped = handler as (payload: unknown) => void
      set.add(wrapped)
      return () => {
        set?.delete(wrapped)
      }
    }
  )

  const setPlugins = (next: InstalledPlugin[]) => {
    plugins = next
    for (const handler of listeners.get("host-plugins://changed") ?? []) {
      handler(null)
    }
  }

  return {
    transport: {
      call: call as Transport["call"],
      subscribe: subscribe as Transport["subscribe"],
    },
    call,
    setPlugins,
  }
}

function makePlugin(opts: {
  id: string
  name: string
  nameTranslations?: PluginTextTranslations
  enabled: boolean
  clientEntry?: string | null
  pluginDetail?: PluginHostSurfaceContribution
  activationPanel?: PluginHostSurfaceContribution
  settingsPanel?: PluginHostSurfaceContribution
}): InstalledPlugin {
  return {
    enabled: opts.enabled,
    source: { type: "directory", path: `/plugins/${opts.id}` },
    manifest: {
      id: opts.id,
      name: opts.name,
      nameTranslations: opts.nameTranslations,
      version: "1.2.0",
      client:
        opts.clientEntry === null
          ? undefined
          : { entry: opts.clientEntry ?? "index.html" },
      contributes: {
        workspacePanels: [],
        commands: [],
        hooks: [],
        pluginDetail: opts.pluginDetail,
        activationPanel: opts.activationPanel,
        settingsPanel: opts.settingsPanel,
      },
    },
  }
}

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

describe("HostPluginSettings pluginDetail and activationPanel surfaces", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    state.transport = null
  })

  it("shows pluginDetail and activationPanel only for enabled plugins with client.entry, and never auto-opens on enablement", async () => {
    const mock = createSettingsTransport([
      makePlugin({
        id: "acme.guided",
        name: "Guided Plugin",
        enabled: false,
        pluginDetail: { id: "detail", title: "About Guided Plugin" },
        activationPanel: { id: "setup", title: "Guided Setup" },
        settingsPanel: { id: "prefs", title: "Guided Preferences" },
      }),
      makePlugin({
        id: "acme.no-client",
        name: "Server Only Plugin",
        enabled: true,
        clientEntry: null,
        pluginDetail: { id: "detail", title: "No Client Detail" },
        activationPanel: { id: "setup", title: "No Client Setup" },
      }),
    ])
    state.transport = mock.transport

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(withIntl(<HostPluginSettings />))

    expect(await screen.findByText("Guided Plugin")).toBeInTheDocument()

    // Disabled plugin and plugin without client.entry do not expose triggers
    expect(
      screen.queryByRole("button", { name: "About Guided Plugin" })
    ).toBeNull()
    expect(screen.queryByRole("button", { name: "Guided Setup" })).toBeNull()
    expect(
      screen.queryByRole("button", { name: "Guided Preferences" })
    ).toBeNull()
    expect(
      screen.queryByRole("button", { name: "No Client Detail" })
    ).toBeNull()
    expect(screen.queryByRole("button", { name: "No Client Setup" })).toBeNull()

    // Enabling the plugin reveals triggers but NEVER auto-opens activationPanel or pluginDetail
    await user.click(
      screen.getByRole("switch", { name: "Enable Guided Plugin" })
    )

    const detailButton = await screen.findByRole("button", {
      name: "About Guided Plugin",
    })
    const activationButton = screen.getByRole("button", {
      name: "Guided Setup",
    })
    expect(
      screen.getByRole("button", { name: "Guided Preferences" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("dialog")).toBeNull()

    // Explicitly clicking pluginDetail opens the detail dialog + iframe
    await user.click(detailButton)
    const detailDialog = await screen.findByRole("dialog")
    expect(detailDialog).toHaveTextContent("About Guided Plugin")
    expect(detailDialog).toHaveTextContent("Guided Plugin · Plugin details")
    expect(detailDialog).toHaveTextContent("acme.guided · 1.2.0")
    expect(detailDialog).toHaveTextContent("Client entry · index.html")
    expect(
      await within(detailDialog).findByTitle("About Guided Plugin")
    ).toBeInTheDocument()

    // Close detail dialog, then explicitly click activationPanel
    await user.keyboard("{Escape}")
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
    })

    await user.click(activationButton)
    const activationDialog = await screen.findByRole("dialog")
    expect(activationDialog).toHaveTextContent("Guided Setup")
    expect(activationDialog).toHaveTextContent(
      "Guided Plugin · Activation guide"
    )
    expect(
      await within(activationDialog).findByTitle("Guided Setup")
    ).toBeInTheDocument()
  })

  it("withdraws open pluginDetail or activationPanel dialogs on disable, removal, or host switch without auto-reopening", async () => {
    const plugin = makePlugin({
      id: "acme.lifecycle",
      name: "Lifecycle Plugin",
      enabled: true,
      pluginDetail: { id: "detail", title: "Lifecycle Details" },
      activationPanel: { id: "setup", title: "Lifecycle Setup" },
    })
    const host1 = createSettingsTransport([plugin])
    const host2 = createSettingsTransport([plugin])
    state.transport = host1.transport

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { rerender } = render(withIntl(<HostPluginSettings />))

    // 1) Open activationPanel, then disable plugin -> withdrawn immediately, re-enabling does not auto-reopen
    await user.click(
      await screen.findByRole("button", { name: "Lifecycle Setup" })
    )
    expect(
      await within(await screen.findByRole("dialog")).findByTitle(
        "Lifecycle Setup"
      )
    ).toBeInTheDocument()

    act(() => {
      host1.setPlugins([{ ...plugin, enabled: false }])
    })
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
      expect(
        screen.queryByRole("button", { name: "Lifecycle Setup" })
      ).toBeNull()
    })

    act(() => {
      host1.setPlugins([plugin])
    })
    await screen.findByRole("button", { name: "Lifecycle Setup" })
    expect(screen.queryByRole("dialog")).toBeNull()

    // 2) Open pluginDetail, then switch connected host -> withdrawn
    await user.click(screen.getByRole("button", { name: "Lifecycle Details" }))
    expect(
      await within(await screen.findByRole("dialog")).findByTitle(
        "Lifecycle Details"
      )
    ).toBeInTheDocument()

    state.transport = host2.transport
    rerender(withIntl(<HostPluginSettings />))
    expect(screen.queryByRole("dialog")).toBeNull()

    // 3) Reopen activationPanel on host2, then remove plugin -> withdrawn
    await user.click(
      await screen.findByRole("button", { name: "Lifecycle Setup" })
    )
    expect(
      await within(await screen.findByRole("dialog")).findByTitle(
        "Lifecycle Setup"
      )
    ).toBeInTheDocument()

    await user.keyboard("{Escape}")
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
    })
    await user.click(screen.getByRole("button", { name: "Lifecycle Setup" }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()

    act(() => {
      host2.setPlugins([])
    })
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
      expect(screen.getByText("No plugins installed.")).toBeInTheDocument()
    })
  })

  it("renders the workspace-inspector 1.1.0 example pluginDetail, activationPanel, and settingsPanel surfaces", async () => {
    const manifest = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          "examples/plugins/workspace-inspector/codeg-plugin.json"
        ),
        "utf8"
      )
    ) as InstalledPlugin["manifest"]
    const html = readFileSync(
      resolve(
        process.cwd(),
        "examples/plugins/workspace-inspector/inspector.html"
      ),
      "utf8"
    )
    const mock = createSettingsTransport([
      {
        enabled: true,
        source: {
          type: "directory",
          path: "/examples/plugins/workspace-inspector",
        },
        manifest,
      },
    ])
    mock.call.mockImplementation(async (method: string) => {
      if (method === "host_plugins_list") {
        return [
          {
            enabled: true,
            source: {
              type: "directory",
              path: "/examples/plugins/workspace-inspector",
            },
            manifest,
          },
        ]
      }
      if (method === "host_plugins_client_html") {
        return html
      }
      return null
    })
    state.transport = mock.transport

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(withIntl(<HostPluginSettings />))

    const detailBtn = await screen.findByRole("button", {
      name: "Workspace Inspector Details",
    })
    const activationBtn = screen.getByRole("button", {
      name: "Set Up Workspace Inspector",
    })
    expect(
      screen.getByRole("button", { name: "About Workspace Inspector" })
    ).toBeInTheDocument()

    await user.click(detailBtn)
    const detailDialog = await screen.findByRole("dialog")
    const detailFrame = await within(detailDialog).findByTitle(
      "Workspace Inspector Details"
    )
    expect(detailFrame.getAttribute("srcdoc")).toContain(
      "Scopes: workspacePanel, settingsPanel, pluginDetail, activationPanel, sessionHeader, composer"
    )

    await user.keyboard("{Escape}")
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
    })

    await user.click(activationBtn)
    const activationDialog = await screen.findByRole("dialog")
    const activationFrame = await within(activationDialog).findByTitle(
      "Set Up Workspace Inspector"
    )
    expect(activationFrame.getAttribute("srcdoc")).toContain(
      "Configure the workspace label used across inspector surfaces."
    )
  })

  it("localizes plugin names, install review metadata, and updates an already-open surface on locale switch", async () => {
    const localizedPlugin = makePlugin({
      id: "acme.localized",
      name: "Localized Inspector",
      nameTranslations: {
        zh: "本地化检查器（通用）",
        "zh-CN": "本地化检查器",
      },
      enabled: true,
      pluginDetail: {
        id: "detail",
        title: "Localized Details",
        titleTranslations: {
          zh: "详情（通用）",
          "zh-CN": "本地化详情",
        },
      },
      activationPanel: {
        id: "setup",
        title: "Localized Setup",
        titleTranslations: { "zh-CN": "本地化引导" },
      },
    })
    const preview: PluginInstallPreview = {
      ticket: "ticket-1",
      manifest: localizedPlugin.manifest,
      source: {
        type: "gitHub",
        repository: "acme/localized",
        commit: "1234567890abcdef",
        directory: "plugins/inspector",
      },
    }
    const mock = createSettingsTransport([localizedPlugin], preview)
    state.transport = mock.transport

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { rerender } = render(withIntl(<HostPluginSettings />, "en"))

    expect(await screen.findByText("Localized Inspector")).toBeInTheDocument()
    const detailTrigger = screen.getByRole("button", {
      name: "Localized Details",
    })
    await user.click(detailTrigger)

    const openDialog = await screen.findByRole("dialog")
    expect(openDialog).toHaveTextContent("Localized Details")
    expect(openDialog).toHaveTextContent("Localized Inspector · Plugin details")

    // Switch locale while the detail surface is open -> stays open, updates titles & iframe
    rerender(withIntl(<HostPluginSettings />, "zh-CN", zhCNMessages))

    const updatedDialog = await screen.findByRole("dialog")
    expect(updatedDialog).toHaveTextContent("本地化详情")
    expect(updatedDialog).toHaveTextContent("本地化检查器 · 插件详情")
    expect(updatedDialog).toHaveTextContent("acme.localized · 1.2.0")
    expect(
      await within(updatedDialog).findByTitle("本地化详情")
    ).toBeInTheDocument()

    // Base language fallback (zh-TW -> zh) keeps the dialog open and falls back to "zh"
    rerender(withIntl(<HostPluginSettings />, "zh-TW", zhCNMessages))
    const fallbackDialog = await screen.findByRole("dialog")
    expect(fallbackDialog).toHaveTextContent("详情（通用）")
    expect(fallbackDialog).toHaveTextContent("本地化检查器（通用）")

    // Close surface dialog and verify InstallReview renders localized name + source identity
    await user.keyboard("{Escape}")
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
    })

    rerender(withIntl(<HostPluginSettings />, "zh-CN", zhCNMessages))
    await user.click(screen.getByRole("button", { name: "添加插件" }))
    const sourceInput = await screen.findByPlaceholderText(
      "owner/repo, @scope/package"
    )
    await user.type(sourceInput, "acme/localized")
    await user.click(screen.getByRole("button", { name: "预览安装" }))

    const reviewSection = await screen.findByRole("region", {
      name: "预览安装",
    })
    expect(reviewSection).toHaveTextContent("本地化检查器")
    expect(reviewSection).toHaveTextContent("acme.localized · 1.2.0")
    expect(reviewSection).toHaveTextContent(
      "acme/localized/plugins/inspector#1234567890abcdef"
    )
  })

  it("displays compact services and published events summaries on installed rows and install review, with zero extra DOM when undeclared", async () => {
    const providerManifest = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          "examples/plugins/service-provider/codeg-plugin.json"
        ),
        "utf8"
      )
    ) as InstalledPlugin["manifest"]
    const consumerManifest = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          "examples/plugins/service-consumer/codeg-plugin.json"
        ),
        "utf8"
      )
    ) as InstalledPlugin["manifest"]
    const plainPlugin = makePlugin({
      id: "acme.plain",
      name: "Plain Plugin",
      enabled: false,
    })

    const preview: PluginInstallPreview = {
      ticket: "ticket-consumer",
      manifest: consumerManifest,
      source: {
        type: "directory",
        path: "/examples/plugins/service-consumer",
      },
    }

    const mock = createSettingsTransport(
      [
        {
          enabled: true,
          source: {
            type: "directory",
            path: "/examples/plugins/service-provider",
          },
          manifest: providerManifest,
        },
        {
          enabled: false,
          source: {
            type: "directory",
            path: "/examples/plugins/service-consumer",
          },
          manifest: consumerManifest,
        },
        plainPlugin,
      ],
      preview
    )
    state.transport = mock.transport

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(withIntl(<HostPluginSettings />))

    expect(
      await screen.findByText("Workspace Metrics Provider")
    ).toBeInTheDocument()

    // Provider and consumer rows show compact summaries; plain plugin renders zero extra summary DOM.
    const summaries = document.querySelectorAll(
      '[data-slot="plugin-contracts-summary"]'
    )
    expect(summaries).toHaveLength(2)
    expect(
      screen.getByText("Provides · workspace.metrics v1")
    ).toBeInTheDocument()
    expect(screen.getByText("Requires · workspace.metrics")).toBeInTheDocument()
    expect(
      screen.getByText("Publishes · metrics.summary (workspace)")
    ).toBeInTheDocument()

    // Install review also displays declared service/event contracts.
    await user.click(screen.getByRole("button", { name: "Add Plugin" }))
    const sourceInput = await screen.findByPlaceholderText(
      "owner/repo, @scope/package"
    )
    await user.type(sourceInput, "/examples/plugins/service-consumer")
    await user.click(
      screen.getByRole("button", { name: "Review installation" })
    )

    const reviewSection = await screen.findByRole("region", {
      name: "Review installation",
    })
    expect(reviewSection).toHaveTextContent("Requires · workspace.metrics")
    expect(reviewSection).toHaveTextContent(
      "Publishes · metrics.summary (workspace)"
    )
  })

  it("formats dependency_missing and already_exists errors with service names and conflicting provider ID", async () => {
    const consumerManifest = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          "examples/plugins/service-consumer/codeg-plugin.json"
        ),
        "utf8"
      )
    ) as InstalledPlugin["manifest"]
    const conflictManifest = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          "examples/plugins/service-provider/codeg-plugin.json"
        ),
        "utf8"
      )
    ) as InstalledPlugin["manifest"]
    conflictManifest.id = "acme.metrics-conflict"
    conflictManifest.name = "Conflict Provider"

    const mock = createSettingsTransport([
      { enabled: false, manifest: consumerManifest },
      { enabled: false, manifest: conflictManifest },
    ])
    mock.call.mockImplementation(
      async (method: string, params?: Record<string, unknown>) => {
        if (method === "host_plugins_list") {
          return [
            { enabled: false, manifest: consumerManifest },
            { enabled: false, manifest: conflictManifest },
          ]
        }
        if (method === "host_plugins_apply") {
          const mutation = params?.mutation as { id?: string } | undefined
          if (mutation?.id === "codeg.metrics-consumer") {
            throw {
              code: "dependency_missing",
              message:
                "Plugin services unavailable: workspace.metrics (missing)",
              i18n_key: "errors.hostPluginServicesUnavailable",
              i18n_params: {
                missingServices: "workspace.metrics",
                incompatibleServices: "",
              },
            }
          }
          if (mutation?.id === "acme.metrics-conflict") {
            throw {
              code: "already_exists",
              message:
                "Plugin codeg.metrics-provider already provides service workspace.metrics",
              i18n_key: "errors.hostPluginServiceConflict",
              i18n_params: {
                service: "workspace.metrics",
                providerId: "codeg.metrics-provider",
              },
            }
          }
        }
        return null
      }
    )
    state.transport = mock.transport

    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(withIntl(<HostPluginSettings />))

    await screen.findByText("Workspace Metrics")
    await user.click(
      screen.getByRole("switch", { name: "Enable Workspace Metrics" })
    )
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Required plugin services are unavailable: workspace.metrics."
    )

    await user.click(
      screen.getByRole("switch", { name: "Enable Conflict Provider" })
    )
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Service workspace.metrics is already provided by enabled plugin codeg.metrics-provider."
    )
  })
})
