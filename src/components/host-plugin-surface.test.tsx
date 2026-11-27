import { type ReactElement } from "react"
import { act, cleanup, render, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { Transport } from "@/lib/transport"

const mockTransportRef = vi.hoisted(() => ({
  current: null as Transport | null,
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => {
    if (!mockTransportRef.current) throw new Error("mock transport not set")
    return mockTransportRef.current
  },
}))

import { HostPluginSurface } from "./host-plugin-surface"

class FakeMessagePort {
  onmessage: ((event: { data: unknown }) => void) | null = null
  closed = false
  peer!: FakeMessagePort
  posted: unknown[] = []

  postMessage(data: unknown) {
    if (this.closed) return
    this.posted.push(data)
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

function createMockTransport() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const call = vi.fn(async (method: string) => {
    if (method === "host_plugins_client_html") {
      return "<main>plugin-body</main>"
    }
    return null
  })
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
  const emit = (channel: string, payload: unknown) => {
    for (const handler of listeners.get(channel) ?? []) {
      handler(payload)
    }
  }
  const transport: Transport = {
    call: call as Transport["call"],
    subscribe: subscribe as Transport["subscribe"],
  }
  return { transport, call, subscribe, emit }
}

function withIntl(ui: ReactElement) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

function extractHandshakeKey(srcDoc: string): string {
  const match = srcDoc.match(/const key = "([0-9a-f]+)"/)
  if (!match) throw new Error("Handshake key not found in srcDoc")
  return match[1]
}

function connectFrame(iframe: HTMLIFrameElement) {
  const key = extractHandshakeKey(iframe.getAttribute("srcdoc") ?? "")
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

  const readyEvent = new Event("message")
  Object.defineProperties(readyEvent, {
    origin: { value: "null" },
    source: { value: fakeWindow },
    data: { value: { type: "codeg-plugin-ready", key } },
  })
  window.dispatchEvent(readyEvent)

  return {
    key,
    received,
    get port() {
      return framePort
    },
  }
}

describe("HostPluginSurface clientSurface context & isolation", () => {
  const originalMessageChannel = globalThis.MessageChannel

  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.MessageChannel =
      FakeMessageChannel as unknown as typeof MessageChannel
  })

  afterEach(() => {
    cleanup()
    globalThis.MessageChannel = originalMessageChannel
    mockTransportRef.current = null
  })

  it("delivers full slot/workspace/session context and isolates lifecycle events", async () => {
    const mock = createMockTransport()
    mockTransportRef.current = mock.transport

    const { getByTitle } = render(
      withIntl(
        <HostPluginSurface
          pluginId="acme.session"
          title="Session Notes"
          context={{
            type: "clientSurface",
            slot: "sessionHeader",
            id: "notes",
            folderId: 42,
            conversationId: 7,
            sessionKey: "tab-7",
          }}
        />
      )
    )

    const iframe = (await waitFor(() =>
      getByTitle("Session Notes")
    )) as HTMLIFrameElement
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts")
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer")

    await act(async () => {})
    const session = connectFrame(iframe)
    expect(session.received[0]).toEqual({
      type: "context",
      context: {
        type: "clientSurface",
        slot: "sessionHeader",
        id: "notes",
        folderId: 42,
        conversationId: 7,
        sessionKey: "tab-7",
        locale: "en",
      },
    })

    await waitFor(() => {
      expect(mock.subscribe).toHaveBeenCalledWith(
        "host-plugins://event",
        expect.any(Function)
      )
    })

    // Wrong plugin -> ignored
    mock.emit("host-plugins://event", {
      pluginId: "other.plugin",
      event: "session.turn.completed",
      folderId: 42,
      conversationId: 7,
      data: { ignored: true },
    })
    // Wrong workspace -> ignored
    mock.emit("host-plugins://event", {
      pluginId: "acme.session",
      event: "session.turn.completed",
      folderId: 99,
      conversationId: 7,
      data: { ignored: true },
    })
    // Wrong conversation -> ignored
    mock.emit("host-plugins://event", {
      pluginId: "acme.session",
      event: "session.turn.completed",
      folderId: 42,
      conversationId: 8,
      data: { ignored: true },
    })
    // Matching workspace + conversation -> delivered
    mock.emit("host-plugins://event", {
      pluginId: "acme.session",
      event: "session.turn.completed",
      folderId: 42,
      conversationId: 7,
      data: { ok: true },
    })

    expect(session.received).toHaveLength(2)
    expect(session.received[1]).toEqual({
      type: "event",
      value: {
        pluginId: "acme.session",
        event: "session.turn.completed",
        folderId: 42,
        conversationId: 7,
        data: { ok: true },
      },
    })
  })

  it("restarts the iframe and closes the previous port when session context changes", async () => {
    const mock = createMockTransport()
    mockTransportRef.current = mock.transport

    const { getByTitle, rerender } = render(
      withIntl(
        <HostPluginSurface
          pluginId="acme.composer"
          title="Prompt Helper"
          context={{
            type: "clientSurface",
            slot: "composer",
            id: "helper",
            folderId: 1,
            conversationId: 10,
            sessionKey: "tab-a",
          }}
        />
      )
    )

    const firstFrame = (await waitFor(() =>
      getByTitle("Prompt Helper")
    )) as HTMLIFrameElement
    await act(async () => {})
    const first = connectFrame(firstFrame)
    const firstHostPort = first.port!.peer

    rerender(
      withIntl(
        <HostPluginSurface
          pluginId="acme.composer"
          title="Prompt Helper"
          context={{
            type: "clientSurface",
            slot: "composer",
            id: "helper",
            folderId: 2,
            conversationId: 20,
            sessionKey: "tab-b",
          }}
        />
      )
    )

    const secondFrame = getByTitle("Prompt Helper") as HTMLIFrameElement
    const second = connectFrame(secondFrame)

    expect(firstHostPort.closed).toBe(true)
    expect(second.key).not.toBe(first.key)
    expect(second.received[0]).toEqual({
      type: "context",
      context: {
        type: "clientSurface",
        slot: "composer",
        id: "helper",
        folderId: 2,
        conversationId: 20,
        sessionKey: "tab-b",
        locale: "en",
      },
    })
  })

  it("does not forward workspace-bound events into a folderless chat surface", async () => {
    const mock = createMockTransport()
    mockTransportRef.current = mock.transport

    const { getByTitle } = render(
      withIntl(
        <HostPluginSurface
          pluginId="acme.composer"
          title="Prompt Helper"
          context={{
            type: "clientSurface",
            slot: "composer",
            id: "helper",
            folderId: null,
            conversationId: null,
            sessionKey: "chat-draft-1",
          }}
        />
      )
    )

    const iframe = (await waitFor(() =>
      getByTitle("Prompt Helper")
    )) as HTMLIFrameElement
    await act(async () => {})
    const session = connectFrame(iframe)

    await waitFor(() => {
      expect(mock.subscribe).toHaveBeenCalledWith(
        "host-plugins://event",
        expect.any(Function)
      )
    })

    mock.emit("host-plugins://event", {
      pluginId: "acme.composer",
      event: "workspace.open.after",
      folderId: 5,
      data: { path: "/secret" },
    })

    expect(session.received).toHaveLength(1)
  })
})
