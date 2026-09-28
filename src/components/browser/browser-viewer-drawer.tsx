"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { PanelRightOpen } from "lucide-react"

import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  SIDE_PANEL_CONTENT_CLASS,
} from "@/components/ui/drawer"
import { useOptionalWorkbenchRoute } from "@/contexts/workbench-route-context"
import {
  useWorkspaceActions,
  useWorkspaceFileTabs,
} from "@/contexts/workspace-context"
import { normalizeUrlForDedupe } from "@/lib/browser/browser-url"
import {
  DEFAULT_BROWSER_PROFILE_ID,
  browserProfileExists,
  useBrowserPrefs,
} from "@/lib/browser/browser-prefs"

import { NativeSurfaceBesideRoute } from "./browser-surface-host"
import { BrowserTabView } from "./browser-tab-view"

/**
 * The built-in browser inside the transcript's side panel — where an http(s)
 * link lands when a full-page route (task board, canvas, forge) covers the
 * file column. Underneath it is the same workspace browser tab: the drawer
 * opens (or re-uses) the tab record without activating the file column, shows
 * its view here, and "open in workspace" leads back to the column.
 */

// Which workspace record each mounted drawer body opened (see
// `BrowserViewerBody`): keyed by the body instance, so two drawers on one
// page cannot redirect each other, and forgotten when the body unmounts.
// Module-level because the value is written from an effect and read while
// rendering, which neither state nor a ref may do here. `null` = the open
// was refused (no record); absent = not resolved yet.
const openedTabs = new Map<number, string | null>()
const openedListeners = new Set<() => void>()
let nextBodyKey = 0

function subscribeOpened(listener: () => void): () => void {
  openedListeners.add(listener)
  return () => {
    openedListeners.delete(listener)
  }
}

function rememberOpened(key: number, id: string | null): void {
  if (openedTabs.has(key) && openedTabs.get(key) === id) return
  openedTabs.set(key, id)
  for (const listener of [...openedListeners]) listener()
}

function forgetOpened(key: number): void {
  if (!openedTabs.delete(key)) return
  for (const listener of [...openedListeners]) listener()
}

export function BrowserViewerDrawer({
  url,
  remote = false,
  open,
  onOpenChange,
}: {
  url: string
  /** An address on the remote codeg host (`BrowserTabSeed.remote`). */
  remote?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("Browser.drawer")
  return (
    <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="right">
      <DrawerContent
        closeButtonClassName="top-2.5 right-3"
        className={SIDE_PANEL_CONTENT_CLASS}
        nativeSurfaceHost
      >
        <DrawerTitle className="sr-only">{t("title")}</DrawerTitle>
        <DrawerDescription className="sr-only">
          {t("description")}
        </DrawerDescription>
        {open ? (
          // Keyed by URL: a drawer handed another address starts a fresh
          // body, so the record it remembered for the old one never shows
          // under the new header.
          <BrowserViewerBody
            key={url}
            url={url}
            remote={remote}
            onOpenChange={onOpenChange}
          />
        ) : null}
      </DrawerContent>
    </Drawer>
  )
}

function BrowserViewerBody({
  url,
  remote,
  onOpenChange,
}: {
  url: string
  remote: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("Browser.drawer")
  const { openBrowserTab, switchFileTab } = useWorkspaceActions()
  const { fileTabs } = useWorkspaceFileTabs()
  const route = useOptionalWorkbenchRoute()

  // Open (or re-use) the workspace tab without activating the file column,
  // and remember WHICH record that was: the same page can be open in two
  // profiles, and the one to show is the one this drawer asked for, whatever
  // the preference says later. The id lives in a small store outside React
  // (an effect may not set state, and a ref may not be read while
  // rendering), under a key of this body's own; a new URL resolves anew, and
  // the entry goes with the body.
  const [bodyKey] = useState(() => {
    nextBodyKey += 1
    return nextBodyKey
  })
  useEffect(() => {
    rememberOpened(
      bodyKey,
      openBrowserTab(url, { activate: false, ...(remote ? { remote } : {}) })
    )
  }, [bodyKey, openBrowserTab, remote, url])
  useEffect(() => () => forgetOpened(bodyKey), [bodyKey])
  const opened = useSyncExternalStore(
    subscribeOpened,
    () =>
      openedTabs.has(bodyKey) ? (openedTabs.get(bodyKey) ?? null) : undefined,
    () => undefined
  )

  // Only BEFORE the open has resolved (first paint) is the record found the
  // way `openBrowserTab` itself resolves an address with no opener: by URL
  // in the profile new tabs use. Once resolved, it is that record or nothing
  // — never a tab of another profile, not even after the record closes.
  const prefs = useBrowserPrefs()
  const wantedProfile =
    !remote && browserProfileExists(prefs, prefs.newTabProfile)
      ? prefs.newTabProfile
      : DEFAULT_BROWSER_PROFILE_ID
  const wanted = normalizeUrlForDedupe(url)
  const tab =
    opened === undefined
      ? fileTabs.find(
          (it) =>
            it.kind === "browser" &&
            it.browser.profile === wantedProfile &&
            (it.browser.remote === true) === remote &&
            normalizeUrlForDedupe(it.browser.initialUrl) === wanted
        )
      : opened
        ? fileTabs.find((it) => it.id === opened)
        : undefined
  const tabId = tab?.id ?? null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3 pr-12 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{url}</span>
        {route && tabId ? (
          <button
            type="button"
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-foreground hover:bg-primary/8"
            onClick={() => {
              route.openConversations()
              switchFileTab(tabId)
              onOpenChange(false)
            }}
          >
            <PanelRightOpen className="h-3.5 w-3.5" />
            {t("openInWorkspace")}
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        {tab?.kind === "browser" ? (
          // Over whatever route is up: the page shows here even when the
          // file column it would otherwise live in is hidden under a
          // full-page route.
          <NativeSurfaceBesideRoute.Provider value={true}>
            <BrowserTabView key={tab.id} tab={tab} />
          </NativeSurfaceBesideRoute.Provider>
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t("cannotOpen")}
          </div>
        )}
      </div>
    </div>
  )
}
