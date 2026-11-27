import { type ReactElement } from "react"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import zhCNMessages from "@/i18n/messages/zh-CN.json"
import type {
  InstalledPlugin,
  PluginTimelineEvent,
  PluginTimelineItem,
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

import { PluginTimelineItems } from "./plugin-timeline-items"

const MESSAGES = {
  en: enMessages,
  "zh-CN": zhCNMessages,
} as const

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
  port1: FakeMessagePort
  port2: FakeMessagePort

  constructor() {
    this.port1 = new FakeMessagePort()
    this.port2 = new FakeMessagePort()
    this.port1.peer = this.port2
    this.port2.peer = this.port1
  }
}

async function connectIframe(iframe: HTMLIFrameElement) {
  const srcDoc = iframe.getAttribute("srcdoc") ?? ""
  const match = srcDoc.match(/const key = "([0-9a-f]+)"/)
  if (!match) throw new Error("Handshake key missing from srcDoc")
  const key = match[1]
  const received: unknown[] = []
  let framePort: FakeMessagePort | null = null

  const fakeWindow = {
    postMessage: (data: unknown, _origin: string, transfer?: unknown[]) => {
      if (
        typeof data === "object" &&
        data !== null &&
        (data as { type?: string }).type === "codeg-plugin-port" &&
        Array.isArray(transfer) &&
        transfer[0] instanceof FakeMessagePort
      ) {
        framePort = transfer[0]
        framePort.onmessage = ({ data: msg }) => {
          received.push(msg)
        }
        framePort.postMessage({ type: "authenticate", key })
      }
    },
  }

  Object.defineProperty(iframe, "contentWindow", {
    configurable: true,
    value: fakeWindow,
  })

  await waitFor(() => {
    if (!framePort) {
      const readyEvent = new Event("message")
      Object.defineProperties(readyEvent, {
        origin: { value: "null" },
        source: { value: fakeWindow },
        data: { value: { type: "codeg-plugin-ready", key } },
      })
      window.dispatchEvent(readyEvent)
    }
    expect(framePort).not.toBeNull()
  })

  return {
    srcDoc,
    received,
    get port() {
      return framePort!
    },
  }
}

function makeReviewPlugin(options?: {
  enabled?: boolean
  includeRenderer?: boolean
}): InstalledPlugin {
  return {
    enabled: options?.enabled ?? true,
    manifest: {
      id: "codeg.timeline-review",
      name: "Timeline Review",
      version: "1.0.0",
      server: { entry: "review.mjs", methods: ["record-review"] },
      client: { entry: "review.html" },
      contributes: {
        workspacePanels: [],
        commands: [],
        hooks: [],
        timelineRenderers:
          options?.includeRenderer === false
            ? []
            : [
                {
                  kind: "review-result",
                  version: 1,
                  title: "Review result",
                  titleTranslations: {
                    es: "Resultado de la revisión",
                    "zh-CN": "审查结果",
                  },
                },
              ],
      },
    },
  }
}

