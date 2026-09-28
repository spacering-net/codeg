import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const deliver = vi.fn<(title: string, body: string) => Promise<undefined>>(
  async () => undefined
)
const permission = vi.fn<() => string>(() => "managed_by_os")

vi.mock("./notification", () => ({
  deliverSystemNotification: (title: string, body: string) =>
    deliver(title, body),
  getNotificationPermission: () => permission(),
}))

import {
  notifyDesktop,
  resetDesktopNotificationStateForTests,
  withDesktopNotificationsSuppressed,
} from "./desktop-notification"
import {
  DEFAULT_DESKTOP_NOTIFICATION_PREFS,
  resetDesktopNotificationPrefsCacheForTests,
  saveDesktopNotificationPrefs,
  type DesktopNotificationPrefs,
} from "./desktop-notification-prefs"

/** Put the window in a state that satisfies whichever gate is configured. */
function setWindowState({
  hidden,
  focused,
}: {
  hidden: boolean
  focused: boolean
}) {
  Object.defineProperty(document, "hidden", {
    value: hidden,
    configurable: true,
  })
  vi.spyOn(document, "hasFocus").mockReturnValue(focused)
}

function withPrefs(overrides: Partial<DesktopNotificationPrefs>) {
  saveDesktopNotificationPrefs({
    ...DEFAULT_DESKTOP_NOTIFICATION_PREFS,
    ...overrides,
    events: {
      ...DEFAULT_DESKTOP_NOTIFICATION_PREFS.events,
      ...(overrides.events ?? {}),
    },
  })
}

