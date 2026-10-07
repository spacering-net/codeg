// Downloads started by browser tabs, newest first.
//
// Kept out of the per-tab state store: a download outlives the tab that
// started it (and the tab may be closed while it runs), and the bar that
// shows it is per tab but the record is not. Hydrated once from
// `browser_list_downloads`, then kept current by `browser://download`.

import { useSyncExternalStore } from "react"

import { browserWorkspaceTabId } from "./browser-tab-store"
import type { BrowserDownload } from "./types"

type Listener = () => void

/** Mirrors the backend's own history cap so a long session cannot accumulate
 *  records for ever. */
export const BROWSER_DOWNLOAD_HISTORY_LIMIT = 32

const listeners = new Set<Listener>()
// Newest first.
let downloads: BrowserDownload[] = []
const dismissed = new Set<string>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

export function subscribeBrowserDownloads(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Replace or insert one record (the event carries the whole thing). */
export function setBrowserDownload(download: BrowserDownload): void {
  const index = downloads.findIndex((d) => d.id === download.id)
  if (index >= 0) {
    const previous = downloads[index]
    if (
      previous.state === download.state &&
      previous.path === download.path &&
      previous.fileName === download.fileName
    ) {
      return
    }
    downloads = [...downloads]
    downloads[index] = download
  } else {
    downloads = [download, ...downloads].slice(
      0,
      BROWSER_DOWNLOAD_HISTORY_LIMIT
    )
  }
  notify()
}

/** Initial list from the backend (oldest first there, newest first here). */
export function hydrateBrowserDownloads(list: BrowserDownload[]): void {
  downloads = [...list].reverse().slice(0, BROWSER_DOWNLOAD_HISTORY_LIMIT)
  notify()
}

/** Hide one record from the bar without touching the file or the backend. */
export function dismissBrowserDownload(id: string): void {
  if (dismissed.has(id)) return
  dismissed.add(id)
  notify()
}

/** Hide every record currently known (the bar's "clear"). */
export function dismissAllBrowserDownloads(): void {
  let changed = false
  for (const download of downloads) {
    if (!dismissed.has(download.id)) {
      dismissed.add(download.id)
      changed = true
    }
  }
  if (changed) notify()
}

export function getBrowserDownloads(): BrowserDownload[] {
  return downloads
}

// Memoised per workspace tab id so `useSyncExternalStore` sees a stable
// reference between changes (it compares snapshots by identity, and a fresh
// array every read would loop forever).
let cache = new Map<string, BrowserDownload[]>()
let cacheGeneration: BrowserDownload[] | null = null
let cacheDismissed = 0

const EMPTY: BrowserDownload[] = []

function visibleFor(workspaceTabId: string): BrowserDownload[] {
  if (cacheGeneration !== downloads || cacheDismissed !== dismissed.size) {
    cache = new Map()
    cacheGeneration = downloads
    cacheDismissed = dismissed.size
  }
  const hit = cache.get(workspaceTabId)
  if (hit) return hit
  const list = downloads.filter(
    (d) =>
      !dismissed.has(d.id) && browserWorkspaceTabId(d.tabId) === workspaceTabId
  )
  const value = list.length === 0 ? EMPTY : list
  cache.set(workspaceTabId, value)
  return value
}

function getServerSnapshot(): BrowserDownload[] {
  return EMPTY
}

/** Downloads of one tab that the user has not dismissed, newest first. */
export function useBrowserTabDownloads(
  workspaceTabId: string | null
): BrowserDownload[] {
  return useSyncExternalStore(
    subscribeBrowserDownloads,
    () => (workspaceTabId ? visibleFor(workspaceTabId) : EMPTY),
    getServerSnapshot
  )
}

export function resetBrowserDownloadsForTests(): void {
  downloads = []
  dismissed.clear()
  listeners.clear()
  cache = new Map()
  cacheGeneration = null
  cacheDismissed = 0
}
