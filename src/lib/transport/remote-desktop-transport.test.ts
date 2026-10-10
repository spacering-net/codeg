import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Event } from "@tauri-apps/api/event"
import { RemoteDesktopTransport } from "./remote-desktop-transport"
import type { AttachHandlers, RemoteTransportConfig } from "./types"

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  listeners: new Map<string, (event: Event<unknown>) => void>(),
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke }))
vi.mock("@tauri-apps/api/event", () => ({ listen: ipc.listen }))

const config: RemoteTransportConfig = {
  id: 7,
  name: "Remote",
  baseUrl: "http://remote.example:3080",
  token: "test-token",
  windowInstanceId: "rw-test",
}
const transports: RemoteDesktopTransport[] = []

function transport(overrides: Partial<RemoteTransportConfig> = {}) {
  const t = new RemoteDesktopTransport({ ...config, ...overrides })
  transports.push(t)
  return t
}

function emit(payload: unknown, id = config.id) {
  const event = `remote-ws-event-${id}`
  ipc.listeners.get(event)?.({ event, id: 1, payload })
}

function ready(id = config.id) {
  emit({ channel: "__ready__", payload: null }, id)
}

function drop(id = config.id) {
  emit({ channel: "__disconnected__", payload: null }, id)
}

function sentFrames() {
  return ipc.invoke.mock.calls
    .filter(([command]) => command === "remote_ws_send_text")
    .map(([, args]) => JSON.parse(args.text))
}

function latestSentFrame() {
  const frames = sentFrames()
  return frames[frames.length - 1]
}

function handlers(): AttachHandlers {
  return {
    onSnapshot: vi.fn(),
    onReplay: vi.fn(),
    onEvent: vi.fn(),
    onDetached: vi.fn(),
  }
}

// Drain the two async IPC registration steps without advancing the readiness
// timeout: resolving only after 5s would hide a stranded readiness promise.
async function flush() {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  ipc.invoke.mockReset().mockResolvedValue(undefined)
  ipc.listen.mockReset().mockImplementation(async (event, callback) => {
    ipc.listeners.set(event, callback)
    return () => ipc.listeners.delete(event)
  })
  ipc.listeners.clear()
})

afterEach(() => {
  for (const t of transports.splice(0)) t.destroy()
  vi.useRealTimers()
})

