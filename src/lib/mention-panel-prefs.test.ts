import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  DEFAULT_MENTION_PANEL_PREFS,
  getMentionPanelPrefs,
  loadMentionPanelPrefs,
  MENTION_TAB_KINDS,
  parseMentionPanelPrefs,
  resetMentionPanelPrefs,
  resetMentionPanelPrefsCacheForTests,
  saveMentionPanelPrefs,
  subscribeMentionPanelPrefs,
  useVisibleMentionTabs,
  visibleMentionTabKinds,
  type MentionPanelPrefs,
} from "./mention-panel-prefs"

const KEY = "settings:mention-panel:v1"

const custom: MentionPanelPrefs = {
  tabs: [
    { kind: "file", visible: true },
    { kind: "commit", visible: true },
    { kind: "agent", visible: false },
    { kind: "assistant", visible: true },
    { kind: "session", visible: true },
  ],
}

/** What another window writing the key looks like from this one. */
function writeFromAnotherWindow(key: string | null, value: string | null) {
  if (key !== null) {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  }
  window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }))
}

describe("mention panel preferences", () => {
  beforeEach(() => {
    localStorage.clear()
    resetMentionPanelPrefsCacheForTests()
  })

  it("defaults to every tab, shown, agent first", () => {
    expect(loadMentionPanelPrefs()).toEqual(DEFAULT_MENTION_PANEL_PREFS)
    expect(visibleMentionTabKinds(loadMentionPanelPrefs())).toEqual([
      "agent",
      "assistant",
      "file",
      "session",
      "commit",
    ])
  })

  it("never hands out the shared default object", () => {
    const loaded = loadMentionPanelPrefs()
    loaded.tabs[0].visible = false
    loaded.tabs.reverse()
    expect(DEFAULT_MENTION_PANEL_PREFS.tabs[0]).toEqual({
      kind: "agent",
      visible: true,
    })
  })

  it("round-trips an order and its visibility", () => {
    saveMentionPanelPrefs(custom)
    expect(loadMentionPanelPrefs()).toEqual(custom)
    expect(visibleMentionTabKinds(loadMentionPanelPrefs())).toEqual([
      "file",
      "commit",
      "assistant",
      "session",
    ])
  })

  it("never hides the file tab, whatever is stored", () => {
    const parsed = parseMentionPanelPrefs({
      tabs: [{ kind: "file", visible: false }],
    })
    expect(parsed.tabs.find((tab) => tab.kind === "file")?.visible).toBe(true)

    // Writes are normalized too, so the stored value can't say otherwise.
    saveMentionPanelPrefs({
      tabs: custom.tabs.map((tab) => ({ ...tab, visible: false })),
    })
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "null")
    expect(stored.tabs).toContainEqual({ kind: "file", visible: true })
  })

  it("drops unknown and repeated kinds, and adds missing ones beside their neighbours, shown", () => {
    const parsed = parseMentionPanelPrefs({
      tabs: [
        { kind: "commit", visible: false },
        { kind: "browser", visible: true },
        "agent",
        null,
        { kind: "commit", visible: true },
        { kind: "session", visible: "nope" },
      ],
    })
    expect(parsed.tabs).toEqual([
      // Kinds the value never mentioned (a tab added after it was written)
      // join right after the nearest kind before them in the built-in order
      // that is there — first when none is — shown.
      { kind: "agent", visible: true },
      { kind: "assistant", visible: true },
      { kind: "file", visible: true },
      // First occurrence wins.
      { kind: "commit", visible: false },
      // Only an explicit `false` hides a tab.
      { kind: "session", visible: true },
    ])
  })

  it("reads a list written before the assistant tab as the built-in one", () => {
    const old = parseMentionPanelPrefs({
      tabs: ["agent", "file", "session", "commit"].map((kind) => ({
        kind,
        visible: true,
      })),
    })
    // So "Reset" does not light up for someone who never customized it.
    expect(old).toEqual(DEFAULT_MENTION_PANEL_PREFS)
  })

  it("puts a new tab after its neighbour, a hidden one included", () => {
    const parsed = parseMentionPanelPrefs({
      tabs: [
        { kind: "file", visible: true },
        { kind: "agent", visible: false },
        { kind: "session", visible: true },
        { kind: "commit", visible: true },
      ],
    })
    expect(parsed.tabs.map((tab) => tab.kind)).toEqual([
      "file",
      "agent",
      "assistant",
      "session",
      "commit",
    ])
    expect(parsed.tabs[2]).toEqual({ kind: "assistant", visible: true })
  })

  it("changes nothing on a second pass", () => {
    const once = parseMentionPanelPrefs({
      tabs: [
        { kind: "commit", visible: true },
        { kind: "file", visible: false },
        { kind: "file", visible: true },
      ],
    })
    expect(parseMentionPanelPrefs(once)).toEqual(once)
    // The file tab cannot be hidden, by a duplicate or otherwise.
    expect(once.tabs.find((tab) => tab.kind === "file")?.visible).toBe(true)
  })

  it("falls back to the defaults on a corrupt or unreadable value", () => {
    localStorage.setItem(KEY, "{not json")
    expect(loadMentionPanelPrefs()).toEqual(DEFAULT_MENTION_PANEL_PREFS)

    localStorage.setItem(KEY, JSON.stringify({ tabs: "agent,file" }))
    expect(loadMentionPanelPrefs()).toEqual(DEFAULT_MENTION_PANEL_PREFS)

    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("denied", "SecurityError")
      })
    try {
      expect(loadMentionPanelPrefs()).toEqual(DEFAULT_MENTION_PANEL_PREFS)
    } finally {
      getItem.mockRestore()
    }
  })

  it("reset drops the stored value so the built-in order applies again", () => {
    saveMentionPanelPrefs(custom)
    const listener = vi.fn()
    const unsubscribe = subscribeMentionPanelPrefs(listener)
    resetMentionPanelPrefs()
    unsubscribe()
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(getMentionPanelPrefs()).toEqual(DEFAULT_MENTION_PANEL_PREFS)
    expect(listener).toHaveBeenCalled()
  })

  it("lists every tab kind exactly once", () => {
    expect(new Set(MENTION_TAB_KINDS).size).toBe(MENTION_TAB_KINDS.length)
    expect(MENTION_TAB_KINDS).not.toContain("skill")
  })

  describe("shared snapshot", () => {
    it("picks up a save in this window", () => {
      const before = getMentionPanelPrefs()
      const listener = vi.fn()
      const unsubscribe = subscribeMentionPanelPrefs(listener)
      saveMentionPanelPrefs(custom)
      unsubscribe()
      expect(listener).toHaveBeenCalledTimes(1)
      expect(getMentionPanelPrefs()).not.toBe(before)
      expect(getMentionPanelPrefs()).toEqual(custom)
    })

    it("picks up another window's write from storage, not from the event", () => {
      const listener = vi.fn()
      const unsubscribe = subscribeMentionPanelPrefs(listener)
      getMentionPanelPrefs()
      // `storage` events are queued: this one describes a write that a later
      // one has already replaced. The store has to hold what storage holds.
      localStorage.setItem(KEY, JSON.stringify(custom))
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: KEY,
          newValue: JSON.stringify(DEFAULT_MENTION_PANEL_PREFS),
        })
      )
      unsubscribe()
      expect(listener).toHaveBeenCalledTimes(1)
      expect(getMentionPanelPrefs()).toEqual(custom)
    })

    it("keeps its identity, and stays quiet, when nothing it holds changed", () => {
      saveMentionPanelPrefs(custom)
      const before = getMentionPanelPrefs()
      const listener = vi.fn()
      const unsubscribe = subscribeMentionPanelPrefs(listener)

      // Another window writing some other key — drafts are saved as you type.
      writeFromAnotherWindow("message-input-draft", "hello")
      // The same value written again.
      saveMentionPanelPrefs(custom)
      writeFromAnotherWindow(KEY, JSON.stringify(custom))

      unsubscribe()
      expect(listener).not.toHaveBeenCalled()
      expect(getMentionPanelPrefs()).toBe(before)
    })

    it("re-reads after another window clears storage wholesale", () => {
      saveMentionPanelPrefs(custom)
      getMentionPanelPrefs()
      const listener = vi.fn()
      const unsubscribe = subscribeMentionPanelPrefs(listener)
      localStorage.clear()
      writeFromAnotherWindow(null, null)
      unsubscribe()
      expect(listener).toHaveBeenCalledTimes(1)
      expect(getMentionPanelPrefs()).toEqual(DEFAULT_MENTION_PANEL_PREFS)
    })

    it("hands a hook a visible-tab list that only changes with the value", () => {
      const { result } = renderHook(() => useVisibleMentionTabs())
      const first = result.current
      expect(first).toEqual(["agent", "assistant", "file", "session", "commit"])

      act(() => writeFromAnotherWindow("unrelated", "x"))
      expect(result.current).toBe(first)

      act(() => saveMentionPanelPrefs(custom))
      expect(result.current).toEqual(["file", "commit", "assistant", "session"])
    })
  })
})