function makeReviewItem(
  overrides?: Partial<PluginTimelineItem>
): PluginTimelineItem {
  return {
    id: "review-result",
    pluginId: "codeg.timeline-review",
    conversationId: 42,
    kind: "review-result",
    version: 1,
    data: { summary: "The review is ready.", status: "passed" },
    updatedAt: "2026-11-21T10:00:00Z",
    ...overrides,
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
  itemsByConversation?: Record<number, PluginTimelineItem[]>
  clientHtml?: string
  onTimelineList?: (
    conversationId: number
  ) => PluginTimelineItem[] | Promise<PluginTimelineItem[]>
}) {
  let plugins = options?.plugins ?? []
  const itemsByConversation = { ...(options?.itemsByConversation ?? {}) }
  const clientHtml = options?.clientHtml ?? "<article>Review UI</article>"
  const subscribers = new Map<string, Set<(payload: unknown) => void>>()
  const calls: Array<{ method: string; params: unknown }> = []

  const transport: Transport = {
    isDesktop: () => false,
    call: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      if (method === "host_plugins_list") {
        return plugins
      }
      if (method === "host_plugins_client_html") {
        return clientHtml
      }
      if (method === "host_plugins_timeline_list") {
        const { conversationId } = params as { conversationId: number }
        if (options?.onTimelineList) {
          return options.onTimelineList(conversationId)
        }
        return itemsByConversation[conversationId] ?? []
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
    setItems(conversationId: number, items: PluginTimelineItem[]) {
      itemsByConversation[conversationId] = items
    },
    emitTimeline(event: PluginTimelineEvent) {
      for (const cb of subscribers.get("host-plugins://timeline") ?? []) {
        cb(event)
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

describe("PluginTimelineItems & HostPluginSurface timelineItem integration", () => {
  const originalMessageChannel = globalThis.MessageChannel

  beforeEach(() => {
    h.transport = null
    h.activeRemoteConnectionId = null
    h.transportListeners.clear()
    window.history.replaceState({}, "", "/")
    globalThis.MessageChannel =
      FakeMessageChannel as unknown as typeof MessageChannel
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    globalThis.MessageChannel = originalMessageChannel
  })

  it("renders zero DOM for drafts and empty saved conversations", async () => {
    const mock = createMockTransport({
      plugins: [makeReviewPlugin()],
      itemsByConversation: { 42: [] },
    })
    h.transport = mock.transport

    const { container, rerender } = renderWithIntl(
      <PluginTimelineItems conversationId={null} />
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.firstChild).toBeNull()
    expect(mock.calls).toHaveLength(0)

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PluginTimelineItems conversationId={42} />
      </NextIntlClientProvider>
    )
    await waitFor(() => {
      expect(
        mock.calls.some((c) => c.method === "host_plugins_timeline_list")
      ).toBe(true)
    })
    expect(container.firstChild).toBeNull()
  })

  it("delivers exact TimelineItemContext without composer/file, restarts iframe on live upsert, and ignores unrelated conversations", async () => {
    const initialItem = makeReviewItem()
    const mock = createMockTransport({
      plugins: [makeReviewPlugin()],
      itemsByConversation: { 42: [initialItem] },
    })
    h.transport = mock.transport

    renderWithIntl(<PluginTimelineItems conversationId={42} />, "zh-CN")

    // Localized zh-CN renderer title and plugin badge
    expect(await screen.findByText("审查结果")).toBeInTheDocument()
    expect(screen.getByText("Timeline Review")).toBeInTheDocument()

    const iframe1 = await screen.findByTitle("审查结果")
    expect(iframe1).toBeInstanceOf(HTMLIFrameElement)

    const conn1 = await connectIframe(iframe1 as HTMLIFrameElement)
    // Strictly no composer or file bridge injected
    expect(conn1.srcDoc).not.toContain("api.composer")
    expect(conn1.srcDoc).not.toContain("api.file")

    expect(conn1.received).toEqual([
      {
        type: "context",
        context: {
          type: "timelineItem",
          kind: "review-result",
          version: 1,
          itemId: "review-result",
          conversationId: 42,
          data: { summary: "The review is ready.", status: "passed" },
          locale: "zh-CN",
        },
      },
    ])
    const deliveredContext = (
      conn1.received[0] as { context: Record<string, unknown> }
    ).context
    expect(Object.keys(deliveredContext).sort()).toEqual([
      "conversationId",
      "data",
      "itemId",
      "kind",
      "locale",
      "type",
      "version",
    ])

    // Port rejects any composer insertion attempt on timelineItem surface
    await act(async () => {
      conn1.port.postMessage({
        id: 1,
        operation: "composer",
        json: JSON.stringify({ type: "insertText", text: "nope" }),
      })
      await Promise.resolve()
    })
    expect(conn1.received[1]).toEqual({
      id: 1,
      ok: false,
      error: "Composer insertion is unavailable",
    })

    // Unrelated conversation event does NOT trigger timeline reload
    const listCallsBefore = mock.calls.filter(
      (c) => c.method === "host_plugins_timeline_list"
    ).length
    act(() => {
      mock.emitTimeline({
        conversationId: 99,
        pluginId: "codeg.timeline-review",
        item: makeReviewItem({ conversationId: 99 }),
      })
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(
      mock.calls.filter((c) => c.method === "host_plugins_timeline_list").length
    ).toBe(listCallsBefore)

    // Live upsert for conversation 42 updates data/updatedAt -> restarts iframe & closes old port
    const updatedItem = makeReviewItem({
      data: { summary: "Updated after changes.", status: "needs-changes" },
      updatedAt: "2026-11-21T10:05:00Z",
    })
    act(() => {
      mock.setItems(42, [updatedItem])
      mock.emitTimeline({
        conversationId: 42,
        pluginId: "codeg.timeline-review",
        item: updatedItem,
      })
    })

    await waitFor(() => {
      expect(conn1.port.peer.closed).toBe(true)
    })

    const iframe2 = screen.getByTitle("审查结果") as HTMLIFrameElement
    expect(iframe2).not.toBe(iframe1)
    const conn2 = await connectIframe(iframe2)
    expect(conn2.received).toEqual([
      {
        type: "context",
        context: {
          type: "timelineItem",
          kind: "review-result",
          version: 1,
          itemId: "review-result",
          conversationId: 42,
          data: { summary: "Updated after changes.", status: "needs-changes" },
          locale: "zh-CN",
        },
      },
    ])
  })

  it("shows a concise fallback card without mounting an iframe when renderer is unavailable", async () => {
    const mock = createMockTransport({
      plugins: [makeReviewPlugin({ enabled: true, includeRenderer: false })],
      itemsByConversation: {
        42: [makeReviewItem({ kind: "review-result", version: 2 })],
      },
    })
    h.transport = mock.transport

    renderWithIntl(<PluginTimelineItems conversationId={42} />, "en")

    expect(
      await screen.findByText(
        "This timeline item cannot be displayed because its plugin renderer is unavailable."
      )
    ).toBeInTheDocument()
    expect(screen.getByText("review-result v2")).toBeInTheDocument()
    expect(screen.getByText("Timeline Review")).toBeInTheDocument()
    expect(document.querySelector("iframe")).toBeNull()
    expect(
      document.querySelector('[data-slot="plugin-timeline-item-unavailable"]')
    ).not.toBeNull()
  })

  it("clears and unmounts on conversation switch, stale response race, plugin disable, remote boot gating, and transport replacement", async () => {
    const slow42 = createDeferred<PluginTimelineItem[]>()
    let defer42 = false

    const mock1 = createMockTransport({
      plugins: [makeReviewPlugin()],
      itemsByConversation: {
        42: [makeReviewItem({ conversationId: 42 })],
        43: [],
      },
      onTimelineList: (convId) => {
        if (convId === 42 && defer42) return slow42.promise
        return convId === 42 ? [makeReviewItem({ conversationId: 42 })] : []
      },
    })
    h.transport = mock1.transport

    const { rerender, container } = renderWithIntl(
      <PluginTimelineItems conversationId={42} />
    )
    const iframe42 = (await screen.findByTitle(
      "Review result"
    )) as HTMLIFrameElement
    const conn42 = await connectIframe(iframe42)

    // Trigger a slow reload on 42, then switch to 43 before it resolves
    defer42 = true
    act(() => {
      mock1.emitTimeline({
        conversationId: 42,
        pluginId: "codeg.timeline-review",
        item: makeReviewItem({ conversationId: 42 }),
      })
    })
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PluginTimelineItems conversationId={43} />
      </NextIntlClientProvider>
    )

    // Immediately unmounts 42's iframe and closes its port
    expect(container.firstChild).toBeNull()
    expect(conn42.port.peer.closed).toBe(true)

    // Late response for 42 MUST be discarded
    await act(async () => {
      slow42.resolve([makeReviewItem({ conversationId: 42 })])
      await Promise.resolve()
    })
    expect(container.firstChild).toBeNull()

    // Remote boot gating: ?remoteConnectionId=9 while activeRemoteConnectionId === null
    window.history.replaceState({}, "", "/?remoteConnectionId=9")
    h.activeRemoteConnectionId = null
    const localMock = createMockTransport({
      plugins: [makeReviewPlugin()],
      itemsByConversation: { 42: [makeReviewItem({ conversationId: 42 })] },
    })
    h.transport = localMock.transport
    act(() => {
      notifyTransportChange()
    })

    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PluginTimelineItems conversationId={42} />
      </NextIntlClientProvider>
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(localMock.calls).toHaveLength(0)
    expect(container.firstChild).toBeNull()

    // Activate remote transport 1 for remoteConnectionId=9
    const staleRemoteRead = createDeferred<PluginTimelineItem[]>()
    let deferRemote1 = false
    const remoteMock1 = createMockTransport({
      plugins: [makeReviewPlugin()],
      onTimelineList: () =>
        deferRemote1
          ? staleRemoteRead.promise
          : [makeReviewItem({ conversationId: 42 })],
    })
    h.activeRemoteConnectionId = 9
    h.transport = remoteMock1.transport
    act(() => {
      notifyTransportChange()
    })

    const remoteIframe1 = (await screen.findByTitle(
      "Review result"
    )) as HTMLIFrameElement
    const remoteConn1 = await connectIframe(remoteIframe1)
    expect(localMock.calls).toHaveLength(0)

    // Start a slow read on remoteMock1, then replace Transport under SAME remoteConnectionId=9
    deferRemote1 = true
    act(() => {
      remoteMock1.emitTimeline({
        conversationId: 42,
        pluginId: "codeg.timeline-review",
        item: makeReviewItem({ conversationId: 42 }),
      })
    })
    const remoteMock2 = createMockTransport({
      plugins: [makeReviewPlugin()],
      itemsByConversation: {
        42: [
          makeReviewItem({
            conversationId: 42,
            data: { summary: "Fresh host", status: "passed" },
            updatedAt: "2026-11-21T11:00:00Z",
          }),
        ],
      },
    })
    h.transport = remoteMock2.transport
    act(() => {
      notifyTransportChange()
    })

    await waitFor(() => {
      expect(remoteConn1.port.peer.closed).toBe(true)
    })

    // Resolve stale response from replaced transport -> must be ignored
    await act(async () => {
      staleRemoteRead.resolve([
        makeReviewItem({
          conversationId: 42,
          data: { summary: "Stale host", status: "needs-changes" },
        }),
      ])
      await Promise.resolve()
    })

    const remoteIframe2 = (await screen.findByTitle(
      "Review result"
    )) as HTMLIFrameElement
    const remoteConn2 = await connectIframe(remoteIframe2)
    expect(
      (remoteConn2.received[0] as { context: { data: unknown } }).context.data
    ).toEqual({ summary: "Fresh host", status: "passed" })

    // Disable plugin via catalog change + timeline conversationId:null invalidation -> unmounts immediately
    act(() => {
      remoteMock2.setItems(42, [])
      remoteMock2.setPlugins([makeReviewPlugin({ enabled: false })])
      remoteMock2.emitTimeline({
        conversationId: null,
        pluginId: "codeg.timeline-review",
        item: null,
      })
    })
    await waitFor(() => {
      expect(container.firstChild).toBeNull()
    })
    expect(remoteConn2.port.peer.closed).toBe(true)
  })
})
