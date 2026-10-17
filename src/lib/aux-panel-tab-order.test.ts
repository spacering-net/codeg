import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  AUX_PANEL_TABS,
  DEFAULT_AUX_TAB_ORDER,
  getAuxTabOrder,
  loadAuxTabOrder,
  moveAuxTab,
  parseAuxTabOrder,
  resetAuxTabOrderCacheForTests,
  saveAuxTabOrder,
  subscribeAuxTabOrder,
  useAuxTabOrder,
  type AuxTabOrder,
} from "./aux-panel-tab-order"

const KEY = "workspace:right-sidebar-tab-order"

const custom: AuxTabOrder = [
  "git_log",
  "file_tree",
  "session_details",
  "changes",
]

/** What another window writing the key looks like from this one. */
function writeFromAnotherWindow(key: string | null, value: string | null) {
  if (key !== null) {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  }
  window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }))
}

function denyStorage(method: "getItem" | "setItem" | "removeItem") {
  return vi.spyOn(Storage.prototype, method).mockImplementation(() => {
    throw new DOMException("denied", "QuotaExceededError")
  })
}

describe("aux panel tab order", () => {
  beforeEach(() => {
    localStorage.clear()
    resetAuxTabOrderCacheForTests()
    vi.restoreAllMocks()
  })

  it("defaults to the built-in order: session details, files, changes, commits", () => {
    expect(loadAuxTabOrder()).toEqual([
      "session_details",
      "file_tree",
      "changes",
      "git_log",
    ])
    expect(DEFAULT_AUX_TAB_ORDER).toEqual(AUX_PANEL_TABS)
  })

  it("round-trips a custom order", () => {
    saveAuxTabOrder(custom)
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual(custom)
    expect(loadAuxTabOrder()).toEqual(custom)
  })

  it("drops the stored value once the order is back to the built-in one", () => {
    saveAuxTabOrder(custom)
    saveAuxTabOrder([...AUX_PANEL_TABS])
    // Nothing stored, so a later change to the built-in order reaches this
    // user too.
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(getAuxTabOrder()).toEqual(DEFAULT_AUX_TAB_ORDER)
  })

  it("drops unknown and repeated tabs, and adds missing ones beside their neighbours", () => {
    expect(
      parseAuxTabOrder(["changes", "terminal", 7, null, "changes", "git_log"])
    ).toEqual([
      // A tab the value never listed (one added after it was written) joins
      // right after the nearest tab before it in the built-in order that is
      // there — first when none is.
      "session_details",
      "file_tree",
      "changes",
      "git_log",
    ])
    expect(parseAuxTabOrder(["git_log", "session_details"])).toEqual([
      "git_log",
      "session_details",
      "file_tree",
      "changes",
    ])
  })

  it("reads anything but an array as the built-in order", () => {
    for (const raw of [null, undefined, "git_log", 3, { order: custom }]) {
      expect(parseAuxTabOrder(raw)).toEqual(DEFAULT_AUX_TAB_ORDER)
    }
  })

  it("changes nothing on a second pass", () => {
    const once = parseAuxTabOrder(["changes", "changes", "session_details"])
    expect(parseAuxTabOrder(once)).toEqual(once)
    expect(new Set(once).size).toBe(AUX_PANEL_TABS.length)
  })

  it("writes a normalized order whatever it is handed", () => {
    saveAuxTabOrder(["git_log", "changes", "git_log"])
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual([
      "session_details",
      "file_tree",
      "git_log",
      "changes",
    ])
  })

  it("falls back to the built-in order on a corrupt or unreadable value", () => {
    localStorage.setItem(KEY, "{not json")
    expect(loadAuxTabOrder()).toEqual(DEFAULT_AUX_TAB_ORDER)

    localStorage.setItem(KEY, JSON.stringify("git_log,changes"))
    expect(loadAuxTabOrder()).toEqual(DEFAULT_AUX_TAB_ORDER)

    localStorage.setItem(KEY, JSON.stringify(custom))
    const getItem = denyStorage("getItem")
    expect(loadAuxTabOrder()).toEqual(DEFAULT_AUX_TAB_ORDER)
    getItem.mockRestore()
  })

  describe("moveAuxTab", () => {
    it("moves a tab by the given number of slots", () => {
      expect(moveAuxTab(DEFAULT_AUX_TAB_ORDER, "changes", -1)).toEqual([
        "session_details",
        "changes",
        "file_tree",
        "git_log",
      ])
      expect(moveAuxTab(DEFAULT_AUX_TAB_ORDER, "session_details", 3)).toEqual([
        "file_tree",
        "changes",
        "git_log",
        "session_details",
      ])
    })

    it("hands back the same array for a move that goes nowhere", () => {
      const order = [...custom]
      expect(moveAuxTab(order, "git_log", -1)).toBe(order)
      expect(moveAuxTab(order, "changes", 1)).toBe(order)
      expect(moveAuxTab(order, "file_tree", 0)).toBe(order)
      expect(moveAuxTab(["git_log"], "changes", 1)).toEqual(["git_log"])
    })
  })

  describe("shared snapshot", () => {
    it("picks up a save in this window", () => {
      const before = getAuxTabOrder()
      const listener = vi.fn()
      const unsubscribe = subscribeAuxTabOrder(listener)
      saveAuxTabOrder(custom)
      unsubscribe()
      expect(listener).toHaveBeenCalledTimes(1)
      expect(getAuxTabOrder()).not.toBe(before)
      expect(getAuxTabOrder()).toEqual(custom)
    })

    it("picks up another window's write from storage, not from the event", () => {
      getAuxTabOrder()
      const listener = vi.fn()
      const unsubscribe = subscribeAuxTabOrder(listener)
      // `storage` events are queued: this one describes a write that a later
      // one has already replaced. The store has to hold what storage holds.
      localStorage.setItem(KEY, JSON.stringify(custom))
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: KEY,
          newValue: JSON.stringify(DEFAULT_AUX_TAB_ORDER),
        })
      )
      unsubscribe()
      expect(listener).toHaveBeenCalledTimes(1)
      expect(getAuxTabOrder()).toEqual(custom)
    })

    it("keeps its identity, and stays quiet, when the order did not change", () => {
      saveAuxTabOrder(custom)
      const before = getAuxTabOrder()
      const listener = vi.fn()
      const unsubscribe = subscribeAuxTabOrder(listener)

      // Another window writing some other key — drafts are saved as you type.
      writeFromAnotherWindow("message-input-draft", "hello")
      // The same order written again, here and elsewhere.
      saveAuxTabOrder(custom)
      writeFromAnotherWindow(KEY, JSON.stringify(custom))

      unsubscribe()
      expect(listener).not.toHaveBeenCalled()
      expect(getAuxTabOrder()).toBe(before)
    })

    it("re-reads after another window clears storage wholesale", () => {
      saveAuxTabOrder(custom)
      const listener = vi.fn()
      const unsubscribe = subscribeAuxTabOrder(listener)
      localStorage.clear()
      writeFromAnotherWindow(null, null)
      unsubscribe()
      expect(listener).toHaveBeenCalledTimes(1)
      expect(getAuxTabOrder()).toEqual(DEFAULT_AUX_TAB_ORDER)
    })

    it("keeps what it shows when storage can't be read", () => {
      saveAuxTabOrder(custom)
      const listener = vi.fn()
      const unsubscribe = subscribeAuxTabOrder(listener)
      // Unreadable is not the same as empty: it must not reset the rail.
      const getItem = denyStorage("getItem")
      writeFromAnotherWindow(null, null)
      getItem.mockRestore()
      unsubscribe()
      expect(listener).not.toHaveBeenCalled()
      expect(getAuxTabOrder()).toEqual(custom)
    })

    it("still shows an order storage refused to keep", () => {
      getAuxTabOrder()
      const listener = vi.fn()
      const unsubscribe = subscribeAuxTabOrder(listener)
      const setItem = denyStorage("setItem")
      saveAuxTabOrder(custom)
      setItem.mockRestore()
      // Another window writing an unrelated key must not read the stale
      // stored order back over it.
      writeFromAnotherWindow("message-input-draft", "hello")
      unsubscribe()
      expect(localStorage.getItem(KEY)).toBeNull()
      expect(listener).toHaveBeenCalledTimes(1)
      expect(getAuxTabOrder()).toEqual(custom)
    })

    it("hands a hook an order that only changes with the value", () => {
      const { result } = renderHook(() => useAuxTabOrder())
      const first = result.current
      expect(first).toEqual(DEFAULT_AUX_TAB_ORDER)

      act(() => writeFromAnotherWindow("unrelated", "x"))
      expect(result.current).toBe(first)

      act(() => saveAuxTabOrder(custom))
      expect(result.current).toEqual(custom)

      act(() =>
        writeFromAnotherWindow(KEY, JSON.stringify([...AUX_PANEL_TABS]))
      )
      expect(result.current).toEqual(DEFAULT_AUX_TAB_ORDER)
    })
  })
})
