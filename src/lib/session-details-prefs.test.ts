import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  loadSessionDetailsDiffView,
  loadSessionDetailsSectionOpen,
  useSessionDetailsDiffView,
  useSessionDetailsSectionOpen,
} from "./session-details-prefs"

const sectionKey = (section: string) =>
  `workspace:session-details:open:${section}`

/** What another window's write looks like from here. */
function storedElsewhere(key: string, value: string, eventValue = value) {
  localStorage.setItem(key, value)
  window.dispatchEvent(
    new StorageEvent("storage", { key, newValue: eventValue })
  )
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("session details prefs", () => {
  it("opens every section by default", () => {
    expect(loadSessionDetailsSectionOpen("plan")).toBe(true)
    expect(loadSessionDetailsSectionOpen("messageNav")).toBe(true)
  })

  it("stores a change, and every mounted reader follows it", () => {
    const first = renderHook(() => useSessionDetailsSectionOpen("plan"))
    const second = renderHook(() => useSessionDetailsSectionOpen("plan"))
    const other = renderHook(() => useSessionDetailsSectionOpen("messageNav"))
    act(() => first.result.current[1](false))
    expect(first.result.current[0]).toBe(false)
    expect(second.result.current[0]).toBe(false)
    expect(other.result.current[0]).toBe(true)
    expect(localStorage.getItem(sectionKey("plan"))).toBe("closed")
  })

  // A queued `storage` event can carry a value older than what is stored by
  // the time it arrives: the store, not the event, is the truth.
  it("follows another window's change as stored, not as the event says", () => {
    const { result } = renderHook(() => useSessionDetailsSectionOpen("plan"))
    act(() => storedElsewhere(sectionKey("plan"), "closed", "open"))
    expect(result.current[0]).toBe(false)
  })

  it("keeps a change the storage refused for this window, until another window writes", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError")
      })
    const { result } = renderHook(() =>
      useSessionDetailsSectionOpen("messageNav")
    )
    act(() => result.current[1](false))
    expect(result.current[0]).toBe(false)
    expect(localStorage.getItem(sectionKey("messageNav"))).toBeNull()

    setItem.mockRestore()
    act(() => storedElsewhere(sectionKey("messageNav"), "open"))
    expect(result.current[0]).toBe(true)
  })

  // Another window's write can land after a panel's first read and before it
  // subscribes — its event then reaches no one.
  it("picks up a change stored between its first read and its subscription", () => {
    let written = false
    const { result } = renderHook(() => {
      const [open] = useSessionDetailsSectionOpen("messageNav")
      if (!written) {
        written = true
        localStorage.setItem(sectionKey("messageNav"), "closed")
      }
      return open
    })
    expect(result.current).toBe(false)
  })

  it("hears another window while no panel is mounted", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError")
      })
    const first = renderHook(() => useSessionDetailsSectionOpen("plan"))
    act(() => first.result.current[1](false))
    first.unmount()
    setItem.mockRestore()

    storedElsewhere(sectionKey("plan"), "open")
    const next = renderHook(() => useSessionDetailsSectionOpen("plan"))
    expect(next.result.current[0]).toBe(true)
  })

  it("reads an unreadable storage as the defaults", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError")
    })
    const { result } = renderHook(() =>
      useSessionDetailsSectionOpen("messageNav")
    )
    expect(result.current[0]).toBe(true)
    expect(loadSessionDetailsSectionOpen("plan")).toBe(true)
  })

  describe("diff view", () => {
    const DIFF_VIEW_KEY = "workspace:session-details:diff-view"

    it("lays a diff out inline by default", () => {
      expect(loadSessionDetailsDiffView()).toBe("unified")
    })

    it("stores a switch, and every mounted reader follows it", () => {
      const first = renderHook(() => useSessionDetailsDiffView())
      const second = renderHook(() => useSessionDetailsDiffView())
      act(() => first.result.current[1]("split"))
      expect(first.result.current[0]).toBe("split")
      expect(second.result.current[0]).toBe("split")
      expect(localStorage.getItem(DIFF_VIEW_KEY)).toBe("split")
      // Its own choice: the diff previews elsewhere keep theirs.
      expect(localStorage.getItem("workspace:diff-view-mode")).toBeNull()
    })

    it("follows another window's switch", () => {
      const { result } = renderHook(() => useSessionDetailsDiffView())
      act(() => storedElsewhere(DIFF_VIEW_KEY, "split"))
      expect(result.current[0]).toBe("split")
    })

    it("reads an unknown stored value as inline", () => {
      localStorage.setItem(DIFF_VIEW_KEY, "sideways")
      expect(loadSessionDetailsDiffView()).toBe("unified")
    })
  })
})
