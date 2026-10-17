import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type FocusHandler = (event: { payload: boolean }) => void

const fake = vi.hoisted(() => {
  const state = {
    desktop: true,
    platform: "macos" as "macos" | "windows" | "linux",
    focusHandler: null as FocusHandler | null,
    requestUserAttention: vi.fn<(type: number | null) => Promise<void>>(
      async () => {}
    ),
    isFocused: vi.fn(async () => false),
    onFocusChanged: vi.fn(async (handler: FocusHandler) => {
      state.focusHandler = handler
      return () => {}
    }),
  }
  return state
})

vi.mock("./transport", () => ({ isDesktop: () => fake.desktop }))
vi.mock("@/hooks/use-platform", () => ({
  detectPlatform: () => fake.platform,
}))

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    requestUserAttention: fake.requestUserAttention,
    isFocused: fake.isFocused,
    onFocusChanged: fake.onFocusChanged,
  }),
  // The real enum's values.
  UserAttentionType: { Critical: 1, Informational: 2 },
}))

import {
  requestWindowAttention,
  resetWindowAttentionStateForTests,
  withWindowAttentionSuppressed,
} from "./window-attention"
import {
  DEFAULT_WINDOW_ATTENTION_PREFS,
  resetWindowAttentionPrefsCacheForTests,
  saveWindowAttentionPrefs,
  type WindowAttentionPrefs,
} from "./window-attention-prefs"

const CRITICAL = 1
const INFORMATIONAL = 2

function withPrefs(overrides: Partial<WindowAttentionPrefs>) {
  saveWindowAttentionPrefs({
    ...DEFAULT_WINDOW_ATTENTION_PREFS,
    ...overrides,
    levels: {
      ...DEFAULT_WINDOW_ATTENTION_PREFS.levels,
      ...(overrides.levels ?? {}),
    },
  })
}

function setDocumentFocused(focused: boolean) {
  vi.spyOn(document, "hasFocus").mockReturnValue(focused)
}

/** Deliver a native focus change the way Tauri's focus events would. */
function emitNativeFocus(focused: boolean) {
  if (!fake.focusHandler) throw new Error("focus is not being followed")
  fake.focusHandler({ payload: focused })
}

function advance(ms: number) {
  vi.setSystemTime(Date.now() + ms)
}

beforeEach(() => {
  localStorage.clear()
  resetWindowAttentionPrefsCacheForTests()
  resetWindowAttentionStateForTests()
  fake.desktop = true
  fake.platform = "macos"
  fake.focusHandler = null
  fake.requestUserAttention.mockReset()
  fake.requestUserAttention.mockResolvedValue(undefined)
  fake.isFocused.mockReset()
  fake.isFocused.mockResolvedValue(false)
  fake.onFocusChanged.mockReset()
  fake.onFocusChanged.mockImplementation(async (handler: FocusHandler) => {
    fake.focusHandler = handler
    return () => {}
  })
  setDocumentFocused(false)
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-14T00:00:00Z"))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("levels", () => {
  it("asks until the user returns for an event that blocks the agent", async () => {
    await expect(requestWindowAttention("permission_request")).resolves.toBe(
      true
    )
    expect(fake.requestUserAttention).toHaveBeenCalledWith(CRITICAL)
  })

  it("asks once for an event that only reports news", async () => {
    await expect(requestWindowAttention("turn_complete")).resolves.toBe(true)
    expect(fake.requestUserAttention).toHaveBeenCalledWith(INFORMATIONAL)
  })

  it("follows a level the user changed", async () => {
    withPrefs({ levels: { turn_complete: "critical" } as never })
    await requestWindowAttention("turn_complete")
    expect(fake.requestUserAttention).toHaveBeenCalledWith(CRITICAL)
  })
})

