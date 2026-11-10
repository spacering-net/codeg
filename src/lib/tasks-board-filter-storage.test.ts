import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  DEFAULT_TASKS_BOARD_FILTER,
  getTasksBoardFilter,
  loadTasksStatusFilter,
  loadTasksViewMode,
  resetTasksBoardFilterCacheForTests,
  saveTasksBoardFilter,
  saveTasksStatusFilter,
  saveTasksViewMode,
  subscribeTasksBoardFilter,
  useTasksBoardFilter,
} from "./tasks-board-filter-storage"

const VIEW_MODE_KEY = "workspace:tasks-view-mode"
const STATUS_FILTER_KEY = "workspace:tasks-status-filter"

const BOARD_FILTER_KEY = "workspace:tasks-board-filter"

beforeEach(() => {
  localStorage.clear()
  resetTasksBoardFilterCacheForTests()
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
