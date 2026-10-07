import { renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useWakeResync } from "./use-wake-resync"

const onReconnectCallbacks = new Set<() => void>()
// False models an IPC-only transport (the local desktop app), where
// `onTransportReconnect` returns null: there is no reconnect lifecycle.
let hasReconnectLifecycle = true
const onTransportReconnect = vi.fn((cb: () => void) => {
  if (!hasReconnectLifecycle) return null
  onReconnectCallbacks.add(cb)
  return () => {
    onReconnectCallbacks.delete(cb)
  }
})

vi.mock("@/lib/platform", () => ({
  onTransportReconnect: (cb: () => void) => onTransportReconnect(cb),
}))

function fireVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event("visibilitychange"))
}

// The page comes back after being hidden for `hiddenMs` — long enough by
// default to count as a wake from sleep.
function fireWake(hiddenMs = 30_000) {
  fireVisibility("hidden")
  vi.advanceTimersByTime(hiddenMs)
  fireVisibility("visible")
}

function fireReconnect() {
  for (const cb of onReconnectCallbacks) cb()
}

// Let a settled refetch's result reach the hook.
async function flush() {
  await vi.advanceTimersByTimeAsync(0)
}

// Whether the turn that settles left its live message on the connection.
// False by default: the sleep case, where the re-attach reports the turn over.
let turnReachedView = false

type WakeResyncProps = Parameters<typeof useWakeResync>[0]

function setup(initial?: Partial<WakeResyncProps>) {
  // Lands by default, like a refetch over a working link.
  const refetch = vi.fn(async () => true)
  const base: WakeResyncProps = {
    enabled: true,
    conversationId: 7,
    isStreaming: false,
    turnReachedView: () => turnReachedView,
    refetch,
  }
  const view = renderHook((props: WakeResyncProps) => useWakeResync(props), {
    initialProps: { ...base, ...initial },
  })
  return {
    refetch,
    rerender: (next: Partial<WakeResyncProps>) =>
      view.rerender({ ...base, ...next }),
  }
}

