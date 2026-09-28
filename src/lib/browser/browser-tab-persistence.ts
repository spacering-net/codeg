// What survives a restart of a browser tab: its page and title, per window.
//
// File tabs are session-only, browser tabs are not: a page is cheap to bring
// back (one URL), and the dev-server page next to the chat is exactly what a
// user expects to find again after relaunching. Records come back "not
// loaded" — a native surface is created for one when it is first shown — so
// restoring twenty tabs costs twenty small records and nothing else.
//
// One localStorage key per window label (`main`, `remote-workspace-*`): each
// workspace window owns its own tabs. The stored order is the strip order.
// Pure functions here; `BrowserTabsPersistence` (components/browser) does
// the wiring.

import type { FileWorkspaceTab } from "@/contexts/workspace-context"

import { DEFAULT_BROWSER_PROFILE_ID, isBrowserProfileId } from "./browser-prefs"
import type { BrowserTabState } from "./types"
import { getCurrentWindowLabel } from "./window-label"

export interface PersistedBrowserTab {
  /** The page the tab was on (its live URL, falling back to the address it
   *  was opened with while nothing has committed). */
  url: string
  /** Page title; "" when unknown (the restorer falls back to the host). */
  title: string
  folderId: number | null
  /** The browser profile the tab lived in. A record written before profiles
   *  existed has none and comes back in the default one; the restorer maps a
   *  profile that has since been deleted to the default one as well. */
  profile: string
  /** An address on the remote codeg host (`BrowserTabSeed.remote`). Written
   *  only when set, so records of every other tab keep their old shape. */
  remote?: true
}

const KEY_PREFIX = "browser:tabs:"
export const BROWSER_TABS_STORAGE_VERSION = 1

interface StoredShape {
  version: number
  tabs: PersistedBrowserTab[]
}

export function browserTabsStorageKey(
  windowLabel: string = getCurrentWindowLabel()
): string {
  return `${KEY_PREFIX}${windowLabel}`
}

function isWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

/** Accept only what a restorer can act on; everything else is dropped, never
 *  thrown on — a corrupt entry must not take the whole list with it. */
function sanitize(raw: unknown): PersistedBrowserTab | null {
  if (!raw || typeof raw !== "object") return null
  const { url, title, folderId, profile, remote } = raw as Record<
    string,
    unknown
  >
  if (typeof url !== "string" || !isWebUrl(url)) return null
  return {
    url,
    title: typeof title === "string" ? title : "",
    folderId:
      typeof folderId === "number" && Number.isInteger(folderId)
        ? folderId
        : null,
    profile: isBrowserProfileId(profile) ? profile : DEFAULT_BROWSER_PROFILE_ID,
    ...(remote === true ? { remote: true as const } : {}),
  }
}

export function readPersistedBrowserTabs(
  windowLabel?: string
): PersistedBrowserTab[] {
  if (typeof window === "undefined") return []
  let raw: string | null
  try {
    raw = localStorage.getItem(browserTabsStorageKey(windowLabel))
  } catch {
    return []
  }
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as Partial<StoredShape> | null
    if (
      !parsed ||
      parsed.version !== BROWSER_TABS_STORAGE_VERSION ||
      !Array.isArray(parsed.tabs)
    ) {
      return []
    }
    return parsed.tabs.flatMap((entry) => {
      const clean = sanitize(entry)
      return clean ? [clean] : []
    })
  } catch {
    return []
  }
}

export function writePersistedBrowserTabs(
  tabs: readonly PersistedBrowserTab[],
  windowLabel?: string
): void {
  if (typeof window === "undefined") return
  const key = browserTabsStorageKey(windowLabel)
  try {
    if (tabs.length === 0) {
      localStorage.removeItem(key)
      return
    }
    const stored: StoredShape = {
      version: BROWSER_TABS_STORAGE_VERSION,
      tabs: tabs.map((tab) => ({
        url: tab.url,
        title: tab.title,
        folderId: tab.folderId,
        profile: tab.profile,
        ...(tab.remote ? { remote: true as const } : {}),
      })),
    }
    localStorage.setItem(key, JSON.stringify(stored))
  } catch {
    /* quota / privacy mode: the tabs simply do not survive this run */
  }
}

/**
 * The persisted view of the open tabs: browser records in strip order, each
 * at its live page when there is one. `stateOf` is the tab store's getter,
 * injected so this stays a pure function of its inputs.
 *
 * The address is the first WEB url among "where the tab is", "where it was
 * going" and "what it was opened with": a page that navigated itself to
 * `about:blank` still comes back as the page the user opened, and a popup
 * that only ever was `about:blank` (its content written by its opener) is
 * dropped, since there is nothing to reload.
 */
export function snapshotBrowserTabs(
  fileTabs: readonly FileWorkspaceTab[],
  stateOf: (workspaceTabId: string) => BrowserTabState | null
): PersistedBrowserTab[] {
  const out: PersistedBrowserTab[] = []
  for (const tab of fileTabs) {
    if (tab.kind !== "browser") continue
    const state = stateOf(tab.id)
    const url = [state?.url, state?.requestedUrl, tab.browser.initialUrl].find(
      (candidate) => candidate && isWebUrl(candidate)
    )
    if (!url) continue
    out.push({
      url,
      title: state?.title || tab.title,
      folderId: tab.folderId,
      profile: tab.browser.profile,
      ...(tab.browser.remote ? { remote: true as const } : {}),
    })
  }
  return out
}

export function samePersistedBrowserTabs(
  a: readonly PersistedBrowserTab[],
  b: readonly PersistedBrowserTab[]
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].url !== b[i].url ||
      a[i].title !== b[i].title ||
      a[i].folderId !== b[i].folderId ||
      a[i].profile !== b[i].profile ||
      a[i].remote !== b[i].remote
    ) {
      return false
    }
  }
  return true
}

/** Idle threshold of the optional background unload: a loaded tab whose
 *  surface host has been unmounted this long is released. */
export const BROWSER_TAB_SUSPEND_AFTER_MS = 30 * 60 * 1000

export interface SuspendCandidate {
  id: string
  /** From the tab store: `null` while on screen, `undefined` if never shown. */
  hiddenAt: number | null | undefined
  loaded: boolean
}

/** Which tabs the background unload should release right now. Only loaded
 *  tabs that were shown once and have been off screen for the threshold. */
export function selectBrowserTabsToSuspend(
  candidates: readonly SuspendCandidate[],
  now: number,
  idleMs: number = BROWSER_TAB_SUSPEND_AFTER_MS
): string[] {
  return candidates
    .filter(
      (c) =>
        c.loaded && typeof c.hiddenAt === "number" && now - c.hiddenAt >= idleMs
    )
    .map((c) => c.id)
}
