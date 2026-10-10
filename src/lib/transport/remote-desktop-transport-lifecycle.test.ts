import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EventEnvelope, LiveSessionSnapshot } from "@/lib/types"
import { RemoteDesktopTransport } from "./remote-desktop-transport"
import type { RemoteTransportConfig } from "./types"

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock:
    vi.fn<
      (command: string, args?: Record<string, unknown>) => Promise<unknown>
    >(),
  listenMock:
    vi.fn<
      (
        event: string,
        handler: (event: { payload: unknown }) => void
      ) => Promise<() => void>
    >(),
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }))

let receiveFrame: (event: { payload: unknown }) => void
let unlisten: ReturnType<typeof vi.fn>
let transports: RemoteDesktopTransport[]

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  unlisten = vi.fn()
  transports = []
  invokeMock.mockResolvedValue(undefined)
  listenMock.mockImplementation(async (_event, handler) => {
    receiveFrame = handler
    return unlisten
  })
})

afterEach(() => {
  for (const transport of transports) transport.destroy()
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function createTransport(overrides: Partial<RemoteTransportConfig> = {}) {
  const transport = new RemoteDesktopTransport({
    id: 17,
    name: "Remote workspace",
    baseUrl: "http://remote.test:3210/",
    token: "test-token",
    windowInstanceId: "window-instance",
    ...overrides,
  })
  transports.push(transport)
  return transport
}

function emit(frame: unknown) {
  receiveFrame({ payload: frame })
}

function ready() {
  emit({ channel: "__ready__", payload: null })
}

function disconnect() {
  emit({ channel: "__disconnected__", payload: null })
}

/**
 * The server refused the token on the socket's handshake. Network failures
 * never stop the proxy, so this is how its task ends and drops the window's
 * subscription, leaving the transport "disconnected".
 */
function tokenRefused() {
  emit({ channel: "__unauthorized__", payload: null })
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0)
}

async function connectReady() {
  const transport = createTransport()
  const stream = transport.eventStream()
  await flush()
  ready()
  return { transport, stream }
}

function sentFrames() {
  return invokeMock.mock.calls
    .filter(([command]) => command === "remote_ws_send_text")
    .map(([, args]) => JSON.parse(args!.text as string))
}

function lastSentFrame() {
  const frames = sentFrames()
  return frames[frames.length - 1]
}

function commandCalls(command: string) {
  return invokeMock.mock.calls.filter(([name]) => name === command)
}

function attachHandlers() {
  return {
    onSnapshot: vi.fn(),
    onReplay: vi.fn(),
    onEvent: vi.fn(),
    onDetached: vi.fn(),
  }
}

function snapshot(eventSeq: number): LiveSessionSnapshot {
  return {
    connection_id: "agent-connection",
    conversation_id: 3,
    folder_id: 2,
    status: "prompting",
    external_id: null,
    live_message: null,
    active_tool_calls: [],
    pending_permission: null,
    modes: null,
    current_mode: null,
    config_options: null,
    prompt_capabilities: null,
    usage: null,
    fork_supported: false,
    available_commands: [],
    selectors_ready: true,
    event_seq: eventSeq,
  }
}

function envelope(seq: number): EventEnvelope {
  return {
    type: "content_delta",
    connection_id: "agent-connection",
    seq,
    text: `chunk ${seq}`,
  }
}

describe("RemoteDesktopTransport lifecycle", () => {
  it("registers the window listener before subscribing and waits for __ready__", async () => {
    const transport = createTransport()
    const handler = vi.fn()
    const resolved = vi.fn()
    const subscription = transport.subscribe("acp://event", handler)
    void subscription.then(resolved)
    await flush()

    expect(listenMock).toHaveBeenCalledWith(
      "remote-ws-event-17",
      expect.any(Function)
    )
    expect(invokeMock).toHaveBeenCalledWith("remote_ws_subscribe", {
      connectionId: 17,
      subscriptionId: expect.any(String),
      windowInstanceId: "window-instance",
    })
    expect(listenMock.mock.invocationCallOrder[0]).toBeLessThan(
      invokeMock.mock.invocationCallOrder[0]
    )
    expect(resolved).not.toHaveBeenCalled()

    ready()
    const unsubscribe = await subscription
    emit({ channel: "acp://event", payload: { text: "hello" } })
    expect(handler).toHaveBeenCalledWith({ text: "hello" })

    unsubscribe()
    emit({ channel: "acp://event", payload: { text: "after unsubscribe" } })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("notifies reconnect callbacks only after readiness is restored", async () => {
    const transport = createTransport()
    const onReconnect = vi.fn()
    const unsubscribe = transport.onReconnect(onReconnect)
    transport.eventStream()
    await flush()

    ready()
    expect(onReconnect).not.toHaveBeenCalled()
    disconnect()
    const resolved = vi.fn()
    void transport.waitForReady().then(resolved)
    await flush()
    expect(resolved).not.toHaveBeenCalled()
    expect(onReconnect).not.toHaveBeenCalled()

    ready()
    await flush()
    expect(resolved).toHaveBeenCalledTimes(1)
    expect(onReconnect).toHaveBeenCalledTimes(1)

    unsubscribe()
    disconnect()
    ready()
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it("keeps sibling reconnect callbacks running when one throws", async () => {
    const { transport } = await connectReady()
    vi.spyOn(console, "error").mockImplementation(() => {})
    transport.onReconnect(() => {
      throw new Error("consumer failed")
    })
    const sibling = vi.fn()
    transport.onReconnect(sibling)

    disconnect()
    ready()

    expect(sibling).toHaveBeenCalledTimes(1)
  })

  it("preserves initial readiness waiters when connecting attempts disconnect", async () => {
    const transport = createTransport()
    const resolved = vi.fn()
    void transport.subscribe("acp://event", vi.fn()).then(resolved)
    await flush()

    disconnect()
    disconnect()
    ready()
    await flush()

    // No 5s timeout should be needed to release the original promise.
    expect(resolved).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("preserves reconnect waiters across repeated disconnect notifications", async () => {
    const { transport } = await connectReady()
    disconnect()
    const subscribed = vi.fn()
    const readyWaiter = vi.fn()
    void transport.subscribe("acp://event", vi.fn()).then(subscribed)
    void transport.waitForReady().then(readyWaiter)
    await flush()

    disconnect()
    await flush()
    expect(subscribed).not.toHaveBeenCalled()
    expect(readyWaiter).not.toHaveBeenCalled()

    ready()
    await flush()

    expect(subscribed).toHaveBeenCalledTimes(1)
    expect(readyWaiter).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("bounds readiness waits for older servers that never emit __ready__", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const transport = createTransport()
    const resolved = vi.fn()
    void transport.subscribe("acp://event", vi.fn()).then(resolved)
    await flush()

    await vi.advanceTimersByTimeAsync(4_999)
    expect(resolved).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(resolved).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it("keeps reconnecting without claiming expiry through a long outage", async () => {
    const onUnauthorized = vi.fn()
    const transport = createTransport({ onUnauthorized })
    const stream = transport.eventStream()
    await flush()
    ready()

    // The proxy reports every failed attempt and never gives up on its own.
    for (let attempt = 0; attempt < 10; attempt++) disconnect()

    expect(transport.getConnectionSnapshot()).toBe("reconnecting")
    expect(onUnauthorized).not.toHaveBeenCalled()
    stream.attach("agent-connection", {}, attachHandlers())
    expect(sentFrames()).toEqual([])
  })

  it("reports a token the socket handshake refused as expired credentials", async () => {
    const onUnauthorized = vi.fn()
    const transport = createTransport({ onUnauthorized })
    const stream = transport.eventStream()
    await flush()
    ready()

    disconnect()
    expect(onUnauthorized).not.toHaveBeenCalled()
    tokenRefused()

    expect(transport.getConnectionSnapshot()).toBe("disconnected")
    // The same callback, with the same (absent) arguments, as an HTTP 401.
    expect(onUnauthorized.mock.calls).toEqual([[]])
    stream.attach("agent-connection", {}, attachHandlers())
    expect(sentFrames()).toEqual([])
  })

  it("refreshes once on first ready when initial HTTP reads failed offline", async () => {
    const transport = createTransport()
    const onRestored = vi.fn()
    const onReconnect = vi.fn(() => {
      void transport.call("list_all_folder_details").then(onRestored)
    })
    transport.onReconnect(onReconnect)
    transport.eventStream()
    await flush()
    const error = { code: "network_error", message: "Server unreachable" }
    invokeMock.mockRejectedValueOnce(error)
    await expect(transport.call("list_all_folder_details")).rejects.toBe(error)
    expect(onReconnect).not.toHaveBeenCalled()
    const restoredFolders = [{ id: 2, path: "/remote/project" }]
    invokeMock.mockResolvedValue(restoredFolders)

    ready()
    await flush()

    expect(onReconnect).toHaveBeenCalledTimes(1)
    expect(onRestored).toHaveBeenCalledWith(restoredFolders)
    expect(commandCalls("remote_http_call")).toHaveLength(2)
    expect(transport.getConnectionSnapshot()).toBe("connected")
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["__disconnected__", "__unauthorized__"])(
    "refreshes initial state after an initial %s signal recovers",
    async (channel) => {
      const transport = createTransport()
      const onReconnect = vi.fn()
      const subscribed = vi.fn()
      transport.onReconnect(onReconnect)
      void transport.subscribe("acp://event", vi.fn()).then(subscribed)
      await flush()
      emit({ channel, payload: null })
      if (channel === "__unauthorized__") {
        transport.reconnectNow()
        await flush()
        // The ready below answers this retry's subscription, not the first.
        expect(commandCalls("remote_ws_subscribe")).toHaveLength(2)
      }
      await flush()
      expect(onReconnect).not.toHaveBeenCalled()
      expect(subscribed).not.toHaveBeenCalled()

      ready()
      await flush()

      expect(onReconnect).toHaveBeenCalledTimes(1)
      expect(subscribed).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it("refreshes after an initial HTTP failure settles later than first ready", async () => {
    const transport = createTransport()
    const onReconnect = vi.fn()
    transport.onReconnect(onReconnect)
    transport.eventStream()
    await flush()
    let rejectRead!: (reason: unknown) => void
    invokeMock.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectRead = reject
      })
    )
    const error = { code: "network_error", message: "Server was offline" }
    const failedRead = expect(transport.call("list_folders")).rejects.toBe(
      error
    )
    ready()
    expect(onReconnect).not.toHaveBeenCalled()

    rejectRead(error)
    await failedRead
    expect(onReconnect).not.toHaveBeenCalled()
    await flush()

    expect(onReconnect).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("cancels a late initial-read recovery callback when destroyed", async () => {
    const transport = createTransport()
    const onReconnect = vi.fn()
    transport.onReconnect(onReconnect)
    transport.eventStream()
    await flush()
    let rejectRead!: (reason: unknown) => void
    invokeMock.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectRead = reject
      })
    )
    const error = { code: "network_error", message: "Server was offline" }
    const failedRead = expect(transport.call("list_folders")).rejects.toBe(
      error
    )
    ready()
    rejectRead(error)
    await failedRead
    expect(vi.getTimerCount()).toBe(1)

    transport.destroy()
    await flush()

    expect(onReconnect).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

// A retry in place starts from a "disconnected" transport. Here a refused
// handshake puts it there, which also ends the proxy task that held the
// subscription. Behind the status pill the usual way there is a subscription
// the IPC layer failed to set up.
describe("RemoteDesktopTransport manual retry", () => {
  it("reuses handlers, stream, replay cursor, and readiness waiters when retrying in place", async () => {
    const { transport, stream } = await connectReady()
    const legacyHandler = vi.fn()
    await transport.subscribe("acp://event", legacyHandler)
    const handlers = attachHandlers()
    const sub = stream.attach("agent-connection", {}, handlers)
    emit({
      type: "snapshot",
      subscription_id: sub.subscriptionId,
      connection_id: "agent-connection",
      snapshot: snapshot(10),
      event_seq: 10,
    })
    const onReconnect = vi.fn()
    transport.onReconnect(onReconnect)
    disconnect()
    const readyWaiter = vi.fn()
    void transport.waitForReady().then(readyWaiter)
    tokenRefused()
    const originalSubscription = commandCalls("remote_ws_subscribe")[0][1]

    transport.reconnectNow()
    await flush()

    expect(transport.getConnectionSnapshot()).toBe("reconnecting")
    expect(transport.eventStream()).toBe(stream)
    expect(readyWaiter).not.toHaveBeenCalled()
    expect(sentFrames()).toHaveLength(1)
    expect(commandCalls("remote_ws_subscribe")).toHaveLength(2)
    expect(commandCalls("remote_ws_subscribe")[1][1]).toEqual(
      originalSubscription
    )
    expect(listenMock).toHaveBeenCalledTimes(1)
    expect(unlisten).not.toHaveBeenCalled()

    ready()
    await flush()
    expect(readyWaiter).toHaveBeenCalledTimes(1)
    expect(onReconnect).toHaveBeenCalledTimes(1)
    expect(lastSentFrame()).toEqual({
      action: "attach",
      subscription_id: sub.subscriptionId,
      connection_id: "agent-connection",
      since_seq: 10,
    })
    const replay = [envelope(11), envelope(12)]
    emit({
      type: "replay",
      subscription_id: sub.subscriptionId,
      connection_id: "agent-connection",
      events: replay,
      high_water_seq: 12,
    })
    emit({ channel: "acp://event", payload: "recovered event" })
    expect(handlers.onReplay).toHaveBeenCalledWith(replay, 12)
    expect(legacyHandler).toHaveBeenCalledWith("recovered event")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("awaits unsubscribe and coalesces repeated retry clicks into one subscribe", async () => {
    const { transport } = await connectReady()
    tokenRefused()
    let finishUnsubscribe!: () => void
    const unsubscribePending = new Promise<void>((resolve) => {
      finishUnsubscribe = resolve
    })
    invokeMock.mockImplementation((command) => {
      return command === "remote_ws_unsubscribe"
        ? unsubscribePending
        : Promise.resolve(undefined)
    })

    transport.reconnectNow()
    transport.reconnectNow()
    transport.reconnectNow()
    await flush()

    expect(commandCalls("remote_ws_unsubscribe")).toHaveLength(1)
    expect(commandCalls("remote_ws_subscribe")).toHaveLength(1)
    expect(transport.getConnectionSnapshot()).toBe("reconnecting")

    finishUnsubscribe()
    await flush()
    transport.reconnectNow()
    expect(commandCalls("remote_ws_subscribe")).toHaveLength(2)
    expect(commandCalls("remote_ws_unsubscribe")).toHaveLength(1)
  })

  it("does not replace a healthy or automatically reconnecting proxy", async () => {
    const transport = createTransport()
    transport.reconnectNow()
    expect(invokeMock).not.toHaveBeenCalled()
    transport.eventStream()
    await flush()
    ready()
    transport.reconnectNow()
    disconnect()
    transport.reconnectNow()
    await flush()

    expect(commandCalls("remote_ws_subscribe")).toHaveLength(1)
    expect(commandCalls("remote_ws_unsubscribe")).toHaveLength(0)
  })

  it("does not resubscribe when destroyed while retry unsubscribe is pending", async () => {
    const { transport } = await connectReady()
    tokenRefused()
    let finishUnsubscribe!: () => void
    invokeMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishUnsubscribe = resolve
      })
    )
    transport.reconnectNow()
    await flush()
    // The retry, not destroy() below, is what is waiting on the unsubscribe.
    expect(commandCalls("remote_ws_unsubscribe")).toHaveLength(1)
    transport.destroy()
    finishUnsubscribe()
    await flush()
    transport.reconnectNow()
    await flush()

    expect(commandCalls("remote_ws_subscribe")).toHaveLength(1)
    expect(listenMock).toHaveBeenCalledTimes(1)
    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["remote_ws_unsubscribe", "remote_ws_subscribe"])(
    "retains active streams and allows another retry after %s fails",
    async (failedCommand) => {
      const { transport, stream } = await connectReady()
      vi.spyOn(console, "warn").mockImplementation(() => {})
      const handlers = attachHandlers()
      const sub = stream.attach("agent-connection", { sinceSeq: 22 }, handlers)
      tokenRefused()
      let failOnce = true
      invokeMock.mockImplementation((command) => {
        if (command === failedCommand && failOnce) {
          failOnce = false
          return Promise.reject(new Error("IPC unavailable"))
        }
        return Promise.resolve(undefined)
      })

      transport.reconnectNow()
      await flush()

      // The retry reached the failing command, and the failure ended it.
      expect(failOnce).toBe(false)
      expect(transport.getConnectionSnapshot()).toBe("disconnected")
      expect(transport.eventStream()).toBe(stream)
      expect(sentFrames()).toHaveLength(1)
      const subscribesBefore = commandCalls("remote_ws_subscribe").length
      transport.reconnectNow()
      await flush()
      expect(transport.getConnectionSnapshot()).toBe("reconnecting")
      expect(commandCalls("remote_ws_subscribe")).toHaveLength(
        subscribesBefore + 1
      )
      ready()
      expect(transport.getConnectionSnapshot()).toBe("connected")
      expect(lastSentFrame()).toEqual({
        action: "attach",
        subscription_id: sub.subscriptionId,
        connection_id: "agent-connection",
        since_seq: 22,
      })
      emit({
        type: "event",
        subscription_id: sub.subscriptionId,
        envelope: envelope(23),
      })
      expect(handlers.onEvent).toHaveBeenCalledWith(envelope(23))
    }
  )
})

describe("RemoteDesktopTransport connection health", () => {
  it("publishes lifecycle snapshots once per state change", async () => {
    const transport = createTransport()
    const states: string[] = []
    transport.subscribeConnection(() => {
      states.push(transport.getConnectionSnapshot())
    })
    expect(transport.getConnectionSnapshot()).toBe("reconnecting")
    transport.eventStream()
    await flush()

    disconnect()
    expect(states).toEqual([])
    ready()
    ready()
    expect(transport.getConnectionSnapshot()).toBe("connected")
    expect(states).toEqual(["connected"])

    disconnect()
    disconnect()
    expect(transport.getConnectionSnapshot()).toBe("reconnecting")
    ready()
    tokenRefused()
    tokenRefused()

    expect(transport.getConnectionSnapshot()).toBe("disconnected")
    expect(states).toEqual([
      "connected",
      "reconnecting",
      "connected",
      "disconnected",
    ])
  })

  it("stops notifying a health subscriber after unsubscribe", async () => {
    const { transport } = await connectReady()
    const listener = vi.fn()
    const unsubscribe = transport.subscribeConnection(listener)

    disconnect()
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    unsubscribe()
    ready()

    expect(transport.getConnectionSnapshot()).toBe("connected")
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("isolates failing health listeners and ignores late lifecycle events after destroy", async () => {
    const { transport } = await connectReady()
    vi.spyOn(console, "error").mockImplementation(() => {})
    transport.subscribeConnection(() => {
      throw new Error("health listener failed")
    })
    const sibling = vi.fn()
    transport.subscribeConnection(sibling)
    disconnect()
    expect(sibling).toHaveBeenCalledTimes(1)

    transport.destroy()
    ready()
    emit({ channel: "__unauthorized__", payload: null })

    expect(transport.getConnectionSnapshot()).toBe("reconnecting")
    expect(sibling).toHaveBeenCalledTimes(1)
  })

  it("marks confirmed HTTP credential rejection disconnected with the default callback source", async () => {
    const onUnauthorized = vi.fn()
    const transport = createTransport({ onUnauthorized })
    const stream = transport.eventStream()
    await flush()
    ready()
    const listener = vi.fn()
    transport.subscribeConnection(listener)
    const error = {
      code: "authentication_failed",
      message: "Invalid remote token",
    }
    invokeMock.mockRejectedValueOnce(error)

    await expect(transport.call("get_status")).rejects.toBe(error)

    expect(transport.getConnectionSnapshot()).toBe("disconnected")
    expect(listener).toHaveBeenCalledTimes(1)
    expect(onUnauthorized.mock.calls).toEqual([[]])
    stream.attach("agent-connection", {}, attachHandlers())
    expect(sentFrames()).toEqual([])
  })

  it("does not label an ordinary HTTP failure as rejected credentials", async () => {
    const onUnauthorized = vi.fn()
    const transport = createTransport({ onUnauthorized })
    transport.eventStream()
    await flush()
    ready()
    const listener = vi.fn()
    transport.subscribeConnection(listener)
    const error = { code: "network_error", message: "Request timed out" }
    invokeMock.mockRejectedValueOnce(error)

    await expect(transport.call("get_status")).rejects.toBe(error)

    expect(transport.getConnectionSnapshot()).toBe("connected")
    expect(listener).not.toHaveBeenCalled()
    expect(onUnauthorized).not.toHaveBeenCalled()
  })
})

describe("RemoteDesktopTransport attach stream", () => {
  it("queues initial attaches and catches up using snapshot, event, and replay cursors", async () => {
    const transport = createTransport()
    const stream = transport.eventStream()
    expect(transport.eventStream()).toBe(stream)
    const handlers = attachHandlers()
    const sub = stream.attach("agent-connection", {}, handlers)
    await flush()
    expect(sentFrames()).toEqual([])

    ready()
    expect(sentFrames()).toEqual([
      {
        action: "attach",
        subscription_id: sub.subscriptionId,
        connection_id: "agent-connection",
      },
    ])

    const initialSnapshot = snapshot(10)
    emit({
      type: "snapshot",
      subscription_id: sub.subscriptionId,
      connection_id: "agent-connection",
      snapshot: initialSnapshot,
      event_seq: 10,
    })
    expect(handlers.onSnapshot).toHaveBeenCalledWith(initialSnapshot, 10)
    disconnect()
    ready()
    expect(lastSentFrame()).toMatchObject({ since_seq: 10 })

    const events = [envelope(11), envelope(12)]
    emit({
      type: "replay",
      subscription_id: sub.subscriptionId,
      connection_id: "agent-connection",
      events,
      high_water_seq: 12,
    })
    expect(handlers.onReplay).toHaveBeenCalledWith(events, 12)
    emit({
      type: "event",
      subscription_id: sub.subscriptionId,
      envelope: envelope(13),
    })
    expect(handlers.onEvent).toHaveBeenCalledWith(envelope(13))
    disconnect()
    ready()
    expect(lastSentFrame()).toMatchObject({ since_seq: 13 })

    // Even an empty replay may advance the server's high-water mark.
    emit({
      type: "replay",
      subscription_id: sub.subscriptionId,
      connection_id: "agent-connection",
      events: [],
      high_water_seq: 18,
    })
    disconnect()
    ready()
    expect(lastSentFrame()).toMatchObject({ since_seq: 18 })
    expect(
      invokeMock.mock.calls.filter(([c]) => c === "remote_ws_subscribe")
    ).toHaveLength(1)
  })

  it("routes attach frames by subscription and removes detached subscriptions", async () => {
    const { stream } = await connectReady()
    const firstHandlers = attachHandlers()
    const secondHandlers = attachHandlers()
    const first = stream.attach(
      "agent-connection",
      { sinceSeq: 3 },
      firstHandlers
    )
    const second = stream.attach("other-connection", {}, secondHandlers)

    emit({
      type: "event",
      subscription_id: first.subscriptionId,
      envelope: envelope(4),
    })
    emit({ type: "event", subscription_id: "unknown", envelope: envelope(5) })
    emit({ type: "pong" })
    emit(null)
    emit({ unexpected: true })
    expect(firstHandlers.onEvent).toHaveBeenCalledTimes(1)
    expect(secondHandlers.onEvent).not.toHaveBeenCalled()

    first.detach()
    first.detach()
    expect(sentFrames().filter((frame) => frame.action === "detach")).toEqual([
      { action: "detach", subscription_id: first.subscriptionId },
    ])
    emit({
      type: "event",
      subscription_id: first.subscriptionId,
      envelope: envelope(6),
    })
    emit({
      type: "detached",
      subscription_id: second.subscriptionId,
      reason: "connection_gone",
    })
    expect(firstHandlers.onEvent).toHaveBeenCalledTimes(1)
    expect(secondHandlers.onDetached).toHaveBeenCalledWith("connection_gone")

    const sendCount = sentFrames().length
    disconnect()
    ready()
    expect(sentFrames()).toHaveLength(sendCount)
  })

  it("debounces rejected sends and reattaches active subscriptions with their latest cursor", async () => {
    const { stream } = await connectReady()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    invokeMock.mockRejectedValueOnce(new Error("queue full"))
    invokeMock.mockRejectedValueOnce(new Error("queue full"))
    const first = stream.attach(
      "agent-connection",
      { sinceSeq: 7 },
      attachHandlers()
    )
    const second = stream.attach(
      "other-connection",
      { sinceSeq: 20 },
      attachHandlers()
    )
    await flush()
    emit({
      type: "event",
      subscription_id: first.subscriptionId,
      envelope: envelope(8),
    })

    await vi.advanceTimersByTimeAsync(199)
    expect(sentFrames()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(sentFrames().slice(2)).toEqual([
      {
        action: "attach",
        subscription_id: first.subscriptionId,
        connection_id: "agent-connection",
        since_seq: 8,
      },
      {
        action: "attach",
        subscription_id: second.subscriptionId,
        connection_id: "other-connection",
        since_seq: 20,
      },
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("leaves recovery to the next ready event when a rejected send is followed by disconnect", async () => {
    const { stream } = await connectReady()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    invokeMock.mockRejectedValueOnce(new Error("socket closed"))
    stream.attach("agent-connection", { sinceSeq: 9 }, attachHandlers())
    await flush()

    disconnect()
    await vi.advanceTimersByTimeAsync(200)
    expect(sentFrames()).toHaveLength(1)
    ready()
    expect(sentFrames()).toHaveLength(2)
    expect(lastSentFrame()).toMatchObject({ since_seq: 9 })
  })
})

describe("RemoteDesktopTransport destruction", () => {
  it("unsubscribes once, releases readiness waiters, and ignores late frames", async () => {
    const transport = createTransport()
    const onEvent = vi.fn()
    const onReconnect = vi.fn()
    transport.onReconnect(onReconnect)
    const subscribed = vi.fn()
    void transport.subscribe("acp://event", onEvent).then(subscribed)
    await flush()
    const subscriptionArgs = invokeMock.mock.calls.find(
      ([command]) => command === "remote_ws_subscribe"
    )![1]!

    transport.destroy()
    transport.destroy()
    await flush()

    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(subscribed).toHaveBeenCalledTimes(1)
    expect(
      invokeMock.mock.calls.filter(([c]) => c === "remote_ws_unsubscribe")
    ).toEqual([
      [
        "remote_ws_unsubscribe",
        {
          connectionId: 17,
          subscriptionId: subscriptionArgs.subscriptionId,
        },
      ],
    ])
    ready()
    emit({ channel: "acp://event", payload: "late event" })
    expect(onEvent).not.toHaveBeenCalled()
    expect(onReconnect).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("cancels pending send-failure retries when destroyed", async () => {
    const { transport, stream } = await connectReady()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    invokeMock.mockRejectedValueOnce(new Error("queue full"))
    const handlers = attachHandlers()
    const sub = stream.attach("agent-connection", {}, handlers)
    await flush()
    expect(vi.getTimerCount()).toBe(1)

    transport.destroy()
    await vi.advanceTimersByTimeAsync(1_000)
    emit({
      type: "event",
      subscription_id: sub.subscriptionId,
      envelope: envelope(1),
    })

    expect(sentFrames()).toHaveLength(1)
    expect(handlers.onEvent).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("cleans up an in-flight listener without subscribing after destruction", async () => {
    let finishListen!: (listener: () => void) => void
    listenMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finishListen = resolve
      })
    )
    const transport = createTransport()
    const resolved = vi.fn()
    void transport.subscribe("acp://event", vi.fn()).then(resolved)

    transport.destroy()
    finishListen(unlisten)
    await flush()

    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(
      invokeMock.mock.calls.filter(([c]) => c === "remote_ws_subscribe")
    ).toHaveLength(0)
    expect(resolved).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("reissues cleanup with the same subscription ID after an in-flight subscribe completes", async () => {
    let finishSubscribe!: () => void
    invokeMock.mockImplementation((command) => {
      if (command === "remote_ws_subscribe") {
        return new Promise<void>((resolve) => {
          finishSubscribe = resolve
        })
      }
      return Promise.resolve(undefined)
    })
    const transport = createTransport()
    const subscription = transport.subscribe("acp://event", vi.fn())
    await flush()
    const subscriptionArgs = invokeMock.mock.calls.find(
      ([command]) => command === "remote_ws_subscribe"
    )![1]!

    transport.destroy()
    finishSubscribe()
    await subscription

    const unsubscribeCalls = invokeMock.mock.calls.filter(
      ([command]) => command === "remote_ws_unsubscribe"
    )
    expect(unsubscribeCalls).toHaveLength(2)
    for (const [, args] of unsubscribeCalls) {
      expect(args).toEqual({
        connectionId: 17,
        subscriptionId: subscriptionArgs.subscriptionId,
      })
    }
    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
