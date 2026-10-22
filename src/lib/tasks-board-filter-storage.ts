"use client"

import { useSyncExternalStore } from "react"

const BOARD_FILTER_KEY = "workspace:tasks-board-filter"
const VIEW_MODE_KEY = "workspace:tasks-view-mode"
const STATUS_FILTER_KEY = "workspace:tasks-status-filter"

/** Visibility toggles of the tasks board's filter popover. */
export interface TasksBoardFilter {
  showCanceled: boolean
  showArchived: boolean
}

/** Default view: canceled tasks visible, archived ones hidden. */
export const DEFAULT_TASKS_BOARD_FILTER: TasksBoardFilter = {
  showCanceled: true,
  showArchived: false,
}

/** How the tasks page lays its rows out: four-column board, or flat list. */
export type TasksViewMode = "board" | "list"

export const DEFAULT_TASKS_VIEW_MODE: TasksViewMode = "board"

/** The groups the list view can filter on — the board's four columns. Mirrors
 *  `BOARD_COLUMN_IDS` (board-columns.ts), whose test asserts the two agree —
 *  this copy exists so the storage layer stays free of component imports. */
export const TASKS_STATUS_GROUPS = [
  "todo",
  "inProgress",
  "attention",
  "done",
] as const

export type TasksStatusGroup = (typeof TASKS_STATUS_GROUPS)[number]

export function loadTasksBoardFilter(): TasksBoardFilter {
  if (typeof window === "undefined") return DEFAULT_TASKS_BOARD_FILTER
  try {
    const raw = localStorage.getItem(BOARD_FILTER_KEY)
    if (!raw) return DEFAULT_TASKS_BOARD_FILTER
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return DEFAULT_TASKS_BOARD_FILTER
    const obj = parsed as Record<string, unknown>
    return {
      showCanceled:
        typeof obj.showCanceled === "boolean"
          ? obj.showCanceled
          : DEFAULT_TASKS_BOARD_FILTER.showCanceled,
      showArchived:
        typeof obj.showArchived === "boolean"
          ? obj.showArchived
          : DEFAULT_TASKS_BOARD_FILTER.showArchived,
    }
  } catch {
    return DEFAULT_TASKS_BOARD_FILTER
  }
}

export function saveTasksBoardFilter(filter: TasksBoardFilter): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(BOARD_FILTER_KEY, JSON.stringify(filter))
  } catch {
    /* ignore */
  }
  // Published from the value, not read back: a write storage refuses still
  // holds in this window, as it does on the board that made it.
  publishTasksBoardFilter({
    showCanceled: filter.showCanceled,
    showArchived: filter.showArchived,
  })
}

// ── Live copy for the board's other reader ──
//
// The aux panel's task tab applies the same two toggles as the board, and it
// stays mounted while the board is opened, changed and left again. So the
// toggles are also kept as one parsed copy per window, republished on every
// save (the board saves on each change) and on another window's write — the
// tab follows the board instead of keeping whatever was stored when it first
// mounted. Its identity only changes when a toggle does.

let filterSnapshot: TasksBoardFilter | null = null
const filterListeners = new Set<() => void>()
let filterWindowBound = false

function publishTasksBoardFilter(next: TasksBoardFilter): void {
  if (
    filterSnapshot != null &&
    filterSnapshot.showCanceled === next.showCanceled &&
    filterSnapshot.showArchived === next.showArchived
  ) {
    return
  }
  filterSnapshot = next
  for (const listener of filterListeners) listener()
}

function bindFilterWindow(): void {
  if (filterWindowBound || typeof window === "undefined") return
  filterWindowBound = true
  window.addEventListener("storage", (event) => {
    // `key === null` is a wholesale `localStorage.clear()` elsewhere.
    if (event.key !== null && event.key !== BOARD_FILTER_KEY) return
    publishTasksBoardFilter(loadTasksBoardFilter())
  })
}

export function subscribeTasksBoardFilter(onChange: () => void): () => void {
  bindFilterWindow()
  filterListeners.add(onChange)
  return () => {
    filterListeners.delete(onChange)
  }
}

/** The current toggles; the identity only changes when they do. */
export function getTasksBoardFilter(): TasksBoardFilter {
  bindFilterWindow()
  if (typeof window === "undefined") return DEFAULT_TASKS_BOARD_FILTER
  filterSnapshot ??= loadTasksBoardFilter()
  return filterSnapshot
}

function getServerTasksBoardFilter(): TasksBoardFilter {
  return DEFAULT_TASKS_BOARD_FILTER
}

/** Reactive read of the board's visibility toggles, live across saves here and
 *  in other windows. */
export function useTasksBoardFilter(): TasksBoardFilter {
  return useSyncExternalStore(
    subscribeTasksBoardFilter,
    getTasksBoardFilter,
    getServerTasksBoardFilter
  )
}

/** Test seam: forget the parsed copy so the next read hits storage. */
export function resetTasksBoardFilterCacheForTests(): void {
  filterSnapshot = null
}

export function loadTasksViewMode(): TasksViewMode {
  if (typeof window === "undefined") return DEFAULT_TASKS_VIEW_MODE
  try {
    const raw = localStorage.getItem(VIEW_MODE_KEY)
    return raw === "list" || raw === "board" ? raw : DEFAULT_TASKS_VIEW_MODE
  } catch {
    return DEFAULT_TASKS_VIEW_MODE
  }
}

export function saveTasksViewMode(mode: TasksViewMode): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode)
  } catch {
    /* ignore */
  }
}

/**
 * The list view's status selection. `null` means "every status" — the default,
 * and what anything unrecognized falls back to rather than an empty list.
 *
 * Stored as the bare group id (like the view mode above). That also migrates
 * the entry this key used to hold — a JSON array of individual statuses, from
 * when the filter was a checkbox menu: it matches no group, so it reads back as
 * "every status" and the next save overwrites it.
 */
export function loadTasksStatusFilter(): TasksStatusGroup | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(STATUS_FILTER_KEY)
    return TASKS_STATUS_GROUPS.find((group) => group === raw) ?? null
  } catch {
    return null
  }
}

export function saveTasksStatusFilter(group: TasksStatusGroup | null): void {
  if (typeof window === "undefined") return
  try {
    if (group == null) localStorage.removeItem(STATUS_FILTER_KEY)
    else localStorage.setItem(STATUS_FILTER_KEY, group)
  } catch {
    /* ignore */
  }
}
