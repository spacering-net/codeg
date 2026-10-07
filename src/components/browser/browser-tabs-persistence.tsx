"use client"

import { useEffect, useMemo, useRef, useState } from "react"

import {
  useWorkspaceActions,
  useWorkspaceFileTabs,
} from "@/contexts/workspace-context"
import { browserCapabilities } from "@/lib/browser/browser-api"
import { browserDeviceKey } from "@/lib/browser/browser-device"
import {
  DEFAULT_BROWSER_PROFILE_ID,
  browserProfileExists,
  getBrowserPrefs,
} from "@/lib/browser/browser-prefs"
import {
  readPersistedBrowserTabs,
  samePersistedBrowserTabs,
  snapshotBrowserTabs,
  writePersistedBrowserTabs,
  type PersistedBrowserTab,
} from "@/lib/browser/browser-tab-persistence"
import {
  getBrowserTabState,
  subscribeBrowserTabs,
} from "@/lib/browser/browser-tab-store"
import { getCurrentWindowLabel } from "@/lib/browser/window-label"

/** Coalesces a burst of changes (a page load moves URL and title in two
 *  events) into one localStorage write. */
const SAVE_DEBOUNCE_MS = 400

// Window labels this document already restored for. Guards the StrictMode
// double effect and a re-mount of the workspace providers within one
// document; a new document (reload, relaunch) starts empty and restores.
const restoredWindows = new Set<string>()

/** Tests only. */
export function resetBrowserTabsPersistenceForTests(): void {
  restoredWindows.clear()
}

/**
 * Keeps the browser tabs of this window in localStorage and brings them back
 * on the next run. Mounted once inside the workspace providers, next to the
 * events bridge; renders nothing.
 *
 * Order matters at startup: nothing is written until the restore has run,
 * or the empty strip of a fresh document would wipe what the last run saved.
 * Only where a built-in browser exists — in web mode there are no browser
 * tabs and the stored list (from a desktop run against the same origin,
 * unlikely but possible) is left alone.
 */
export function BrowserTabsPersistence() {
  const { restoreBrowserTabs } = useWorkspaceActions()
  const { fileTabs } = useWorkspaceFileTabs()
  const [ready, setReady] = useState(false)
  // Latest-state mirror for the timers below (synced post-commit, like the
  // workspace provider does for its own action callbacks).
  const fileTabsRef = useRef(fileTabs)
  useEffect(() => {
    fileTabsRef.current = fileTabs
  }, [fileTabs])
  const lastWrittenRef = useRef<PersistedBrowserTab[] | null>(null)

  // Restore once per document, then open the gate for writes.
  useEffect(() => {
    let cancelled = false
    void browserCapabilities().then((caps) => {
      if (cancelled || !caps.available) return
      const label = getCurrentWindowLabel()
      if (!restoredWindows.has(label)) {
        restoredWindows.add(label)
        const entries = readPersistedBrowserTabs(label)
        lastWrittenRef.current = entries
        // A profile deleted since the last run has no store any more; its
        // tabs come back in the default one rather than not at all.
        const prefs = getBrowserPrefs()
        const restorable = entries.map((entry) =>
          browserProfileExists(prefs, entry.profile)
            ? entry
            : { ...entry, profile: DEFAULT_BROWSER_PROFILE_ID }
        )
        if (restorable.length > 0) restoreBrowserTabs(restorable)
      }
      setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [restoreBrowserTabs])

  // What the strip looks like as far as persistence is concerned: browser
  // records, their order, and the fields a record itself carries. File tab
  // churn (keystrokes, reloads) does not change this string, so it does not
  // schedule a write.
  const signature = useMemo(
    () =>
      fileTabs
        .filter((tab) => tab.kind === "browser")
        .map(
          (tab) =>
            `${tab.id}\u0000${tab.browser.profile}\u0000${tab.browser.initialUrl}\u0000${tab.title}\u0000${browserDeviceKey(tab.browser.device)}`
        )
        .join("\u0001"),
    [fileTabs]
  )

  useEffect(() => {
    if (!ready) return
    let timer: number | null = null
    const save = () => {
      const snapshot = snapshotBrowserTabs(
        fileTabsRef.current,
        getBrowserTabState
      )
      if (
        lastWrittenRef.current &&
        samePersistedBrowserTabs(lastWrittenRef.current, snapshot)
      ) {
        return
      }
      lastWrittenRef.current = snapshot
      writePersistedBrowserTabs(snapshot)
    }
    const schedule = () => {
      if (timer !== null) return
      timer = window.setTimeout(() => {
        timer = null
        save()
      }, SAVE_DEBOUNCE_MS)
    }
    const flush = () => {
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
      save()
    }
    schedule()
    // Live URL / title changes arrive through the tab store, not the records.
    const unsubscribe = subscribeBrowserTabs(schedule)
    window.addEventListener("pagehide", flush)
    return () => {
      unsubscribe()
      window.removeEventListener("pagehide", flush)
      // A pending write must not be lost to a re-run (signature change) or
      // an unmount; the refs hold the latest inputs either way.
      flush()
    }
  }, [ready, signature])

  return null
}
