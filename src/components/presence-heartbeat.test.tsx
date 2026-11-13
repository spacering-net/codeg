import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({
  personalAgentPresence: vi.fn<
    (
      window: string,
      focused: boolean,
      idleMs: number | null,
      typedMs?: number | null,
      viewing?: number | null,
      viewingConversation?: number | null
    ) => Promise<{ present: boolean; last_active: string | null }>
  >(async () => ({ present: true, last_active: null })),
}))
vi.mock("@/lib/api", () => api)

import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"
import { useTabStore } from "@/stores/tab-store"
import { useWorkbenchRouteStore } from "@/stores/workbench-route-store"

import {
  BEAT_EVERY_MS,
  FRESH_AFTER_MS,
  isTyping,
  skipsPresence,
  startPresenceHeartbeat,
} from "./presence-heartbeat"

let hasFocus = true
let stop: (() => void) | null = null

/** The beats sent so far: `[focused, idleMs]`. */
function beats(): [boolean, number | null][] {
  return api.personalAgentPresence.mock.calls.map(
    (c) => [c[1], c[2]] as [boolean, number | null]
  )
}

async function flush() {
  // Each beat goes out on a microtask.
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-11-11T09:00:00Z"))
  hasFocus = true
  vi.spyOn(document, "hasFocus").mockImplementation(() => hasFocus)
  window.history.replaceState(null, "", "/workspace")
})

afterEach(() => {
  stop?.()
  stop = null
  usePersonalAgentUi.setState({ viewing: null })
  useWorkbenchRouteStore.setState({ route: null })
  useTabStore.setState({ tabs: [], activeTabId: null })
  document.body.innerHTML = ""
  vi.useRealTimers()
  vi.restoreAllMocks()
  api.personalAgentPresence.mockClear()
})

