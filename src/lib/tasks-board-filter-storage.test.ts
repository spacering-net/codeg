import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  DEFAULT_TASKS_BOARD_FILTER,
  getTasksBoardFilter,
  loadTasksStatusFilter,
  loadTasksTimeFilter,
  loadTasksViewMode,
  resetTasksBoardFilterCacheForTests,
  resetTasksTimeFilterCacheForTests,
  saveTasksBoardFilter,
  saveTasksStatusFilter,
  saveTasksTimeFilter,
  saveTasksViewMode,
  subscribeTasksBoardFilter,
  useTasksBoardFilter,
  useTasksTimeFilter,
} from "./tasks-board-filter-storage"

const VIEW_MODE_KEY = "workspace:tasks-view-mode"
const STATUS_FILTER_KEY = "workspace:tasks-status-filter"
const TIME_FILTER_KEY = "workspace:tasks-time-filter"

const BOARD_FILTER_KEY = "workspace:tasks-board-filter"

beforeEach(() => {
  localStorage.clear()
  resetTasksBoardFilterCacheForTests()
  resetTasksTimeFilterCacheForTests()
})

describe("tasks view mode storage", () => {
  it("round-trips a stored mode and defaults to the board", () => {
    expect(loadTasksViewMode()).toBe("board")
    saveTasksViewMode("list")
    expect(loadTasksViewMode()).toBe("list")
    saveTasksViewMode("board")
    expect(loadTasksViewMode()).toBe("board")
  })

  it("falls back to the board on a junk entry", () => {
    localStorage.setItem(VIEW_MODE_KEY, "gallery")
    expect(loadTasksViewMode()).toBe("board")
  })
})

describe("tasks time filter storage", () => {
  it("defaults to all time and remembers every choice", () => {
    expect(loadTasksTimeFilter()).toBe("all")
    for (const range of ["24h", "7d", "30d"] as const) {
      saveTasksTimeFilter(range)
      expect(loadTasksTimeFilter()).toBe(range)
    }
    saveTasksTimeFilter("all")
    expect(localStorage.getItem(TIME_FILTER_KEY)).toBe("all")
    expect(loadTasksTimeFilter()).toBe("all")
  })

  it("falls back to all time for an unrecognized stored value", () => {
    localStorage.setItem(TIME_FILTER_KEY, "yesterday")
    expect(loadTasksTimeFilter()).toBe("all")
  })

  it("handles unavailable storage", () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("Storage denied")
      })
    expect(loadTasksTimeFilter()).toBe("all")
    getItem.mockRestore()
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("Storage denied")
      })
    expect(() => saveTasksTimeFilter("24h")).not.toThrow()
    setItem.mockRestore()
  })

  it("keeps mounted consumers in sync in both directions", () => {
    const page = renderHook(() => useTasksTimeFilter())
    const sidebar = renderHook(() => useTasksTimeFilter())
    expect(page.result.current).toBe("all")
    expect(sidebar.result.current).toBe("all")

    act(() => saveTasksTimeFilter("24h"))
    expect(page.result.current).toBe("24h")
    expect(sidebar.result.current).toBe("24h")
    act(() => saveTasksTimeFilter("all"))
    expect(page.result.current).toBe("all")
    expect(sidebar.result.current).toBe("all")
  })

  it("restores stored choices and follows other windows' writes and clears", () => {
    localStorage.setItem(TIME_FILTER_KEY, "30d")
    const { result } = renderHook(() => useTasksTimeFilter())
    expect(result.current).toBe("30d")
    act(() => {
      localStorage.setItem(TIME_FILTER_KEY, "7d")
      window.dispatchEvent(
        new StorageEvent("storage", { key: TIME_FILTER_KEY })
      )
    })
    expect(result.current).toBe("7d")
    act(() => {
      localStorage.removeItem(TIME_FILTER_KEY)
      window.dispatchEvent(
        new StorageEvent("storage", { key: TIME_FILTER_KEY })
      )
    })
    expect(result.current).toBe("all")
    act(() => saveTasksTimeFilter("24h"))
    act(() => {
      localStorage.clear()
      window.dispatchEvent(new StorageEvent("storage", { key: null }))
    })
    expect(result.current).toBe("all")
  })

  it("shares changes even when storage refuses a write", () => {
    const page = renderHook(() => useTasksTimeFilter())
    const sidebar = renderHook(() => useTasksTimeFilter())
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("Storage denied")
      })
    try {
      act(() => saveTasksTimeFilter("30d"))
      expect(page.result.current).toBe("30d")
      expect(sidebar.result.current).toBe("30d")
    } finally {
      setItem.mockRestore()
    }
  })
})

describe("tasks status filter storage", () => {
  it("round-trips a group and keeps null meaning every status", () => {
    expect(loadTasksStatusFilter()).toBeNull()
    saveTasksStatusFilter("attention")
    expect(loadTasksStatusFilter()).toBe("attention")
    // Clearing removes the entry rather than storing something that would read
    // back as a filter nobody chose.
    saveTasksStatusFilter(null)
    expect(localStorage.getItem(STATUS_FILTER_KEY)).toBeNull()
    expect(loadTasksStatusFilter()).toBeNull()
  })

  it("falls back to every status on an unknown entry — including the old per-status selection", () => {
    // What this key held while the filter was a checkbox menu. It matches no
    // group, so it degrades to "every status" and the next save overwrites it.
    localStorage.setItem(
      STATUS_FILTER_KEY,
      JSON.stringify(["review", "failed"])
    )
    expect(loadTasksStatusFilter()).toBeNull()

    // A single status id is not a group either — `review` lives in `attention`.
    localStorage.setItem(STATUS_FILTER_KEY, "review")
    expect(loadTasksStatusFilter()).toBeNull()

    localStorage.setItem(STATUS_FILTER_KEY, "{not json")
    expect(loadTasksStatusFilter()).toBeNull()
  })
})

/**
 * The aux panel's task tab follows the board's visibility toggles live: it
 * stays mounted while the board is opened, changed and left again.
 */
describe("tasks board filter, live copy", () => {
  it("starts from what is stored, and follows every save", () => {
    localStorage.setItem(
      BOARD_FILTER_KEY,
      JSON.stringify({ showCanceled: false, showArchived: true })
    )
    const { result } = renderHook(() => useTasksBoardFilter())
    expect(result.current).toEqual({ showCanceled: false, showArchived: true })

    act(() => saveTasksBoardFilter({ showCanceled: true, showArchived: false }))
    expect(result.current).toEqual(DEFAULT_TASKS_BOARD_FILTER)
  })

  it("keeps its identity, and stays quiet, for a save that changes nothing", () => {
    const before = getTasksBoardFilter()
    const listener = vi.fn()
    const unsubscribe = subscribeTasksBoardFilter(listener)
    saveTasksBoardFilter({ ...before })
    unsubscribe()
    expect(listener).not.toHaveBeenCalled()
    expect(getTasksBoardFilter()).toBe(before)
  })

  it("picks up another window's write", () => {
    const { result } = renderHook(() => useTasksBoardFilter())
    act(() => {
      localStorage.setItem(
        BOARD_FILTER_KEY,
        JSON.stringify({ showCanceled: false, showArchived: false })
      )
      window.dispatchEvent(
        new StorageEvent("storage", { key: BOARD_FILTER_KEY })
      )
    })
    expect(result.current).toEqual({
      showCanceled: false,
      showArchived: false,
    })
  })
})