beforeEach(() => {
  localStorage.clear()
  resetDesktopNotificationPrefsCacheForTests()
  resetDesktopNotificationStateForTests()
  deliver.mockClear()
  deliver.mockResolvedValue(undefined)
  permission.mockReturnValue("managed_by_os")
  // The default gate is `hidden`, so every test that doesn't care about the
  // window starts in a state that passes it.
  setWindowState({ hidden: true, focused: false })
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-09-05T00:00:00Z"))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const PAYLOAD = { title: "proj - Codeg", body: "Claude has finished" }

describe("preference gates", () => {
  it("delivers when everything is on", async () => {
    await expect(notifyDesktop("turn_complete", PAYLOAD)).resolves.toBe(true)
    expect(deliver).toHaveBeenCalledWith("proj - Codeg", "Claude has finished")
  })

  it("drops everything when the master switch is off", async () => {
    withPrefs({ enabled: false })
    await expect(notifyDesktop("turn_complete", PAYLOAD)).resolves.toBe(false)
    expect(deliver).not.toHaveBeenCalled()
  })

  it("drops only the event that was turned off", async () => {
    withPrefs({ events: { turn_complete: false } as never })

    await expect(notifyDesktop("turn_complete", PAYLOAD)).resolves.toBe(false)
    await expect(notifyDesktop("error", PAYLOAD)).resolves.toBe(true)
    expect(deliver).toHaveBeenCalledTimes(1)
  })
})

describe("window-state gate", () => {
  it("`hidden` stays silent for a visible but unfocused window", async () => {
    // The reported failure this option exists for: a second-monitor window is
    // not hidden, so the old hard-coded `document.hidden` check never fired.
    setWindowState({ hidden: false, focused: false })
    withPrefs({ when: "hidden" })

    await expect(notifyDesktop("turn_complete", PAYLOAD)).resolves.toBe(false)
  })

  it("`unfocused` fires for that same window", async () => {
    setWindowState({ hidden: false, focused: false })
    withPrefs({ when: "unfocused" })

    await expect(notifyDesktop("turn_complete", PAYLOAD)).resolves.toBe(true)
  })

  it("`unfocused` stays silent while the user is looking at it", async () => {
    setWindowState({ hidden: false, focused: true })
    withPrefs({ when: "unfocused" })

    await expect(notifyDesktop("turn_complete", PAYLOAD)).resolves.toBe(false)
  })

  it("`always` fires even for a focused, visible window", async () => {
    setWindowState({ hidden: false, focused: true })
    withPrefs({ when: "always" })

    await expect(notifyDesktop("turn_complete", PAYLOAD)).resolves.toBe(true)
  })
})

describe("hidden contents", () => {
  it("substitutes the redacted body", async () => {
    withPrefs({ hideBody: true })

    await notifyDesktop("error", {
      title: "t",
      body: "Claude error: 401 Unauthorized",
      redactedBody: "Claude ran into an error",
    })

    expect(deliver).toHaveBeenCalledWith("t", "Claude ran into an error")
  })

  it("keeps a body that has no redacted variant", async () => {
    // A body with nothing to redact — a fixed localized line plus the agent's
    // name — passes through rather than being blanked.
    withPrefs({ hideBody: true })

    await notifyDesktop("turn_complete", PAYLOAD)

    expect(deliver).toHaveBeenCalledWith("proj - Codeg", "Claude has finished")
  })
})

describe("throttling", () => {
  it("collapses a burst of the same event", async () => {
    await notifyDesktop("background_task", PAYLOAD)
    vi.setSystemTime(Date.now() + 1000)
    await notifyDesktop("background_task", PAYLOAD)

    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it("lets the same event through once the cooldown elapses", async () => {
    await notifyDesktop("background_task", PAYLOAD)
    vi.setSystemTime(Date.now() + 3100)
    await notifyDesktop("background_task", PAYLOAD)

    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it("keeps two different events from stacking into one pile", async () => {
    // A failing turn emits `error` and then `turn_complete`.
    await notifyDesktop("error", PAYLOAD)
    await notifyDesktop("turn_complete", PAYLOAD)

    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it("counts a delivery that crossed IPC before its sibling is checked", async () => {
    // Both calls are made in the same tick, before either await resolves. The
    // cooldown stamp has to land before the round trip or both would pass.
    let release: (() => void) | undefined
    deliver.mockImplementationOnce(
      () =>
        new Promise<undefined>(
          (resolve) => (release = () => resolve(undefined))
        )
    )

    const first = notifyDesktop("permission_request", PAYLOAD)
    const second = notifyDesktop("permission_request", PAYLOAD)

    await expect(second).resolves.toBe(false)
    release?.()
    await expect(first).resolves.toBe(true)
    expect(deliver).toHaveBeenCalledTimes(1)
  })
})

describe("suppression", () => {
  it("stays silent during snapshot replay", async () => {
    const results = withDesktopNotificationsSuppressed(() => [
      notifyDesktop("turn_complete", PAYLOAD),
      notifyDesktop("error", PAYLOAD),
    ])

    expect(await Promise.all(results)).toEqual([false, false])
    expect(deliver).not.toHaveBeenCalled()
  })

  it("restores delivery even when the body throws", async () => {
    expect(() =>
      withDesktopNotificationsSuppressed(() => {
        throw new Error("boom")
      })
    ).toThrow("boom")

    await expect(notifyDesktop("turn_complete", PAYLOAD)).resolves.toBe(true)
  })
})

describe("permission", () => {
  it.each(["denied", "unsupported", "default"] as const)(
    "does not attempt delivery when the browser says %s",
    async (state) => {
      permission.mockReturnValue(state)
      await expect(notifyDesktop("turn_complete", PAYLOAD)).resolves.toBe(false)
      expect(deliver).not.toHaveBeenCalled()
    }
  )

  it("spends no cooldown on an undeliverable event", async () => {
    // Otherwise the first event after the user grants permission would be
    // swallowed by a cooldown claimed while nothing could be delivered.
    permission.mockReturnValue("default")
    await notifyDesktop("turn_complete", PAYLOAD)

    permission.mockReturnValue("granted")
    await expect(notifyDesktop("turn_complete", PAYLOAD)).resolves.toBe(true)
  })
})

describe("failure handling", () => {
  it("reports a failed delivery without throwing at the call site", async () => {
    deliver.mockRejectedValueOnce(new Error("notification centre said no"))
    await expect(notifyDesktop("turn_complete", PAYLOAD)).resolves.toBe(false)
  })
})