describe("the presence heartbeat", () => {
  it("beats at once, and again on focus and blur", async () => {
    stop = startPresenceHeartbeat()
    await flush()
    // Opening with the focus is the owner at the window.
    expect(beats()).toEqual([[true, 0]])
    vi.advanceTimersByTime(1_000)
    window.dispatchEvent(new Event("blur"))
    window.dispatchEvent(new Event("focus"))
    await flush()
    expect(beats()).toEqual([
      [true, 0],
      [false, 1_000],
      [true, 0],
    ])
    // One window, one id.
    const ids = new Set(api.personalAgentPresence.mock.calls.map((c) => c[0]))
    expect(ids.size).toBe(1)
  })

  it("sends how long since the last input, every 30 s while focused", async () => {
    hasFocus = false
    stop = startPresenceHeartbeat()
    await flush()
    expect(beats()).toEqual([[false, null]])
    hasFocus = true
    api.personalAgentPresence.mockClear()
    // The first input after a quiet start goes out at once.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }))
    await flush()
    expect(beats()).toEqual([[true, 0]])
    // More input soon after waits for the next regular beat.
    vi.advanceTimersByTime(5_000)
    window.dispatchEvent(new Event("pointerdown"))
    await flush()
    expect(beats()).toHaveLength(1)
    vi.advanceTimersByTime(BEAT_EVERY_MS - 5_000)
    await flush()
    expect(beats()[1]).toEqual([true, BEAT_EVERY_MS - 5_000])
    // Quiet for a while: the next input is sent at once.
    vi.advanceTimersByTime(FRESH_AFTER_MS + BEAT_EVERY_MS)
    await flush()
    api.personalAgentPresence.mockClear()
    window.dispatchEvent(new Event("wheel"))
    await flush()
    expect(beats()).toEqual([[true, 0]])
  })

  it("counts no input while the window is in the background", async () => {
    stop = startPresenceHeartbeat()
    await flush()
    hasFocus = false
    window.dispatchEvent(new Event("blur"))
    await flush()
    api.personalAgentPresence.mockClear()
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }))
    window.dispatchEvent(new Event("pointermove"))
    vi.advanceTimersByTime(BEAT_EVERY_MS * 3)
    await flush()
    // No input counted, no regular beats.
    expect(beats()).toEqual([])
    hasFocus = true
    window.dispatchEvent(new Event("focus"))
    await flush()
    expect(beats()).toEqual([[true, 0]])
  })

  it("coming back to the window after a long while is the owner at it", async () => {
    stop = startPresenceHeartbeat()
    await flush()
    hasFocus = false
    window.dispatchEvent(new Event("blur"))
    vi.advanceTimersByTime(5 * 60_000)
    await flush()
    api.personalAgentPresence.mockClear()
    // Back through the window switcher: no key, no pointer.
    hasFocus = true
    window.dispatchEvent(new Event("focus"))
    await flush()
    expect(beats()).toEqual([[true, 0]])
    // Nothing more: the regular beats tell the idle time growing, and the
    // backend counts it away past two minutes.
    vi.advanceTimersByTime(BEAT_EVERY_MS * 5)
    await flush()
    const sent = beats()
    expect(sent[sent.length - 1]).toEqual([true, BEAT_EVERY_MS * 5])
    // A shown tab with the focus is the same.
    api.personalAgentPresence.mockClear()
    document.dispatchEvent(new Event("visibilitychange"))
    await flush()
    expect(beats()).toEqual([[true, 0]])
  })

  it("stops when the window goes", async () => {
    stop = startPresenceHeartbeat()
    await flush()
    stop()
    stop = null
    api.personalAgentPresence.mockClear()
    window.dispatchEvent(new Event("focus"))
    vi.advanceTimersByTime(BEAT_EVERY_MS * 2)
    await flush()
    expect(beats()).toEqual([])
  })

  it("leaves out the windows that are not the owner at work", async () => {
    for (const path of [
      "/login",
      "/pet",
      "/pet/",
      "/computer-indicator",
      "/computer-marker",
    ]) {
      expect(skipsPresence(path)).toBe(true)
    }
    for (const path of ["/", "/workspace", "/settings", "/petting"]) {
      expect(skipsPresence(path)).toBe(false)
    }
    window.history.replaceState(null, "", "/pet")
    stop = startPresenceHeartbeat()
    window.dispatchEvent(new Event("focus"))
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }))
    vi.advanceTimersByTime(BEAT_EVERY_MS)
    await flush()
    expect(beats()).toEqual([])
  })

  it("never lets a failed beat out", async () => {
    api.personalAgentPresence.mockRejectedValueOnce(new Error("offline"))
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    stop = startPresenceHeartbeat()
    await flush()
    await flush()
    expect(errors).not.toHaveBeenCalled()
  })

  it("tells how long since the owner typed into something editable", async () => {
    stop = startPresenceHeartbeat()
    await flush()
    // A key on the page itself is input, not typing.
    expect(api.personalAgentPresence.mock.calls[0][3]).toBeNull()
    const box = document.createElement("textarea")
    document.body.appendChild(box)
    vi.advanceTimersByTime(2_000)
    api.personalAgentPresence.mockClear()
    // The first typing goes out at once, though input went out just now.
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }))
    await flush()
    expect(api.personalAgentPresence.mock.calls).toHaveLength(1)
    expect(api.personalAgentPresence.mock.calls[0][3]).toBe(0)
    // More typing waits for the regular beat, which carries its age.
    vi.advanceTimersByTime(4_000)
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }))
    await flush()
    expect(api.personalAgentPresence.mock.calls).toHaveLength(1)
    vi.advanceTimersByTime(BEAT_EVERY_MS - 6_000)
    await flush()
    expect(api.personalAgentPresence.mock.calls[1][3]).toBe(
      BEAT_EVERY_MS - 6_000
    )
    // Not typing: a checkbox, a read-only field, a plain element.
    const check = document.createElement("input")
    check.type = "checkbox"
    const ro = document.createElement("input")
    ro.readOnly = true
    expect(isTyping(check)).toBe(false)
    expect(isTyping(ro)).toBe(false)
    expect(isTyping(document.createElement("div"))).toBe(false)
    expect(isTyping(document.createElement("input"))).toBe(true)
    const editable = document.createElement("div")
    editable.contentEditable = "true"
    // jsdom does not compute isContentEditable.
    Object.defineProperty(editable, "isContentEditable", { value: true })
    expect(isTyping(editable)).toBe(true)
  })

  it("says which assistant it shows, at once when that changes", async () => {
    stop = startPresenceHeartbeat()
    await flush()
    expect(api.personalAgentPresence.mock.calls[0][4]).toBeNull()
    api.personalAgentPresence.mockClear()
    usePersonalAgentUi.getState().setViewing(7)
    await flush()
    expect(api.personalAgentPresence.mock.calls).toHaveLength(1)
    expect(api.personalAgentPresence.mock.calls[0][4]).toBe(7)
    // The same again is no change.
    usePersonalAgentUi.getState().setViewing(7)
    await flush()
    expect(api.personalAgentPresence.mock.calls).toHaveLength(1)
    usePersonalAgentUi.getState().setViewing(null)
    await flush()
    expect(api.personalAgentPresence.mock.calls[1][4]).toBeNull()
  })

  it("says which session the conversations show, only while they show", async () => {
    useTabStore.setState({
      tabs: [{ id: "t1", conversationId: 9 }] as never,
      activeTabId: "t1",
    })
    // No workbench in this window: no session in front.
    stop = startPresenceHeartbeat()
    await flush()
    expect(api.personalAgentPresence.mock.calls[0][5]).toBeNull()
    api.personalAgentPresence.mockClear()
    useWorkbenchRouteStore.setState({ route: "conversations" })
    await flush()
    expect(api.personalAgentPresence.mock.calls).toHaveLength(1)
    expect(api.personalAgentPresence.mock.calls[0][5]).toBe(9)
    // Today, the board or another page over them: the session is hidden.
    useWorkbenchRouteStore.setState({ route: "tasks" })
    await flush()
    expect(api.personalAgentPresence.mock.calls[1][5]).toBeNull()
  })
})
