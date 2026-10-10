import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WebTransport } from "./web-transport"

// Minimal controllable WebSocket stand-in: records instances and lets the test
// drive the lifecycle (open / __ready__ frame / drop) deterministically. The
// real browser WS is event-driven and opaque; this exposes the transitions the
// state machine reacts to.
class MockWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3
  static instances: MockWebSocket[] = []
  readyState = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  constructor(
    public url: string,
    public protocols?: string | string[]
  ) {
    MockWebSocket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = MockWebSocket.CLOSED
  }
  // ── test drivers ──
  open() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }
  ready() {
    this.onmessage?.({
      data: JSON.stringify({ channel: "__ready__", payload: null }),
    })
  }
  drop() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }
}

function lastWs(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.instances = []
  vi.stubGlobal("WebSocket", MockWebSocket)
  localStorage.setItem("codeg_token", "tok")
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  localStorage.clear()
})

// Bring a fresh transport to the application-ready "connected" state.
// `eventStream()` synchronously triggers the WS connect (no await, unlike
// `subscribe()`), which keeps the timer/promise interleaving simple.
function connectReady() {
  const t = new WebTransport("http://localhost")
  t.eventStream()
  const ws = lastWs()
  ws.open()
  ws.ready()
  return { t, ws }
}

const ok200 = () => ({ status: 200, ok: true, json: async () => ({}) })
const resp401 = () => ({ status: 401, ok: false, json: async () => ({}) })

