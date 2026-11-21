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
  PluginUsageQueryResult,
} from "@/lib/host-plugins"
import type { Transport } from "@/lib/transport"

const h = vi.hoisted(() => ({
  transport: null as Transport | null,
  activeRemoteConnectionId: null as number | null,
  transportListeners: new Set<() => void>(),
}))

vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => h.activeRemoteConnectionId,
  subscribeTransportChange: (listener: () => void) => {
    h.transportListeners.add(listener)
    return () => {
      h.transportListeners.delete(listener)
    }
  },
  isDesktop: () => false,
  isRemoteDesktopMode: () => false,
  getTransport: () => {
    if (!h.transport) throw new Error("mock transport not configured")
    return h.transport
  },
}))

import { HostPluginSettings } from "./host-plugin-settings"
import { PluginUsageSourcesSection } from "./plugin-usage-sources"

const MESSAGES = {
  en: enMessages,
  "zh-CN": zhCNMessages,
} as const

function makeUsageDemoPlugin(enabled = true): InstalledPlugin {
  return {
    enabled,
    manifest: {
      id: "codeg.usage-demo",
      name: "Usage Demo",
      version: "1.0.0",
      server: { entry: "usage.mjs", methods: ["read-usage"] },
      contributes: {
        workspacePanels: [],
        commands: [],
        hooks: [],
        usageSources: [
          {
            id: "demo-quota",
            title: "Demo quota",
            titleTranslations: {
              es: "Cuota de ejemplo",
              "zh-CN": "示例额度",
            },
            provider: "demo",
            method: "read-usage",
          },
        ],
      },
    },
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createMockTransport(options?: {
  plugins?: InstalledPlugin[]
  onUsageQuery?: (params: {
    pluginId: string
    sourceId: string
    locale?: string
  }) => PluginUsageQueryResult | Promise<PluginUsageQueryResult>
}) {
  let plugins = options?.plugins ?? []
  const subscribers = new Map<string, Set<(payload: unknown) => void>>()
  const calls: Array<{ method: string; params: unknown }> = []

  const transport: Transport = {
    isDesktop: () => false,
    call: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      if (method === "host_plugins_list") {
        return plugins
      }
      if (method === "host_plugins_usage_query") {
        if (!options?.onUsageQuery) return { accounts: [] }
        return options.onUsageQuery(
          params as { pluginId: string; sourceId: string; locale?: string }
        )
      }
      return null
    }) as Transport["call"],
    subscribe: vi.fn(async (event: string, cb: (payload: unknown) => void) => {
      const set = subscribers.get(event) ?? new Set()
      set.add(cb)
      subscribers.set(event, set)
      return () => {
        set.delete(cb)
      }
    }) as Transport["subscribe"],
  }

  return {
    transport,
    calls,
    setPlugins(next: InstalledPlugin[]) {
      plugins = next
      for (const cb of subscribers.get("host-plugins://changed") ?? []) {
        cb(undefined)
      }
    },
  }
}

function notifyTransportChange() {
  for (const listener of h.transportListeners) {
    listener()
  }
}

function renderWithIntl(
  ui: ReactElement,
  locale: keyof typeof MESSAGES = "en"
) {
  return render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      {ui}
    </NextIntlClientProvider>
  )
}

