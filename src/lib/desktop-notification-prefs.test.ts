import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  DEFAULT_DESKTOP_NOTIFICATION_PREFS,
  getDesktopNotificationPrefs,
  loadDesktopNotificationPrefs,
  parseDesktopNotificationPrefs,
  resetDesktopNotificationPrefsCacheForTests,
  saveDesktopNotificationPrefs,
  subscribeDesktopNotificationPrefs,
} from "./desktop-notification-prefs"

const STORAGE_KEY = "settings:desktop-notification:v1"

beforeEach(() => {
  localStorage.clear()
  resetDesktopNotificationPrefsCacheForTests()
})

describe("defaults", () => {
  it("preserves the behaviour that shipped before the preference existed", () => {
    // Desktop notifications already worked. The release that introduced this
    // file must not be the one that silently stops delivering them, so the
    // defaults spell out the old hard-coded behaviour: everything on, gated on
    // `document.hidden`.
    expect(DEFAULT_DESKTOP_NOTIFICATION_PREFS).toEqual({
      enabled: true,
      when: "hidden",
      hideBody: false,
      events: {
        turn_complete: true,
        permission_request: true,
        question_request: true,
        error: true,
        background_task: true,
        work_task: true,
      },
    })
  })
})

describe("parseDesktopNotificationPrefs", () => {
  it("falls back to the defaults for a non-object", () => {
    expect(parseDesktopNotificationPrefs(null)).toEqual(
      DEFAULT_DESKTOP_NOTIFICATION_PREFS
    )
    expect(parseDesktopNotificationPrefs("nope")).toEqual(
      DEFAULT_DESKTOP_NOTIFICATION_PREFS
    )
  })

  it("degrades field by field rather than discarding the whole set", () => {
    const parsed = parseDesktopNotificationPrefs({
      enabled: false,
      when: "sideways",
      hideBody: "yes",
      events: { error: false, question_request: "maybe", bogus: false },
    })

    // The two well-formed fields survive...
    expect(parsed.enabled).toBe(false)
    expect(parsed.events.error).toBe(false)
    // ...and each malformed one lands on its own default, not on a reset.
    expect(parsed.when).toBe("hidden")
    expect(parsed.hideBody).toBe(false)
    expect(parsed.events.question_request).toBe(true)
    expect(parsed).not.toHaveProperty("bogus")
  })

  it("keeps an unknown event out of the parsed set", () => {
    const parsed = parseDesktopNotificationPrefs({
      events: { future_event: true },
    })
    expect(Object.keys(parsed.events).sort()).toEqual(
      Object.keys(DEFAULT_DESKTOP_NOTIFICATION_PREFS.events).sort()
    )
  })

  it("does not alias the default events object", () => {
    const parsed = parseDesktopNotificationPrefs(undefined)
    parsed.events.error = false
    expect(DEFAULT_DESKTOP_NOTIFICATION_PREFS.events.error).toBe(true)
  })
})

describe("storage", () => {
  it("round-trips through localStorage", () => {
    saveDesktopNotificationPrefs({
      ...DEFAULT_DESKTOP_NOTIFICATION_PREFS,
      when: "always",
      hideBody: true,
    })
    resetDesktopNotificationPrefsCacheForTests()

    const loaded = loadDesktopNotificationPrefs()
    expect(loaded.when).toBe("always")
    expect(loaded.hideBody).toBe(true)
  })

  it("survives an unparseable value", () => {
    localStorage.setItem(STORAGE_KEY, "{not json")
    expect(loadDesktopNotificationPrefs()).toEqual(
      DEFAULT_DESKTOP_NOTIFICATION_PREFS
    )
  })
})

describe("shared snapshot", () => {
  it("keeps a stable identity until something writes", () => {
    // `useSyncExternalStore` re-renders forever if the snapshot's identity
    // changes on every read.
    expect(getDesktopNotificationPrefs()).toBe(getDesktopNotificationPrefs())
  })

  it("invalidates and notifies on a write from this window", () => {
    const onChange = vi.fn()
    const unsubscribe = subscribeDesktopNotificationPrefs(onChange)
    const before = getDesktopNotificationPrefs()

    saveDesktopNotificationPrefs({ ...before, enabled: false })

    expect(onChange).toHaveBeenCalled()
    expect(getDesktopNotificationPrefs()).not.toBe(before)
    expect(getDesktopNotificationPrefs().enabled).toBe(false)
    unsubscribe()
  })

  it("follows a write made by another window", () => {
    const onChange = vi.fn()
    const unsubscribe = subscribeDesktopNotificationPrefs(onChange)
    getDesktopNotificationPrefs()

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_DESKTOP_NOTIFICATION_PREFS, when: "always" })
    )
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }))

    expect(onChange).toHaveBeenCalled()
    expect(getDesktopNotificationPrefs().when).toBe("always")
    unsubscribe()
  })

  it("stops notifying after unsubscribe", () => {
    const onChange = vi.fn()
    subscribeDesktopNotificationPrefs(onChange)()
    saveDesktopNotificationPrefs({
      ...DEFAULT_DESKTOP_NOTIFICATION_PREFS,
      enabled: false,
    })
    expect(onChange).not.toHaveBeenCalled()
  })
})