describe("WebTransport connection state machine", () => {
  it("starts connected and the first __ready__ does not fire reconnect callbacks", () => {
    const t = new WebTransport("http://localhost")
    const onReconnect = vi.fn()
    const onReady = vi.fn()
    t.onReconnect(onReconnect)
    t.onReady(onReady)
    expect(t.getConnectionSnapshot()).toBe("connected")

    t.eventStream()
    const ws = lastWs()
    ws.open()
    ws.ready()

    expect(t.getConnectionSnapshot()).toBe("connected")
    // First ready = initial connect, not a reconnect.
    expect(onReconnect).not.toHaveBeenCalled()
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it("treats a dropped socket as reconnecting — never logs out or wipes the token", () => {
    const { t, ws } = connectReady()

    ws.drop()

    expect(t.getConnectionSnapshot()).toBe("reconnecting")
    // The token survives a transient drop (this is the whole point of the fix).
    expect(localStorage.getItem("codeg_token")).toBe("tok")
    // Probe is scheduled on backoff, not fired synchronously.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("probes /api/health on backoff and reconnects on 200; the 2nd ready fires reconnect callbacks", async () => {
    const { t, ws } = connectReady()
    const onReconnect = vi.fn()
    const onReady = vi.fn()
    t.onReconnect(onReconnect)
    t.onReady(onReady)
    fetchMock.mockResolvedValue(ok200())

    ws.drop()
    await vi.advanceTimersByTimeAsync(1000) // first backoff tick → probe

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost/api/health",
      expect.objectContaining({ method: "POST" })
    )
    const ws2 = lastWs()
    expect(ws2).not.toBe(ws) // a fresh socket was opened

    ws2.open()
    ws2.ready()
    expect(t.getConnectionSnapshot()).toBe("connected")
    // Reconnect (2nd ready) refreshes consumer state exactly once.
    expect(onReconnect).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it("enters unauthorized on a 401 probe and stops retrying (token left intact)", async () => {
    const { t, ws } = connectReady()
    fetchMock.mockResolvedValue(resp401())

    ws.drop()
    await vi.advanceTimersByTimeAsync(1000)

    expect(t.getConnectionSnapshot()).toBe("unauthorized")
    // markUnauthorized must NOT clear the token — only the user's "Go to
    // login" action does, so a spurious 401 can't silently wipe a session.
    expect(localStorage.getItem("codeg_token")).toBe("tok")

    const callsSoFar = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock.mock.calls.length).toBe(callsSoFar) // no further probing
  })

  it("stays reconnecting on an unreachable probe and keeps backing off", async () => {
    const { t, ws } = connectReady()
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"))

    ws.drop()
    await vi.advanceTimersByTimeAsync(1000) // first probe fails
    expect(t.getConnectionSnapshot()).toBe("reconnecting")
    const calls1 = fetchMock.mock.calls.length

    await vi.advanceTimersByTimeAsync(2000) // second backoff tick (2s)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls1)
    expect(t.getConnectionSnapshot()).toBe("reconnecting")
  })

  it("reconnectNow() probes immediately without waiting for backoff", async () => {
    const { t, ws } = connectReady()
    fetchMock.mockResolvedValue(ok200())

    ws.drop() // schedules a probe at 1s
    t.reconnectNow() // should fire one now and cancel the scheduled one
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const ws2 = lastWs()
    ws2.open()
    ws2.ready()
    expect(t.getConnectionSnapshot()).toBe("connected")
  })

  it("de-dupes concurrent probes (a button mash fires a single fetch)", () => {
    const { t, ws } = connectReady()
    // A probe that never settles, so the in-flight guard stays set.
    fetchMock.mockReturnValue(new Promise(() => {}))

    ws.drop()
    t.reconnectNow()
    t.reconnectNow()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("aborts a hung probe at the timeout and resumes reconnecting", async () => {
    const { t, ws } = connectReady()
    fetchMock.mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          )
        })
    )

    ws.drop()
    await vi.advanceTimersByTimeAsync(1000) // probe starts, fetch hangs
    expect(t.getConnectionSnapshot()).toBe("reconnecting")

    await vi.advanceTimersByTimeAsync(8000) // HEALTH_PROBE_TIMEOUT_MS → abort
    expect(t.getConnectionSnapshot()).toBe("reconnecting") // recovered, not hung
  })

  it("ignores a late onclose after destroy() and schedules nothing", async () => {
    const { t, ws } = connectReady()
    const lateClose = ws.onclose // capture before destroy detaches it

    t.destroy()
    lateClose?.() // simulate the browser's async close landing post-destroy

    expect(t.getConnectionSnapshot()).toBe("connected") // guard short-circuits
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).not.toHaveBeenCalled() // no backoff was scheduled
  })

  it("notifies subscribers on state change and stops after unsubscribe", () => {
    const { t, ws } = connectReady()
    const listener = vi.fn()
    const unsub = t.subscribeConnection(listener)

    ws.drop()
    expect(listener).toHaveBeenCalledTimes(1) // connected → reconnecting

    unsub()
    t.reconnectNow() // would transition, but we're unsubscribed
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("ignores a probe that resolves 200 after a definitive 401 (no resurrection)", async () => {
    const { t, ws } = connectReady()
    let resolveProbe: (v: unknown) => void = () => {}
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveProbe = resolve
      })
    )

    ws.drop()
    await vi.advanceTimersByTimeAsync(1000) // probe starts, stays pending
    expect(t.getConnectionSnapshot()).toBe("reconnecting")

    // A definitive 401 arrives via another path while the probe is in flight.
    t.markUnauthorized()
    expect(t.getConnectionSnapshot()).toBe("unauthorized")

    // The stale probe now resolves 200 — it must NOT reopen the socket.
    resolveProbe(ok200())
    await vi.advanceTimersByTimeAsync(0)
    expect(t.getConnectionSnapshot()).toBe("unauthorized")
    expect(MockWebSocket.instances).toHaveLength(1) // no second socket opened

    const calls = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock.mock.calls.length).toBe(calls) // no further probing
  })

  it("treats a token cleared between probe and reconnect as unauthorized", async () => {
    const { t, ws } = connectReady()
    // The probe succeeds, but the token is gone by the time connectWs runs
    // (e.g. a logout in another tab landed mid-probe).
    fetchMock.mockImplementation(async () => {
      localStorage.removeItem("codeg_token")
      return ok200()
    })

    ws.drop()
    await vi.advanceTimersByTimeAsync(1000)

    // Must not dead-end in "reconnecting" with no socket and no timer.
    expect(t.getConnectionSnapshot()).toBe("unauthorized")
  })

  it("enters reconnecting when the very first connect fails (server unreachable at load)", () => {
    const t = new WebTransport("http://localhost")
    t.eventStream() // opens the socket
    const ws = lastWs()

    ws.drop() // closes before it ever opened or readied
    expect(t.getConnectionSnapshot()).toBe("reconnecting")
    expect(localStorage.getItem("codeg_token")).toBe("tok") // token preserved
  })
})
