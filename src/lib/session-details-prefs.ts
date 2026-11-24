// View preferences of the Session Details side panel: which of its sections
// (plan, message navigator) are open, and how the message navigator lays out
// a file's diff.
//
// Global, persisted in localStorage — one key per preference, so two windows
// flipping different ones never overwrite each other — and read through
// `useSyncExternalStore`, so every mounted panel follows a change: this
// window's writes notify its readers directly, another window's arrive as the
// native `storage` event, which re-reads the storage rather than trusting the
// event's `newValue` (a queued event can carry a value older than what is
// stored by the time it is delivered). Reading through the store also covers a
// change landing between a panel's first render and its subscription: React
// re-checks the snapshot once subscribed.

import { useCallback, useSyncExternalStore } from "react"

import type { DiffViewMode } from "@/lib/diff-view-mode-prefs"

export type SessionDetailsSection = "plan" | "messageNav"

const KEY_PREFIX = "workspace:session-details:"
const SECTION_OPEN_KEY_PREFIX = `${KEY_PREFIX}open:`
const DIFF_VIEW_KEY = `${KEY_PREFIX}diff-view`

// Values this window could not store (quota, storage disabled). They still
// apply here — they just don't persist or reach other windows — until a later
// write lands or another window writes the same key.
const unstored = new Map<string, string>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function onStorage(event: StorageEvent): void {
  // `key === null`: the storage was cleared.
  if (event.key === null) unstored.clear()
  else if (event.key.startsWith(KEY_PREFIX)) unstored.delete(event.key)
  else return
  notify()
}

let listeningToStorage = false

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Installed once and kept: `unstored` outlives any one panel, so another
  // window's write must reach it while no panel is mounted too.
  if (!listeningToStorage) {
    listeningToStorage = true
    window.addEventListener("storage", onStorage)
  }
  return () => {
    listeners.delete(listener)
  }
}

function sectionOpenKey(section: SessionDetailsSection): string {
  return `${SECTION_OPEN_KEY_PREFIX}${section}`
}

function readPref(key: string): string | null {
  const local = unstored.get(key)
  if (local !== undefined) return local
  if (typeof window === "undefined") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writePref(key: string, value: string): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(key, value)
    unstored.delete(key)
  } catch {
    unstored.set(key, value)
  }
  notify()
}

function parseOpen(raw: string | null): boolean {
  // Open unless explicitly closed.
  return raw !== "closed"
}

export function loadSessionDetailsSectionOpen(
  section: SessionDetailsSection
): boolean {
  return parseOpen(readPref(sectionOpenKey(section)))
}

export function saveSessionDetailsSectionOpen(
  section: SessionDetailsSection,
  open: boolean
): void {
  writePref(sectionOpenKey(section), open ? "open" : "closed")
}

/** The raw stored value of a preference, kept in sync with every writer. */
function useStoredPref(key: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => readPref(key),
    () => null
  )
}

/** Whether a Session Details section is open, plus the setter that persists
 *  it. Every mounted panel follows the change. */
export function useSessionDetailsSectionOpen(
  section: SessionDetailsSection
): [boolean, (open: boolean) => void] {
  const open = parseOpen(useStoredPref(sectionOpenKey(section)))
  const setOpen = useCallback(
    (next: boolean) => saveSessionDetailsSectionOpen(section, next),
    [section]
  )
  return [open, setOpen]
}

function parseDiffView(raw: string | null): DiffViewMode {
  // Inline unless explicitly switched: the panel is narrow.
  return raw === "split" ? "split" : "unified"
}

export function loadSessionDetailsDiffView(): DiffViewMode {
  return parseDiffView(readPref(DIFF_VIEW_KEY))
}

export function saveSessionDetailsDiffView(mode: DiffViewMode): void {
  writePref(DIFF_VIEW_KEY, mode)
}

/**
 * How the message navigator lays out a file's diff, plus the setter that
 * persists it. The panel keeps a choice of its own rather than following the
 * diff previews elsewhere (`useDiffViewMode`): it is a narrow column, where
 * the inline layout is the one that fits, beside a transcript wide enough for
 * either.
 */
export function useSessionDetailsDiffView(): [
  DiffViewMode,
  (mode: DiffViewMode) => void,
] {
  return [
    parseDiffView(useStoredPref(DIFF_VIEW_KEY)),
    saveSessionDetailsDiffView,
  ]
}