describe("PluginUsageSourcesSection & Settings integration", () => {
  beforeEach(() => {
    h.transport = null
    h.activeRemoteConnectionId = null
    h.transportListeners.clear()
    window.history.replaceState({}, "", "/")
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("renders zero extra DOM in HostPluginSettings when no enabled usageSources exist", async () => {
    const mock = createMockTransport({ plugins: [makeUsageDemoPlugin(false)] })
    h.transport = mock.transport

    renderWithIntl(<HostPluginSettings />)

    expect(await screen.findByText("Usage Demo")).toBeInTheDocument()
    expect(
      document.querySelector('[data-slot="plugin-usage-sources"]')
    ).toBeNull()
    expect(
      mock.calls.some((c) => c.method === "host_plugins_usage_query")
    ).toBe(false)
  })

  it("queries on manual refresh in zh-CN and renders available, unavailable, and error account reports", async () => {
    const queryCalls: unknown[] = []
    const mock = createMockTransport({
      plugins: [makeUsageDemoPlugin(true)],
      onUsageQuery: (params) => {
        queryCalls.push(params)
        return {
          accounts: [
            {
              key: "demo.available",
              label: "示例账号",
              harness: "demo",
              report: {
                status: "available",
                planLabel: "Pro",
                windows: [
                  {
                    id: "five-hour",
                    label: "Five-hour usage",
                    usedPercent: 42.5,
                    resetsAt: "2026-11-21T18:00:00Z",
                  },
                ],
                balances: [
                  {
                    id: "credits",
                    label: "Demo credits",
                    amount: "250",
                    unit: "credits",
                  },
                ],
                details: [
                  { label: "Data source", value: "Illustrative snapshot" },
                ],
              },
            },
            {
              key: "demo.expired",
              label: "Expired account",
              report: {
                status: "unavailable",
                problem: {
                  kind: "expired",
                  detail: "Please sign in again.",
                  expiresAt: "2026-11-20T00:00:00Z",
                },
              },
            },
            {
              key: "demo.rejected",
              report: {
                status: "unavailable",
                problem: {
                  kind: "rejected",
                  detail: "Forbidden by provider",
                  status: 403,
                },
              },
            },
            {
              key: "demo.noquota",
              report: {
                status: "unavailable",
                problem: {
                  kind: "no_quota",
                  detail: "Plan has no usage quota",
                },
              },
            },
            {
              key: "demo.error",
              label: "Broken account",
              report: {
                status: "error",
                error: "Upstream endpoint timed out",
              },
            },
          ],
        }
      },
    })
    h.transport = mock.transport
    const user = userEvent.setup()

    renderWithIntl(<HostPluginSettings />, "zh-CN")

    // Source card renders inside Settings -> Plugins with zh-CN localization
    const section = await waitFor(() => {
      const el = document.querySelector(
        '[data-slot="plugin-usage-sources"]'
      ) as HTMLElement | null
      expect(el).not.toBeNull()
      return el!
    })
    expect(within(section).getByText("用量来源")).toBeInTheDocument()
    expect(within(section).getByText("示例额度")).toBeInTheDocument()
    expect(within(section).getByText("demo")).toBeInTheDocument()

    // Explicit on-demand: no usage query until user clicks Refresh
    expect(queryCalls).toHaveLength(0)

    await user.click(
      within(section).getByRole("button", { name: "刷新 示例额度" })
    )

    await waitFor(() => {
      expect(queryCalls).toEqual([
        {
          pluginId: "codeg.usage-demo",
          sourceId: "demo-quota",
          locale: "zh-CN",
        },
      ])
    })

    // Available report
    const availableCard = section.querySelector(
      '[data-account-key="demo.available"]'
    ) as HTMLElement
    expect(availableCard).not.toBeNull()
    expect(within(availableCard).getByText("示例账号")).toBeInTheDocument()
    expect(within(availableCard).getByText("Pro")).toBeInTheDocument()
    const progress = within(availableCard).getByRole("progressbar", {
      name: "Five-hour usage",
    })
    expect(progress).toHaveAttribute("aria-valuenow", "42.5")
    expect(within(availableCard).getByText("42.5%")).toBeInTheDocument()
    expect(within(availableCard).getByText("250 credits")).toBeInTheDocument()
    expect(
      within(availableCard).getByText("Illustrative snapshot")
    ).toBeInTheDocument()

    // Unavailable reports (expired, rejected + HTTP 403, no_quota)
    const expiredCard = section.querySelector(
      '[data-account-key="demo.expired"]'
    ) as HTMLElement
    expect(within(expiredCard).getByText("凭据已过期")).toBeInTheDocument()
    expect(
      within(expiredCard).getByText("Please sign in again.")
    ).toBeInTheDocument()

    const rejectedCard = section.querySelector(
      '[data-account-key="demo.rejected"]'
    ) as HTMLElement
    expect(within(rejectedCard).getByText("请求被拒绝")).toBeInTheDocument()
    expect(within(rejectedCard).getByText("HTTP 403")).toBeInTheDocument()
    expect(
      within(rejectedCard).getByText("Forbidden by provider")
    ).toBeInTheDocument()

    const noQuotaCard = section.querySelector(
      '[data-account-key="demo.noquota"]'
    ) as HTMLElement
    expect(within(noQuotaCard).getByText("无可用额度")).toBeInTheDocument()

    // Error report
    const errorCard = section.querySelector(
      '[data-account-key="demo.error"]'
    ) as HTMLElement
    expect(within(errorCard).getByRole("alert")).toHaveTextContent(
      "Upstream endpoint timed out"
    )
  })

  it("enforces remote boot gating and discards stale in-flight queries on plugin disable and Transport replacement", async () => {
    // 1. Remote boot gating: ?remoteConnectionId=7 while activeRemoteConnectionId === null
    window.history.replaceState({}, "", "/?remoteConnectionId=7")
    h.activeRemoteConnectionId = null
    const localMock = createMockTransport({
      plugins: [makeUsageDemoPlugin(true)],
    })
    h.transport = localMock.transport
    const user = userEvent.setup()

    const { container } = renderWithIntl(<PluginUsageSourcesSection />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(localMock.calls).toHaveLength(0)
    expect(container.firstChild).toBeNull()

    // 2. Activate remote transport 1 for remoteConnectionId=7
    const deferredQuery1 = createDeferred<PluginUsageQueryResult>()
    const remoteMock1 = createMockTransport({
      plugins: [makeUsageDemoPlugin(true)],
      onUsageQuery: () => deferredQuery1.promise,
    })
    h.activeRemoteConnectionId = 7
    h.transport = remoteMock1.transport
    act(() => {
      notifyTransportChange()
    })

    const refreshBtn = await screen.findByRole("button", {
      name: "Refresh Demo quota",
    })
    expect(localMock.calls).toHaveLength(0)

    // Start in-flight query on remoteMock1, then replace Transport under SAME remoteConnectionId=7
    await user.click(refreshBtn)
    await waitFor(() => {
      expect(
        remoteMock1.calls.some((c) => c.method === "host_plugins_usage_query")
      ).toBe(true)
    })

    const deferredQuery2 = createDeferred<PluginUsageQueryResult>()
    const remoteMock2 = createMockTransport({
      plugins: [makeUsageDemoPlugin(true)],
      onUsageQuery: () => deferredQuery2.promise,
    })
    h.transport = remoteMock2.transport
    act(() => {
      notifyTransportChange()
    })

    // Resolve stale query from replaced transport -> MUST be discarded
    await act(async () => {
      deferredQuery1.resolve({
        accounts: [
          {
            key: "stale.host",
            label: "Stale host account",
            report: { status: "available", windows: [] },
          },
        ],
      })
      await Promise.resolve()
    })
    expect(screen.queryByText("Stale host account")).not.toBeInTheDocument()

    // 3. Start a query on remoteMock2, then disable the plugin -> withdraws card & discards response
    const refreshBtn2 = await screen.findByRole("button", {
      name: "Refresh Demo quota",
    })
    await user.click(refreshBtn2)
    await waitFor(() => {
      expect(
        remoteMock2.calls.some((c) => c.method === "host_plugins_usage_query")
      ).toBe(true)
    })

    act(() => {
      remoteMock2.setPlugins([makeUsageDemoPlugin(false)])
    })
    await waitFor(() => {
      expect(container.firstChild).toBeNull()
    })

    // Late resolution for disabled plugin MUST NOT populate stale data even if re-enabled
    await act(async () => {
      deferredQuery2.resolve({
        accounts: [
          {
            key: "withdrawn.account",
            label: "Withdrawn account",
            report: { status: "available", windows: [] },
          },
        ],
      })
      await Promise.resolve()
    })

    act(() => {
      remoteMock2.setPlugins([makeUsageDemoPlugin(true)])
    })
    await screen.findByRole("button", { name: "Refresh Demo quota" })
    expect(screen.queryByText("Withdrawn account")).not.toBeInTheDocument()
  })
})
