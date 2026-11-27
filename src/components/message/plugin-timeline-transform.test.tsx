import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { type ReactElement } from "react"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import zhCNMessages from "@/i18n/messages/zh-CN.json"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import type {
  InstalledPlugin,
  TimelineTransformRequest,
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

import { CompletedTurnContent } from "./completed-turn-content"
import { ContentPartsRenderer } from "./content-parts-renderer"
import { PluginTimelineTransformProvider } from "./plugin-timeline-transform"

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

function loadToolOutputCardPlugin(enabled = true): InstalledPlugin {
  const manifestPath = resolve(
    process.cwd(),
    "examples/plugins/tool-output-card/codeg-plugin.json"
  )
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8")
  ) as InstalledPlugin["manifest"]
  return { enabled, manifest }
}

function makeAssistantTransformerPlugin(options?: {
  id?: string
  enabled?: boolean
}): InstalledPlugin {
  const id = options?.id ?? "acme.reply-cards"
  return {
    enabled: options?.enabled ?? true,
    manifest: {
      id,
      name: "Reply Cards",
      version: "1.0.0",
      server: { entry: "server.mjs", methods: ["format-reply"] },
      client: { entry: "card.html" },
      contributes: {
        workspacePanels: [],
        commands: [],
        hooks: [],
        timelineRenderers: [
          {
            kind: "reply-card",
            version: 1,
            title: "Formatted reply",
            titleTranslations: { "zh-CN": "格式化回复" },
          },
        ],
        timelineTransformers: [
          {
            id: "reply-format",
            itemType: "assistant_message",
            rendererKind: "reply-card",
            rendererVersion: 1,
            method: "format-reply",
          },
        ],
      },
    },
  }
}

function makeMockTransport(options?: {
  plugins?: InstalledPlugin[]
  clientHtml?: Record<string, string>
  onTransform?: (request: TimelineTransformRequest) => unknown
}) {
  let plugins = options?.plugins ?? []
  const clientHtml = options?.clientHtml ?? {
    "codeg.tool-output-card": "<div id='test-card'>Tool Output Card</div>",
    "acme.reply-cards": "<div id='reply-card'>Reply Card</div>",
  }
  const listeners = new Map<string, Set<(payload: unknown) => void>>()

  const call = vi.fn(
    async (method: string, params?: Record<string, unknown>) => {
      if (method === "host_plugins_list") {
        return plugins
      }
      if (method === "host_plugins_client_html") {
        const pluginId = String(params?.pluginId ?? "")
        return clientHtml[pluginId] ?? "<div>Plugin Surface</div>"
      }
      if (method === "host_plugins_timeline_transform") {
        if (options?.onTransform) {
          return options.onTransform(
            params as unknown as TimelineTransformRequest
          )
        }
        return { action: "keep" }
      }
      return null
    }
  )

  const subscribe = vi.fn(
    async (event: string, cb: (payload: unknown) => void) => {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(cb)
      return () => {
        set?.delete(cb)
      }
    }
  )

  const transport = {
    call,
    subscribe,
    onReconnect: vi.fn(() => () => {}),
    isConnected: () => true,
  } as unknown as Transport

  return {
    transport,
    call,
    subscribe,
    setPlugins(next: InstalledPlugin[]) {
      plugins = next
      for (const cb of listeners.get("host-plugins://changed") ?? []) {
        cb(null)
      }
    },
  }
}

function renderWithProvider(
  ui: ReactElement,
  options?: {
    locale?: keyof typeof MESSAGES
    conversationId?: number | null
    enabled?: boolean
  }
) {
  const locale = options?.locale ?? "en"
  return render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      <PluginTimelineTransformProvider
        conversationId={
          options?.conversationId === undefined ? 42 : options.conversationId
        }
        enabled={options?.enabled ?? true}
        streamingDebounceMs={0}
      >
        {ui}
      </PluginTimelineTransformProvider>
    </NextIntlClientProvider>
  )
}

function notifyTransportChange() {
  for (const listener of h.transportListeners) {
    listener()
  }
}

