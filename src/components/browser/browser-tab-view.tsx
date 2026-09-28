"use client"

import { useTranslations } from "next-intl"
import { useState, type KeyboardEvent } from "react"

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import {
  toLocalizedErrorMessage,
  type AppErrorTranslator,
} from "@/lib/app-error"
import { browserSetVisible } from "@/lib/browser/browser-api"
import {
  remoteConnectionOfProfile,
  remoteHostDisplayName,
} from "@/lib/browser/remote-host"
import {
  clearBrowserCreateFailure,
  useBrowserCreateOutcome,
  useBrowserFindRequest,
  useBrowserTabState,
} from "@/lib/browser/browser-tab-store"
import { useBrowserCapabilities } from "@/lib/browser/use-browser-capabilities"
import { browserTabBackendId } from "@/lib/file-tab-id"

import { getActiveRemoteConnectionId, isDesktop } from "@/lib/transport"

import { BrowserBridgeView } from "./browser-bridge-view"
import { BrowserFindBar } from "./browser-find-bar"
import { BrowserRemoteTabView } from "./browser-remote-tab-view"
import {
  BrowserDownloadBar,
  BrowserErrorPage,
  BrowserNoticeBar,
  BrowserOwnedWindowCard,
} from "./browser-status-layer"
import { BrowserSurfaceHost } from "./browser-surface-host"
import { BrowserToolbar } from "./browser-toolbar"

/**
 * The file-pane content of a browser tab. On the desktop: toolbar, notices,
 * and the native surface (or, when the page could not load, a DOM error page
 * in its place). In a browser there is no native surface; the tab shows a
 * dev server on the codeg host through the port bridge instead.
 */
export function BrowserTabView({ tab }: { tab: BrowserWorkspaceTab }) {
  if (!isDesktop()) return <BrowserBridgeView tab={tab} />
  // An address of the remote codeg host: loaded through that host, or not
  // at all — never from this computer. A record in a connection's profile is
  // one whatever its flag says: its page was the remote host's.
  if (
    tab.browser.remote ||
    remoteConnectionOfProfile(tab.browser.profile) !== null
  ) {
    return <RemoteBrowserTabView tab={tab} />
  }
  return <NativeBrowserTabView tab={tab} />
}

/**
 * A tab of the remote codeg host. Its page is shown here and fetched from
 * there: the backend opens it in the window's connection's own profile, whose
 * every connection goes through that connection's tunnel (`browser::remote`),
 * and refuses — with the reason — whatever cannot be opened that way. Then the
 * tab says where the address lives, and why it cannot be opened here.
 */
function RemoteBrowserTabView({ tab }: { tab: BrowserWorkspaceTab }) {
  const tRoot = useTranslations()
  const t = useTranslations("Browser.remote")
  const capabilities = useBrowserCapabilities()
  const state = useBrowserTabState(tab.id)
  // Kept in the store: the host that asked may not be the one on screen
  // when the answer arrives.
  const outcome = useBrowserCreateOutcome(tab.id)
  const connectionId = getActiveRemoteConnectionId()
  const host = remoteHostDisplayName()
  // A surface that is already there — a popup the backend adopted, a tab
  // opened before — is shown whatever; there is nothing left to refuse.
  if (state === null) {
    // Outside a window bound to a remote server there is no connection to go
    // through (a remote tab is only ever made in one).
    if (connectionId === null) return <BrowserRemoteTabView tab={tab} />
    if (capabilities?.remoteEgress === false) {
      return (
        <BrowserRemoteTabView
          tab={tab}
          reason={tRoot("browser.remote.error.unavailable")}
        />
      )
    }
    if (outcome?.kind === "failed") {
      return (
        <BrowserRemoteTabView
          tab={tab}
          reason={toLocalizedErrorMessage(
            outcome.error,
            tRoot as unknown as AppErrorTranslator
          )}
          onRetry={() => clearBrowserCreateFailure(tab.id)}
        />
      )
    }
  }
  return (
    <NativeBrowserTabView
      tab={tab}
      egress={connectionId}
      showCreateError={false}
      pendingLabel={host ? t("connecting", { host }) : t("connectingUnnamed")}
    />
  )
}