describe("preference gates", () => {
  it("does nothing when the master switch is off", async () => {
    withPrefs({ enabled: false })
    await expect(requestWindowAttention("permission_request")).resolves.toBe(
      false
    )
    expect(fake.requestUserAttention).not.toHaveBeenCalled()
  })

  it("silences only the event set to off", async () => {
    withPrefs({ levels: { turn_complete: "off" } as never })
    await expect(requestWindowAttention("turn_complete")).resolves.toBe(false)
    await expect(requestWindowAttention("error")).resolves.toBe(true)
    expect(fake.requestUserAttention).toHaveBeenCalledTimes(1)
  })

  it("never runs in a browser, which has no taskbar entry of its own", async () => {
    fake.desktop = false
    await expect(requestWindowAttention("permission_request")).resolves.toBe(
      false
    )
    expect(fake.requestUserAttention).not.toHaveBeenCalled()
  })

  it("is muted for replayed history", async () => {
    const result = withWindowAttentionSuppressed(() =>
      requestWindowAttention("turn_complete")
    )
    await expect(result).resolves.toBe(false)
    expect(fake.requestUserAttention).not.toHaveBeenCalled()
    // …and only for the replay itself.
    await expect(requestWindowAttention("turn_complete")).resolves.toBe(true)
  })
})

describe("window focus", () => {
  it("leaves a window the user is looking at alone", async () => {
    setDocumentFocused(true)
    await expect(requestWindowAttention("permission_request")).resolves.toBe(
      false
    )
    expect(fake.requestUserAttention).not.toHaveBeenCalled()
  })

  it("trusts the native focus when a child webview holds the document's", async () => {
    // The first request in a window learns where its focus stands. Typing in
    // a built-in browser tab leaves this document unfocused while the window
    // itself is the one in front of the user.
    fake.isFocused.mockResolvedValue(true)
    await expect(requestWindowAttention("permission_request")).resolves.toBe(
      false
    )
    expect(fake.requestUserAttention).not.toHaveBeenCalled()

    emitNativeFocus(false)
    await expect(requestWindowAttention("permission_request")).resolves.toBe(
      true
    )
  })

  it("lets a focus event that raced the initial read win", async () => {
    let answer: (focused: boolean) => void = () => {}
    fake.isFocused.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        })
    )
    const pending = requestWindowAttention("turn_complete")
    await vi.waitFor(() => expect(fake.isFocused).toHaveBeenCalled())
    // The user came back while the stale "not focused" answer was in flight.
    emitNativeFocus(true)
    answer(false)

    await expect(pending).resolves.toBe(false)
    expect(fake.requestUserAttention).not.toHaveBeenCalled()
  })

  it("trusts the initial read over a focus heard while the listeners were added", async () => {
    // Tauri adds the focus listener before the blur one: the user can come
    // back and leave again inside that window, so the focus is heard and the
    // blur is not. The state read once both are in place is the truth.
    fake.onFocusChanged.mockImplementation(async (handler: FocusHandler) => {
      fake.focusHandler = handler
      handler({ payload: true })
      return () => {}
    })
    fake.isFocused.mockResolvedValue(false)

    await expect(requestWindowAttention("turn_complete")).resolves.toBe(true)
    expect(fake.requestUserAttention).toHaveBeenCalledWith(INFORMATIONAL)
  })

  it("withdraws the request once the user is back", async () => {
    await requestWindowAttention("permission_request")
    fake.requestUserAttention.mockClear()

    emitNativeFocus(true)
    expect(fake.requestUserAttention).toHaveBeenCalledTimes(1)
    expect(fake.requestUserAttention).toHaveBeenCalledWith(null)

    // Nothing was raised since, so the next return has nothing to withdraw.
    emitNativeFocus(false)
    emitNativeFocus(true)
    expect(fake.requestUserAttention).toHaveBeenCalledTimes(1)
  })

  it("treats the first event after the user leaves again as news", async () => {
    await requestWindowAttention("turn_complete")
    emitNativeFocus(true)
    emitNativeFocus(false)
    fake.requestUserAttention.mockClear()

    // Well inside the cooldown of the request that brought them back.
    advance(100)
    await expect(requestWindowAttention("turn_complete")).resolves.toBe(true)
    expect(fake.requestUserAttention).toHaveBeenCalledWith(INFORMATIONAL)
  })

  it("still asks when the window's focus cannot be followed", async () => {
    fake.onFocusChanged.mockRejectedValueOnce(new Error("not allowed"))
    await expect(requestWindowAttention("turn_complete")).resolves.toBe(true)
    expect(fake.requestUserAttention).toHaveBeenCalledWith(INFORMATIONAL)
  })
})