describe("Plugin timeline transformers", () => {
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
    globalThis.MessageChannel = originalMessageChannel
  })

  it("makes zero transform RPC calls and leaves native DOM unchanged when no enabled transformers exist", async () => {
    const mock = makeMockTransport({ plugins: [] })
    h.transport = mock.transport

    const parts: AdaptedContentPart[] = [
      {
        type: "tool-call",
        toolCallId: "tc-1",
        toolName: "bash",
        input: JSON.stringify({ command: "cargo test" }),
        state: "output-available",
        output: "test result: ok. 5 passed; 0 failed; 0 ignored",
      },
      { type: "text", text: "All tests passed." },
    ]

    renderWithProvider(
      <ContentPartsRenderer
        parts={parts}
        role="assistant"
        isStreaming={false}
      />
    )

    await waitFor(() => {
      expect(mock.call).toHaveBeenCalledWith("host_plugins_list")
    })

    expect(
      mock.call.mock.calls.filter(
        ([method]) => method === "host_plugins_timeline_transform"
      )
    ).toHaveLength(0)
    expect(
      document.querySelector('[data-slot="plugin-timeline-replacements"]')
    ).toBeNull()
    expect(screen.getByText("All tests passed.")).toBeTruthy()
  })

  it("renders keep, omit, and replace (1..4 cards with fallback index itemId) and ungroups transformed commands", async () => {
    const plugin = loadToolOutputCardPlugin(true)
    const mock = makeMockTransport({
      plugins: [plugin],
      onTransform: (request) => {
        if (request.item.id === "tc-keep") {
          return { action: "keep" }
        }
        if (request.item.id === "tc-omit") {
          return { action: "omit" }
        }
        if (request.item.id === "tc-replace") {
          return {
            action: "replace",
            items: [
              {
                id: "summary",
                kind: "test-result",
                version: 1,
                data: {
                  phase: request.phase,
                  status: "passed",
                  passed: 8,
                  failed: 0,
                },
              },
              {
                kind: "test-result",
                version: 1,
                data: {
                  phase: request.phase,
                  status: "failed",
                  passed: 2,
                  failed: 1,
                },
              },
            ],
          }
        }
        return null
      },
    })
    h.transport = mock.transport

    const parts: AdaptedContentPart[] = [
      {
        type: "tool-call",
        toolCallId: "tc-keep",
        toolName: "bash",
        input: JSON.stringify({ command: "git status" }),
        state: "output-available",
        output: "nothing to commit",
      },
      {
        type: "tool-call",
        toolCallId: "tc-omit",
        toolName: "bash",
        input: JSON.stringify({ command: "cargo test --doc" }),
        state: "output-available",
        output: "test result: ok. 0 passed; 0 failed",
      },
      {
        type: "tool-call",
        toolCallId: "tc-replace",
        toolName: "bash",
        input: JSON.stringify({ command: "cargo test" }),
        state: "output-available",
        output: JSON.stringify({
          kind: "test-summary",
          passed: 8,
          failed: 0,
        }),
      },
    ]

    renderWithProvider(
      <ContentPartsRenderer
        parts={parts}
        role="assistant"
        isStreaming={false}
      />,
      { locale: "zh-CN", conversationId: 42 }
    )

    // Both replacement cards render with localized title and stable itemIds ("summary" and "1").
    const cards = await waitFor(() => {
      const nodes = document.querySelectorAll(
        '[data-slot="plugin-timeline-replacement-card"]'
      )
      expect(nodes).toHaveLength(2)
      return nodes
    })
    expect(cards[0]?.getAttribute("data-item-id")).toBe("summary")
    expect(cards[1]?.getAttribute("data-item-id")).toBe("1")
    expect(screen.getAllByText("测试结果")).toHaveLength(2)

    // The kept command stands alone (not folded with the omitted/replaced commands).
    expect(screen.getByText("git status")).toBeTruthy()
    expect(screen.queryByText("cargo test --doc")).toBeNull()

    // Structured JSON rawOutput was parsed and forwarded cleanly on the wire.
    const replaceCall = mock.call.mock.calls.find(
      ([method, params]) =>
        method === "host_plugins_timeline_transform" &&
        (params as unknown as TimelineTransformRequest).item.id === "tc-replace"
    )
    expect(replaceCall?.[1]).toMatchObject({
      pluginId: "codeg.tool-output-card",
      transformerId: "test-output",
      itemType: "tool_call",
      phase: "complete",
      conversationId: 42,
      locale: "zh-CN",
      item: {
        id: "tc-replace",
        toolName: "bash",
        status: "completed",
        rawInput: { command: "cargo test" },
        rawOutput: { kind: "test-summary", passed: 8, failed: 0 },
      },
    })

    // Connect both iframes and verify timelineItem context payloads.
    const iframes = await screen.findAllByTitle("测试结果")
    const firstConn = await connectIframe(iframes[0] as HTMLIFrameElement)
    const secondConn = await connectIframe(iframes[1] as HTMLIFrameElement)

    await waitFor(() => {
      expect(firstConn.received).toContainEqual({
        type: "context",
        context: {
          type: "timelineItem",
          kind: "test-result",
          version: 1,
          itemId: "summary",
          conversationId: 42,
          data: { phase: "complete", status: "passed", passed: 8, failed: 0 },
          locale: "zh-CN",
        },
      })
      expect(secondConn.received).toContainEqual({
        type: "context",
        context: {
          type: "timelineItem",
          kind: "test-result",
          version: 1,
          itemId: "1",
          conversationId: 42,
          data: { phase: "complete", status: "failed", passed: 2, failed: 1 },
          locale: "zh-CN",
        },
      })
    })
  })

  it("integrates with examples/plugins/tool-output-card transform.mjs across streaming -> complete with stable card node and nullable draft conversationId", async () => {
    const plugin = loadToolOutputCardPlugin(true)
    const transformModule = await import(
      resolve(process.cwd(), "examples/plugins/tool-output-card/transform.mjs")
    )

    const mock = makeMockTransport({
      plugins: [plugin],
      onTransform: (request) =>
        transformModule.handle(
          "transform-tests",
          {
            transformerId: request.transformerId,
            itemType: request.itemType,
            phase: request.phase,
            conversationId: request.conversationId ?? null,
            locale: request.locale ?? "en",
            item: request.item,
          },
          { showEmptySuites: false }
        ),
    })
    h.transport = mock.transport

    const streamingParts: AdaptedContentPart[] = [
      {
        type: "tool-call",
        toolCallId: "tc-live",
        toolName: "test-runner",
        input: JSON.stringify({ suite: "unit" }),
        state: "input-available",
        output: "test result: ok. 2 passed; 0 failed; 0 ignored",
      },
    ]

    const { rerender } = renderWithProvider(
      <ContentPartsRenderer
        parts={streamingParts}
        role="assistant"
        isStreaming={true}
      />,
      { conversationId: null }
    )

    const cardBefore = await waitFor(() => {
      const node = document.querySelector(
        '[data-slot="plugin-timeline-replacement-card"]'
      )
      expect(node).not.toBeNull()
      return node!
    })
    const iframeStreaming = (await screen.findByTitle(
      "Test result"
    )) as HTMLIFrameElement
    const streamConn = await connectIframe(iframeStreaming)
    await waitFor(() => {
      expect(streamConn.received).toContainEqual({
        type: "context",
        context: {
          type: "timelineItem",
          kind: "test-result",
          version: 1,
          itemId: "summary",
          conversationId: null,
          data: { phase: "streaming", status: "running", passed: 2, failed: 0 },
          locale: "en",
        },
      })
    })

    // Transition the same tool call from streaming -> complete.
    const completeParts: AdaptedContentPart[] = [
      {
        type: "tool-call",
        toolCallId: "tc-live",
        toolName: "test-runner",
        input: JSON.stringify({ suite: "unit" }),
        state: "output-available",
        output: "test result: ok. 5 passed; 0 failed; 0 ignored",
      },
    ]

    rerender(
      <NextIntlClientProvider locale="en" messages={MESSAGES.en}>
        <PluginTimelineTransformProvider
          conversationId={null}
          enabled={true}
          streamingDebounceMs={0}
        >
          <ContentPartsRenderer
            parts={completeParts}
            role="assistant"
            isStreaming={false}
          />
        </PluginTimelineTransformProvider>
      </NextIntlClientProvider>
    )

    // Wait for the settled "complete" transform response to update the iframe srcDoc.
    const iframeComplete = await waitFor(() => {
      const frame = screen.getByTitle("Test result") as HTMLIFrameElement
      expect(frame.getAttribute("srcdoc")).not.toBe(streamConn.srcDoc)
      return frame
    })

    // Stable React key keeps the replacement card section mounted across streaming -> complete.
    const cardAfter = document.querySelector(
      '[data-slot="plugin-timeline-replacement-card"]'
    )
    expect(cardAfter).toBe(cardBefore)

    const completeConn = await connectIframe(iframeComplete)
    await waitFor(() => {
      expect(completeConn.received).toContainEqual({
        type: "context",
        context: {
          type: "timelineItem",
          kind: "test-result",
          version: 1,
          itemId: "summary",
          conversationId: null,
          data: { phase: "complete", status: "passed", passed: 5, failed: 0 },
          locale: "en",
        },
      })
    })
  })

  it("supports assistant_message keep, omit, and replace inside CompletedTurnContent", async () => {
    const plugin = makeAssistantTransformerPlugin()
    const mock = makeMockTransport({
      plugins: [plugin],
      onTransform: (request) => {
        if (request.item.text === "OMIT_ME") return { action: "omit" }
        if (request.item.text === "REPLACE_ME") {
          return {
            action: "replace",
            items: [
              {
                id: "formatted",
                kind: "reply-card",
                version: 1,
                data: { headline: "Structured summary" },
              },
            ],
          }
        }
        return { action: "keep" }
      },
    })
    h.transport = mock.transport

    const parts: AdaptedContentPart[] = [
      { type: "text", text: "OMIT_ME" },
      { type: "text", text: "REPLACE_ME" },
      { type: "text", text: "KEEP_ME" },
    ]

    renderWithProvider(
      <CompletedTurnContent parts={parts} completed={true} />,
      {
        conversationId: 7,
      }
    )

    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="plugin-timeline-replacement-card"]')
      ).not.toBeNull()
    })
    expect(screen.queryByText("OMIT_ME")).toBeNull()
    expect(screen.queryByText("REPLACE_ME")).toBeNull()
    expect(screen.getByText("KEEP_ME")).toBeTruthy()
    expect(screen.getByText("Formatted reply")).toBeTruthy()
  })

  it("isolates transform errors and invalid outputs per row while keeping native tool output intact", async () => {
    const plugin = loadToolOutputCardPlugin(true)
    const mock = makeMockTransport({
      plugins: [plugin],
      onTransform: (request) => {
        if (request.item.id === "tc-throws") {
          throw new Error("Plugin timed out")
        }
        if (request.item.id === "tc-invalid") {
          return {
            action: "replace",
            items: [{ kind: "wrong-kind", version: 99, data: {} }],
          }
        }
        return {
          action: "replace",
          items: [
            {
              id: "ok",
              kind: "test-result",
              version: 1,
              data: {
                phase: "complete",
                status: "passed",
                passed: 4,
                failed: 0,
              },
            },
          ],
        }
      },
    })
    h.transport = mock.transport

    const parts: AdaptedContentPart[] = [
      {
        type: "tool-call",
        toolCallId: "tc-throws",
        toolName: "bash",
        input: JSON.stringify({ command: "echo failing-row" }),
        state: "output-available",
        output: "native fallback 1",
      },
      {
        type: "tool-call",
        toolCallId: "tc-ok",
        toolName: "bash",
        input: JSON.stringify({ command: "cargo test" }),
        state: "output-available",
        output: "test result: ok. 4 passed; 0 failed",
      },
      {
        type: "tool-call",
        toolCallId: "tc-invalid",
        toolName: "bash",
        input: JSON.stringify({ command: "echo malformed-row" }),
        state: "output-available",
        output: "native fallback 2",
      },
    ]

    renderWithProvider(
      <ContentPartsRenderer
        parts={parts}
        role="assistant"
        isStreaming={false}
      />
    )

    await waitFor(() => {
      expect(
        document.querySelectorAll(
          '[data-slot="plugin-timeline-replacement-card"]'
        )
      ).toHaveLength(1)
    })

    // Both failing/invalid rows keep their native command rows; healthy row renders its card.
    expect(screen.getByText("echo failing-row")).toBeTruthy()
    expect(screen.getByText("echo malformed-row")).toBeTruthy()
    expect(screen.getByText("Test result")).toBeTruthy()
  })

  it("withdraws replacements immediately on plugin disable, conversation switch, Transport replacement, and remote boot gating", async () => {
    const plugin = loadToolOutputCardPlugin(true)
    let resolveSlow: ((value: unknown) => void) | null = null

    const transportA = makeMockTransport({
      plugins: [plugin],
      onTransform: (request) => {
        if (request.conversationId === 10) {
          return {
            action: "replace",
            items: [
              {
                id: "summary",
                kind: "test-result",
                version: 1,
                data: {
                  phase: "complete",
                  status: "passed",
                  passed: 3,
                  failed: 0,
                },
              },
            ],
          }
        }
        return new Promise((resolvePromise) => {
          resolveSlow = resolvePromise
        })
      },
    })
    h.transport = transportA.transport

    const parts: AdaptedContentPart[] = [
      {
        type: "tool-call",
        toolCallId: "tc-1",
        toolName: "bash",
        input: JSON.stringify({ command: "cargo test" }),
        state: "output-available",
        output: "test result: ok. 3 passed; 0 failed",
      },
    ]

    const { rerender } = renderWithProvider(
      <ContentPartsRenderer
        parts={parts}
        role="assistant"
        isStreaming={false}
      />,
      { conversationId: 10 }
    )

    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="plugin-timeline-replacement-card"]')
      ).not.toBeNull()
    })

    // 1. Disabling the plugin withdraws the replacement immediately back to native tool output.
    act(() => {
      transportA.setPlugins([loadToolOutputCardPlugin(false)])
    })
    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="plugin-timeline-replacement-card"]')
      ).toBeNull()
      expect(screen.getByText("cargo test")).toBeTruthy()
    })

    // Re-enable plugin to test conversation switch + stale in-flight discard.
    act(() => {
      transportA.setPlugins([loadToolOutputCardPlugin(true)])
    })
    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="plugin-timeline-replacement-card"]')
      ).not.toBeNull()
    })

    // 2. Switch conversation from 10 -> 11 (pending slow response): card withdraws immediately.
    rerender(
      <NextIntlClientProvider locale="en" messages={MESSAGES.en}>
        <PluginTimelineTransformProvider
          conversationId={11}
          enabled={true}
          streamingDebounceMs={0}
        >
          <ContentPartsRenderer
            parts={parts}
            role="assistant"
            isStreaming={false}
          />
        </PluginTimelineTransformProvider>
      </NextIntlClientProvider>
    )
    expect(
      document.querySelector('[data-slot="plugin-timeline-replacement-card"]')
    ).toBeNull()
    await waitFor(() => {
      expect(resolveSlow).not.toBeNull()
    })

    // 3. Replace Transport under the same remoteConnectionId while conversation 11 is in-flight.
    const transportB = makeMockTransport({ plugins: [] })
    act(() => {
      h.transport = transportB.transport
      notifyTransportChange()
    })

    // Resolving the stale transportA reply must NOT resurrect a replacement card.
    await act(async () => {
      resolveSlow?.({
        action: "replace",
        items: [
          {
            id: "stale",
            kind: "test-result",
            version: 1,
            data: {
              phase: "complete",
              status: "passed",
              passed: 99,
              failed: 0,
            },
          },
        ],
      })
      await Promise.resolve()
    })
    expect(
      document.querySelector('[data-slot="plugin-timeline-replacement-card"]')
    ).toBeNull()

    // 4. Remote boot gating: ?remoteConnectionId=5 while activeRemoteConnectionId=null makes zero RPCs.
    const transportRemote = makeMockTransport({ plugins: [plugin] })
    window.history.replaceState({}, "", "/?remoteConnectionId=5")
    act(() => {
      h.activeRemoteConnectionId = null
      h.transport = transportRemote.transport
      notifyTransportChange()
    })
    expect(transportRemote.call).not.toHaveBeenCalled()

    // Once activeRemoteConnectionId matches 5, catalog loads and transform runs.
    act(() => {
      h.activeRemoteConnectionId = 5
      notifyTransportChange()
    })
    await waitFor(() => {
      expect(transportRemote.call).toHaveBeenCalledWith("host_plugins_list")
    })
  })
})