function NativeBrowserTabView({
  tab,
  egress = null,
  showCreateError,
  pendingLabel,
}: {
  tab: BrowserWorkspaceTab
  /** See `BrowserSurfaceHost`. */
  egress?: number | null
  showCreateError?: boolean
  pendingLabel?: string
}) {
  const state = useBrowserTabState(tab.id)
  const capabilities = useBrowserCapabilities()
  const backendId = browserTabBackendId(tab.id)
  const [findOpen, setFindOpen] = useState(false)
  // ⌘F pressed while the PAGE had keyboard focus: the app's DOM never sees
  // that keystroke, so the host relays it and the store counts it. Read as a
  // counter, not a flag, so pressing it again on an open bar still counts —
  // and applied during render (not in an effect) so the bar is there in the
  // same paint.
  const findRequest = useBrowserFindRequest(tab.id)
  const [seenFindRequest, setSeenFindRequest] = useState(findRequest)
  if (seenFindRequest !== findRequest) {
    setSeenFindRequest(findRequest)
    setFindOpen(true)
  }

  // ⌘F pressed while the focus is in this view's own DOM (address bar, find
  // bar). Bound to the container rather than the window so the shortcut only
  // belongs to the browser when the browser is what the user is in.
  // ⌘F from this view's own DOM counts the same way, so pressing it twice
  // re-focuses the bar instead of doing nothing.
  const [localFindRequest, setLocalFindRequest] = useState(0)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.key.toLowerCase() !== "f") return
    if (!event.metaKey && !event.ctrlKey) return
    event.preventDefault()
    setFindOpen(true)
    setLocalFindRequest((n) => n + 1)
  }
  const url = state?.url || state?.requestedUrl || tab.browser.initialUrl
  const error = state?.error ?? null
  const ownedWindow = state?.surface === "window"
  // Find searches the page, which is in the other window — worth offering
  // when that window answers, and not when the host has no hold on it.
  const canFind = !ownedWindow || (capabilities?.ownedWindowControls ?? false)

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <BrowserToolbar tab={tab} state={state} />
      <BrowserFindBar
        tab={tab}
        open={findOpen && canFind}
        focusToken={findRequest + localFindRequest}
        onClose={() => setFindOpen(false)}
      />
      <BrowserNoticeBar tab={tab} state={state} />
      {/* No band for what agents did: that record is in the address field
          (`BrowserAgentActivityControl`), so it cannot shorten the page it is
          a record of. */}
      <BrowserDownloadBar tab={tab} />
      {/* Nothing is drawn around the page for a shared tab. A native webview
          paints over any DOM at its rect, so the only mark that could be seen
          on the page itself is one around the hole it sits in — and a frame
          around the whole page is too loud a way to say it. The chip in the
          address field and the glyph on the tab strip carry that instead. */}
      <div className="relative min-h-0 flex-1">
        {/* Always mounted so the native surface keeps its bounds; the DOM
            layers below only show when the surface is hidden (error) or
            never embedded (owned window). */}
        <BrowserSurfaceHost
          tab={tab}
          hidden={error !== null}
          className={error || ownedWindow ? "invisible" : undefined}
          egress={egress}
          showCreateError={showCreateError}
          pendingLabel={pendingLabel}
        />
        {error ? (
          <div className="absolute inset-0 bg-background">
            <BrowserErrorPage tab={tab} error={error} url={url} />
          </div>
        ) : ownedWindow ? (
          <div className="absolute inset-0 bg-background">
            <BrowserOwnedWindowCard
              url={url}
              onShow={() =>
                backendId && void browserSetVisible(backendId, true, false)
              }
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