describe("throttling", () => {
  it("collapses a burst of the same event", async () => {
    await expect(requestWindowAttention("turn_complete")).resolves.toBe(true)
    advance(1000)
    await expect(requestWindowAttention("turn_complete")).resolves.toBe(false)
    advance(600)
    await expect(requestWindowAttention("turn_complete")).resolves.toBe(true)
    expect(fake.requestUserAttention).toHaveBeenCalledTimes(2)
  })

  it("does not repeat a request right behind one at least as strong", async () => {
    await requestWindowAttention("error")
    advance(50)
    await expect(requestWindowAttention("turn_complete")).resolves.toBe(false)

    advance(1000)
    await requestWindowAttention("permission_request")
    advance(50)
    await expect(requestWindowAttention("background_task")).resolves.toBe(false)
    expect(fake.requestUserAttention).toHaveBeenCalledTimes(2)
  })

  it("lets a stronger request through immediately", async () => {
    // Another session finished a moment ago; this one is now blocked on the
    // user, and a single bounce must become one that lasts.
    await requestWindowAttention("turn_complete")
    advance(50)
    await expect(requestWindowAttention("question_request")).resolves.toBe(true)
    expect(fake.requestUserAttention).toHaveBeenNthCalledWith(1, INFORMATIONAL)
    expect(fake.requestUserAttention).toHaveBeenNthCalledWith(2, CRITICAL)
  })

  it("claims the cooldown before the platform call settles", async () => {
    let settle: () => void = () => {}
    fake.requestUserAttention.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        })
    )
    const first = requestWindowAttention("turn_complete")
    await vi.waitFor(() =>
      expect(fake.requestUserAttention).toHaveBeenCalledTimes(1)
    )

    // The first request's IPC round trip is still pending.
    await expect(requestWindowAttention("turn_complete")).resolves.toBe(false)
    settle()
    await expect(first).resolves.toBe(true)
    expect(fake.requestUserAttention).toHaveBeenCalledTimes(1)
  })
})

describe("a lasting request", () => {
  it("is not cut short by later news on Windows, where a request replaces the last", async () => {
    // FlashWindowEx takes the latest call: a brief flash after the permission
    // prompt's lasting one would leave four blinks while the prompt waits.
    fake.platform = "windows"
    await requestWindowAttention("permission_request")
    advance(500)
    await expect(requestWindowAttention("turn_complete")).resolves.toBe(false)
    advance(5000)
    await expect(requestWindowAttention("error")).resolves.toBe(false)
    expect(fake.requestUserAttention).toHaveBeenCalledTimes(1)
    expect(fake.requestUserAttention).toHaveBeenCalledWith(CRITICAL)

    // Once the user has been back, news asks again.
    emitNativeFocus(true)
    emitNativeFocus(false)
    fake.requestUserAttention.mockClear()
    await expect(requestWindowAttention("turn_complete")).resolves.toBe(true)
    expect(fake.requestUserAttention).toHaveBeenCalledWith(INFORMATIONAL)
  })

  it("still lets later news ask elsewhere, where nothing is replaced", async () => {
    // macOS keeps every Dock request until the app is activated — and a
    // lasting request made while another Codeg window is in front does
    // nothing at all there, so it must not hold anything back.
    for (const platform of ["macos", "linux"] as const) {
      resetWindowAttentionStateForTests()
      fake.platform = platform
      fake.requestUserAttention.mockClear()
      await requestWindowAttention("permission_request")
      advance(500)
      await expect(requestWindowAttention("turn_complete")).resolves.toBe(true)
      expect(fake.requestUserAttention).toHaveBeenNthCalledWith(
        2,
        INFORMATIONAL
      )
      advance(5000)
    }
  })

  it("is forgotten once the user is found in the window, even unheard", async () => {
    // No focus events (the listener could not be added): finding the
    // document focused is proof enough that the flash has ended.
    fake.platform = "windows"
    fake.onFocusChanged.mockRejectedValue(new Error("not allowed"))
    await requestWindowAttention("question_request")

    setDocumentFocused(true)
    await expect(requestWindowAttention("turn_complete")).resolves.toBe(false)
    setDocumentFocused(false)
    advance(2000)
    await expect(requestWindowAttention("turn_complete")).resolves.toBe(true)
    expect(fake.requestUserAttention).toHaveBeenLastCalledWith(INFORMATIONAL)
  })
})

describe("failures", () => {
  it("swallows a platform error", async () => {
    fake.requestUserAttention.mockRejectedValueOnce(new Error("denied"))
    await expect(requestWindowAttention("turn_complete")).resolves.toBe(false)
  })
})
