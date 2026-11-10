import { beforeEach, describe, expect, it, vi } from "vitest"

import { NOTIFY_EVENT_IDS } from "./desktop-notification-prefs"
import {
  ATTENTION_EVENT_IDS,
  DEFAULT_WINDOW_ATTENTION_PREFS,
  getWindowAttentionPrefs,
  loadWindowAttentionPrefs,
  parseWindowAttentionPrefs,
  resetWindowAttentionPrefsCacheForTests,
  saveWindowAttentionPrefs,
  subscribeWindowAttentionPrefs,
} from "./window-attention-prefs"

const STORAGE_KEY = "settings:window-attention:v1"

beforeEach(() => {
  localStorage.clear()
  resetWindowAttentionPrefsCacheForTests()
})

describe("defaults", () => {
  it("lists the same events as desktop notifications", () => {
    // The two sections read as one list; a new notification event must get a
    // level here too, which `Record<NotifyEventId, …>` enforces at compile time.
    expect(ATTENTION_EVENT_IDS).toEqual(NOTIFY_EVENT_IDS)
    expect(Object.keys(DEFAULT_WINDOW_ATTENTION_PREFS.levels).sort()).toEqual(
      [...NOTIFY_EVENT_IDS].sort()
    )
  })

  it("keeps asking for what blocks the agent and asks once for the rest", () => {
    expect(DEFAULT_WINDOW_ATTENTION_PREFS).toEqual({
      enabled: true,
      levels: {
        turn_complete: "informational",
        permission_request: "critical",
        question_request: "critical",
        error: "informational",
        background_task: "informational",
        work_task: "informational",
      },
    })
  })
})

describe("parseWindowAttentionPrefs", () => {
  it("falls back to the defaults for a non-object", () => {
    expect(parseWindowAttentionPrefs(null)).toEqual(
      DEFAULT_WINDOW_ATTENTION_PREFS
    )
    expect(parseWindowAttentionPrefs("nope")).toEqual(
      DEFAULT_WINDOW_ATTENTION_PREFS
    )
  })

  it("degrades field by field rather than discarding the whole set", () => {
    const parsed = parseWindowAttentionPrefs({
      enabled: "yes",
      levels: {
        turn_complete: "off",
        error: "critical",
        permission_request: "loud",
        bogus: "critical",
      },
    })

    // The well-formed fields survive...
    expect(parsed.levels.turn_complete).toBe("off")
    expect(parsed.levels.error).toBe("critical")
    // ...and each malformed one lands on its own default, not on a reset.
    expect(parsed.enabled).toBe(true)
    expect(parsed.levels.permission_request).toBe("critical")
    expect(parsed.levels.question_request).toBe("critical")
    expect(parsed.levels).not.toHaveProperty("bogus")
  })

  it("does not alias the default levels object", () => {
    const parsed = parseWindowAttentionPrefs(undefined)
    parsed.levels.error = "off"
    expect(DEFAULT_WINDOW_ATTENTION_PREFS.levels.error).toBe("informational")
  })
})

describe("storage", () => {
  it("round-trips through localStorage", () => {
    saveWindowAttentionPrefs({
      enabled: false,
      levels: { ...DEFAULT_WINDOW_ATTENTION_PREFS.levels, work_task: "off" },
    })
    resetWindowAttentionPrefsCacheForTests()

    const loaded = loadWindowAttentionPrefs()
    expect(loaded.enabled).toBe(false)
    expect(loaded.levels.work_task).toBe("off")
  })

  it("survives an unparseable value", () => {
    localStorage.setItem(STORAGE_KEY, "{not json")
    expect(loadWindowAttentionPrefs()).toEqual(DEFAULT_WINDOW_ATTENTION_PREFS)
  })
})

describe("shared snapshot", () => {
  it("keeps a stable identity until something writes", () => {
    expect(getWindowAttentionPrefs()).toBe(getWindowAttentionPrefs())
  })

  it("invalidates and notifies on a write from this window", () => {
    const onChange = vi.fn()
    const unsubscribe = subscribeWindowAttentionPrefs(onChange)
    const before = getWindowAttentionPrefs()

    saveWindowAttentionPrefs({ ...before, enabled: false })

    expect(onChange).toHaveBeenCalled()
    expect(getWindowAttentionPrefs()).not.toBe(before)
    expect(getWindowAttentionPrefs().enabled).toBe(false)
    unsubscribe()
  })

  it("follows a write made by another window", () => {
    // The Settings window writes; the workspace window, which only reads,
    // must not keep flashing on a stale copy.
    const onChange = vi.fn()
    const unsubscribe = subscribeWindowAttentionPrefs(onChange)
    getWindowAttentionPrefs()

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_WINDOW_ATTENTION_PREFS, enabled: false })
    )
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }))

    expect(onChange).toHaveBeenCalled()
    expect(getWindowAttentionPrefs().enabled).toBe(false)
    unsubscribe()
  })

  it("starts following other windows on a bare read", async () => {
    // The workspace window never subscribes — it only reads on the event
    // path — so its first read alone must start tracking, or it keeps
    // flashing on a stale copy after Settings switched the feature off. A
    // fresh module instance, because tracking is installed once per module
    // and an earlier test has already installed it on this one.
    vi.resetModules()
    const fresh = await import("./window-attention-prefs")
    expect(fresh.getWindowAttentionPrefs().enabled).toBe(true)

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_WINDOW_ATTENTION_PREFS, enabled: false })
    )
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }))

    expect(fresh.getWindowAttentionPrefs().enabled).toBe(false)
  })

  it("stops notifying after unsubscribe", () => {
    const onChange = vi.fn()
    subscribeWindowAttentionPrefs(onChange)()
    saveWindowAttentionPrefs({
      ...DEFAULT_WINDOW_ATTENTION_PREFS,
      enabled: false,
    })
    expect(onChange).not.toHaveBeenCalled()
  })
})