describe("remote desktop event recovery", () => {
  it("reattaches with its cursor, delivers missed events, then continues the session", async () => {
    const t = transport()
    const stream = t.eventStream()
    const h = handlers()
    const sub = stream.attach("session-1", {}, h)
    const resync = vi.fn()
    t.onReconnect(resync)
    await flush()
    ready()
    emit({
      type: "snapshot",
      subscription_id: sub.subscriptionId,
      connection_id: "session-1",
      snapshot: { live_message: { content: "before the drop" } },
      event_seq: 10,
    })
    expect(h.onSnapshot).toHaveBeenCalledTimes(1)
    expect(resync).not.toHaveBeenCalled()

    drop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sentFrames()).toHaveLength(1)
    ready()
    expect(latestSentFrame()).toEqual({
      action: "attach",
      subscription_id: sub.subscriptionId,
      connection_id: "session-1",
      since_seq: 10,
    })
    const missed = { seq: 11, event: { content: "during the drop" } }
    emit({
      type: "replay",
      subscription_id: sub.subscriptionId,
      connection_id: "session-1",
      events: [missed],
      high_water_seq: 11,
    })
    const next = { seq: 12, event: { content: "after recovery" } }
    emit({ type: "event", subscription_id: sub.subscriptionId, envelope: next })
    expect(h.onReplay).toHaveBeenCalledWith([missed], 11)
    expect(h.onEvent).toHaveBeenCalledWith(next)
    expect(resync).toHaveBeenCalledTimes(1)

    // A later reconnect must start after the newly delivered conversation.
    drop()
    ready()
    expect(latestSentFrame().since_seq).toBe(12)
    expect(resync).toHaveBeenCalledTimes(2)
  })

  it("ignores duplicate ready signals within the same connection", async () => {
    const t = transport()
    t.eventStream().attach("session-1", {}, handlers())
    const resync = vi.fn()
    t.onReconnect(resync)
    await flush()
    ready()
    ready()
    expect(sentFrames()).toHaveLength(1)
    expect(resync).not.toHaveBeenCalled()
    drop()
    ready()
    ready()
    expect(sentFrames()).toHaveLength(2)
    expect(resync).toHaveBeenCalledTimes(1)
  })

  it("resyncs state when a window was first opened while the server was offline", async () => {
    const t = transport()
    const resync = vi.fn()
    t.onReconnect(resync)
    const settled = vi.fn()
    const subscription = t.subscribe("folders://changed", vi.fn()).then(settled)
    await flush()
    drop()
    drop()
    await flush()
    expect(settled).not.toHaveBeenCalled()
    ready()
    await flush()
    expect(settled).toHaveBeenCalledTimes(1)
    expect(resync).toHaveBeenCalledTimes(1)
    await subscription
  })

  it("keeps readiness waiters together across repeated disconnect signals", async () => {
    const t = transport()
    t.eventStream()
    await flush()
    ready()
    drop()
    const settled = vi.fn()
    const subscription = t.subscribe("folders://changed", vi.fn()).then(settled)
    await flush()
    // The socket is down, so the subscriber waits for the next ready.
    expect(settled).not.toHaveBeenCalled()
    drop()
    await flush()
    expect(settled).not.toHaveBeenCalled()
    ready()
    await flush()
    expect(settled).toHaveBeenCalledTimes(1)
    await subscription
  })

  it("refetches after a first ready that arrives beyond the readiness timeout", async () => {
    const t = transport()
    const resync = vi.fn()
    t.onReconnect(resync)
    const subscription = t.subscribe("folders://changed", vi.fn())
    await flush()
    await vi.advanceTimersByTimeAsync(5_000)
    await subscription
    expect(resync).not.toHaveBeenCalled()
    ready()
    expect(resync).toHaveBeenCalledTimes(1)
  })

  it("accepts a snapshot when the server cannot replay the gap", async () => {
    const t = transport()
    const h = handlers()
    const sub = t.eventStream().attach("session-1", { sinceSeq: 300 }, h)
    await flush()
    ready()
    drop()
    ready()
    const snapshot = { live_message: { content: "recovered persisted turn" } }
    emit({
      type: "snapshot",
      subscription_id: sub.subscriptionId,
      connection_id: "session-1",
      snapshot,
      event_seq: 2,
    })
    expect(h.onSnapshot).toHaveBeenCalledWith(snapshot, 2)
    drop()
    ready()
    expect(latestSentFrame().since_seq).toBe(2)
  })

  it("does not resurrect detached conversations on reconnect", async () => {
    const t = transport()
    const h = handlers()
    const sub = t.eventStream().attach("session-1", {}, h)
    await flush()
    ready()
    drop()
    sub.detach()
    ready()
    expect(sentFrames()).toHaveLength(1)
    emit({ type: "event", subscription_id: sub.subscriptionId, envelope: {} })
    expect(h.onEvent).not.toHaveBeenCalled()
  })

  it("keeps windows of different remote connections isolated", async () => {
    const a = transport()
    const b = transport({ id: 8, windowInstanceId: "rw-other" })
    const updateA = vi.fn()
    const updateB = vi.fn()
    const subA = a.subscribe("folders://changed", updateA)
    const subB = b.subscribe("folders://changed", updateB)
    await flush()
    ready()
    ready(8)
    await Promise.all([subA, subB])
    drop()
    emit({ channel: "folders://changed", payload: "B" }, 8)
    ready()
    emit({ channel: "folders://changed", payload: "A" })
    expect(updateA.mock.calls).toEqual([["A"]])
    expect(updateB.mock.calls).toEqual([["B"]])
  })

  it("coalesces failed attach sends and cancels retry after destroy", async () => {
    const t = transport()
    const stream = t.eventStream()
    stream.attach("session-1", {}, handlers())
    stream.attach("session-2", {}, handlers())
    await flush()
    ipc.invoke.mockImplementation(async (command) => {
      if (command === "remote_ws_send_text") throw { code: "network_error" }
    })
    ready()
    await flush()
    expect(sentFrames()).toHaveLength(2)
    // Both failures share one retry: a single reattach of both sessions.
    await vi.advanceTimersByTimeAsync(200)
    expect(sentFrames()).toHaveLength(4)
    t.destroy()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sentFrames()).toHaveLength(4)
  })

  it("releases an IPC listener that arrives after its window was destroyed", async () => {
    let finishListen!: (unlisten: () => void) => void
    ipc.listen.mockImplementation(
      () => new Promise((resolve) => (finishListen = resolve))
    )
    const t = transport()
    const settled = vi.fn()
    const subscription = t.subscribe("folders://changed", vi.fn()).then(settled)
    t.destroy()
    const unlisten = vi.fn()
    finishListen(unlisten)
    await flush()
    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(ipc.invoke).not.toHaveBeenCalledWith(
      "remote_ws_subscribe",
      expect.anything()
    )
    expect(settled).toHaveBeenCalledTimes(1)
    await subscription
  })
})