describe("useWakeResync", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    hasReconnectLifecycle = true
    turnReachedView = false
    onReconnectCallbacks.clear()
    onTransportReconnect.mockClear()
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("refetches when the page comes back from a long absence (wake)", () => {
    const { refetch } = setup()
    fireWake()
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(refetch).toHaveBeenCalledWith(7)
  })

  it("ignores a quick tab or window switch, and window focus alone", () => {
    // Nothing is lost while the socket stays up, and each resync is a full
    // transcript refetch the status bar reports while it runs.
    const { refetch } = setup()
    fireWake(29_999)
    window.dispatchEvent(new Event("focus"))
    expect(refetch).not.toHaveBeenCalled()
  })

  it("does not refetch when the page is hidden", () => {
    const { refetch } = setup()
    fireVisibility("hidden")
    vi.advanceTimersByTime(60_000)
    expect(refetch).not.toHaveBeenCalled()
  })

  it("refetches on transport reconnect", () => {
    const { refetch } = setup()
    expect(onTransportReconnect).toHaveBeenCalledTimes(1)
    fireReconnect()
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it("stays inert on a transport with no reconnect lifecycle (local desktop)", () => {
    // Local IPC loses nothing across sleep; a refetch there could only race
    // the transcript flush of a turn that just ended.
    hasReconnectLifecycle = false
    const { refetch } = setup()
    fireWake()
    expect(refetch).not.toHaveBeenCalled()
  })

  it("holds a wake that lands mid-stream and releases it when the stream settles", () => {
    const { refetch, rerender } = setup({ isStreaming: true })
    fireWake()
    // Mid-stream: never refetch under a live stream.
    expect(refetch).not.toHaveBeenCalled()
    // Stream settles (isStreaming -> false): the held wake fires by itself —
    // after sleep this is the only chance, no later trigger is coming.
    rerender({ isStreaming: false })
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(refetch).toHaveBeenCalledWith(7)
    // Released once: a later settle without a new trigger stays quiet.
    rerender({ isStreaming: true })
    rerender({ isStreaming: false })
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it("holds a reconnect that arrives while the client still believes it is streaming", () => {
    // The sleep case: the turn ended server-side while the socket was dead,
    // so the client is still `prompting` when the WS comes back. The
    // reconnect callback fires BEFORE the re-attach snapshot flips the
    // status — it must wait for that flip, not be lost.
    const { refetch, rerender } = setup({ isStreaming: true })
    fireReconnect()
    expect(refetch).not.toHaveBeenCalled()
    rerender({ isStreaming: false })
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it("drops a held reconnect when the turn it arrived in ends in view", () => {
    // The reconnect came mid-turn and the stream carried on: the turn's end
    // reached the view, `completeTurn` promotes its complete reply, and the
    // agent may still be flushing that reply to its transcript — a refetch
    // now could only replace it with a truncated read.
    const { refetch, rerender } = setup({ isStreaming: true })
    fireReconnect()
    vi.advanceTimersByTime(3_000)
    turnReachedView = true
    rerender({ isStreaming: false })
    expect(refetch).not.toHaveBeenCalled()
  })

  it("lets a hold lapse when the turn keeps streaming past it", () => {
    // The turn was genuinely live: its content reached the view through the
    // stream, and a refetch at its natural end would race the agent's
    // transcript flush.
    const { refetch, rerender } = setup({ isStreaming: true })
    fireReconnect()
    vi.advanceTimersByTime(10_001)
    rerender({ isStreaming: false })
    expect(refetch).not.toHaveBeenCalled()
  })

  it("re-arms the hold on each trigger, so a reconnect after the wake counts from its own arrival", () => {
    const { refetch, rerender } = setup({ isStreaming: true })
    fireWake() // lid opened; the dead socket is not replaced yet
    vi.advanceTimersByTime(8_000)
    fireReconnect() // replaced; its re-attach is on the way
    vi.advanceTimersByTime(5_000)
    rerender({ isStreaming: false }) // the re-attach settles the stale turn
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it("skips a wake that comes right after a turn settled on its own", () => {
    // The user comes back on the turn's completion notification: the reply
    // arrived live, and the agent may still be flushing it to its transcript,
    // so a refetch now could only replace it with a truncated read.
    const { refetch, rerender } = setup({ isStreaming: true })
    fireVisibility("hidden")
    vi.advanceTimersByTime(60_000)
    rerender({ isStreaming: false }) // the turn completes while away
    vi.advanceTimersByTime(3_000)
    fireVisibility("visible")
    expect(refetch).not.toHaveBeenCalled()
    // Past the quiet period a trigger refetches again.
    vi.advanceTimersByTime(7_000)
    fireReconnect()
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it("keeps counting an absence across re-binds", () => {
    // The turn ends while the page is away (isStreaming flips, the listeners
    // re-bind); the wake that follows still sees the whole absence.
    const { refetch, rerender } = setup({ isStreaming: true })
    fireVisibility("hidden")
    vi.advanceTimersByTime(20_000)
    rerender({ isStreaming: false })
    vi.advanceTimersByTime(20_000)
    fireVisibility("visible")
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it("forgets a held trigger when the conversation changes", () => {
    const { refetch, rerender } = setup({ isStreaming: true })
    fireWake()
    rerender({ conversationId: 8, isStreaming: false })
    // The wake was owed to conversation 7; it must not fire against 8.
    expect(refetch).not.toHaveBeenCalled()
  })

  it("debounces a wake and the reconnect that follows it to one refetch", async () => {
    const { refetch } = setup()
    fireWake()
    await flush()
    fireReconnect()
    expect(refetch).toHaveBeenCalledTimes(1)
    // After the debounce window a new trigger fires again.
    vi.advanceTimersByTime(2_100)
    fireReconnect()
    expect(refetch).toHaveBeenCalledTimes(2)
  })

  it("lets the reconnect through when the wake's refetch failed", async () => {
    // Shown again while the Wi-Fi is still coming back: the wake's refetch
    // fails, and the store does not retry it. The reconnect a second later is
    // what recovers the transcript, so it must not be debounced away.
    const { refetch } = setup()
    refetch.mockResolvedValueOnce(false)
    fireWake()
    await flush()
    vi.advanceTimersByTime(1_000)
    fireReconnect()
    expect(refetch).toHaveBeenCalledTimes(2)
    await flush()
    // That one landed, so it debounces as usual.
    fireReconnect()
    expect(refetch).toHaveBeenCalledTimes(2)
  })

  it("issues a fresh refetch for a trigger that arrives while one is still in flight", () => {
    // The wake's refetch may hang on the link that was down; the reconnect
    // proves the link is back, and its refetch supersedes the stuck one.
    const { refetch } = setup()
    refetch.mockReturnValueOnce(new Promise<boolean>(() => {}))
    fireWake()
    fireReconnect()
    expect(refetch).toHaveBeenCalledTimes(2)
  })

  it("does not fire when disabled (background tab)", () => {
    const { refetch } = setup({ enabled: false })
    fireWake()
    fireReconnect()
    expect(refetch).not.toHaveBeenCalled()
  })

  it("does not fire without a conversation id", () => {
    const { refetch } = setup({ conversationId: null })
    fireWake()
    fireReconnect()
    expect(refetch).not.toHaveBeenCalled()
  })
})
