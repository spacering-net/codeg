"use client"

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  useSessionViewerHost,
  type BrowserRequest,
} from "@/components/message/session-viewer-host-context"
import { useOptionalWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useOptionalWorkspaceActions } from "@/contexts/workspace-context"
import {
  browserCapabilities,
  browserCapabilitiesSnapshot,
} from "@/lib/browser/browser-api"
import {
  bridgeStatus,
  bridgeStatusSnapshot,
} from "@/lib/browser/browser-bridge"
import {
  getBrowserPrefs,
  markBrowserFirstOpenSeen,
  setAllDefaultLinkTargets,
  type LinkSource,
  type LinkTarget,
} from "@/lib/browser/browser-prefs"
import { displayHostPort } from "@/lib/browser/browser-url"
import { remoteServerHost } from "@/lib/browser/remote-host"
import { openInSystemBrowser, openWithOsHandler } from "@/lib/link-open"
import { classifyLinkTarget } from "@/lib/link-classify"
import {
  resolveLinkAction,
  type LinkAction,
  type LinkSurface,
} from "@/lib/resolve-link-action"
import { isDesktop, isRemoteDesktopMode } from "@/lib/transport"

/** What a click did — or, on the desktop before the backend has answered
 *  what it can do, that it will do it as soon as the answer is in. */
export type OpenUrlOutcome = LinkAction | { kind: "deferred" }

export interface OpenUrlOptions {
  source: LinkSource
  /** Primary modifier (⌘ on macOS, Ctrl elsewhere) held during the gesture. */
  modifier?: boolean
  /** Explicit target chosen from a menu; ignores the modifier and preference. */
  forceTarget?: LinkTarget
}

/** ⌘ on macOS, Ctrl elsewhere — the "open the other way" modifier. */
export function isPrimaryModifier(event: {
  metaKey?: boolean
  ctrlKey?: boolean
}): boolean {
  const mac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform)
  return mac ? Boolean(event.metaKey) : Boolean(event.ctrlKey)
}

/**
 * Where an address WOULD go, without sending it there.
 *
 * The same decision `useOpenUrlTarget` executes — site rules, the per-source
 * preference, the surfaces that exist right now — split out because one
 * caller has to know the answer before acting on it: the local-server watch
 * opens a tab on its own only where the answer is the built-in browser, and
 * degrades to asking where it is the system browser (nothing may launch the
 * system browser without a person pressing something).
 */
export function useLinkDecision() {
  // Null outside the workspace (no tab strip to open into): the built-in
  // target is then simply unavailable and links go to the system browser.
  const openBrowserTab = useOptionalWorkspaceActions()?.openBrowserTab ?? null
  const route = useOptionalWorkbenchRoute()
  const viewerHost = useSessionViewerHost()
  const fileColumnVisible = route ? route.isConversations : true

  return useCallback(
    (url: string, options: OpenUrlOptions): LinkAction => {
      const capabilities = browserCapabilitiesSnapshot()
      const somewhereToOpen = openBrowserTab !== null || viewerHost !== null
      // In a browser the server's answer is primed at startup; if it is
      // still missing here (the call failed and its retries ran out), ask
      // again for the next click rather than staying blind for the session.
      if (!isDesktop() && bridgeStatusSnapshot() === null) void bridgeStatus()
      const surface: LinkSurface = {
        builtinAvailable: (capabilities?.available ?? false) && somewhereToOpen,
        fileColumnVisible,
        viewerHostAvailable: viewerHost !== null,
        remoteDesktop: isRemoteDesktopMode(),
        remoteServerHost: remoteServerHost(),
        // Before the answer is in, a loopback link opens as it always did
        // (a new tab) rather than waiting out the gesture.
        bridgeAvailable:
          !isDesktop() &&
          (bridgeStatusSnapshot()?.enabled ?? false) &&
          somewhereToOpen,
      }
      const prefs = getBrowserPrefs()
      return resolveLinkAction(url, {
        source: options.source,
        modifier: options.modifier ?? false,
        forceTarget: options.forceTarget,
        surface,
        prefs,
        hostRules: prefs.hostRules,
        managedHostRules: capabilities?.policy.managedRules,
      })
    },
    [fileColumnVisible, openBrowserTab, viewerHost]
  )
}

/**
 * Decide and execute where an http(s) (or mailto/tel) address goes, INSIDE the
 * caller's call stack. The decision itself (`resolveLinkAction`) is a pure
 * function of a preferences snapshot and this surface; only the execution
 * touches the app: the built-in browser tab (or the transcript's side panel
 * under a full-page route), the system browser, or the OS handler.
 *
 * Returns the action taken so callers can react. Of the rejections only the
 * site-rule block is reported here (its wording is the browser's); the caller
 * owns the toast for an unsupported scheme. Local file paths are not handled:
 * they are `useOpenFileTarget`'s job and never reach this hook.
 */
export function useOpenUrlTarget() {
  const t = useTranslations("Browser.toast")
  // Null outside the workspace (no tab strip to open into): the built-in
  // target is then simply unavailable and links go to the system browser.
  const openBrowserTab = useOptionalWorkspaceActions()?.openBrowserTab ?? null
  const viewerHost = useSessionViewerHost()
  const decide = useLinkDecision()

  const run = useCallback(
    (url: string, options: OpenUrlOptions): LinkAction => {
      const prefs = getBrowserPrefs()
      const action = decide(url, options)
      switch (action.kind) {
        case "system":
          void openInSystemBrowser(action.url)
          break
        case "os-handler":
          void openWithOsHandler(action.url)
          break
        case "builtin": {
          // `remote` rides along to wherever the page opens: an address on
          // the remote codeg host must not load in a profile of this computer.
          const request: BrowserRequest = action.remote
            ? { kind: "browser", url: action.url, remote: true }
            : { kind: "browser", url: action.url }
          if (action.placement === "drawer" && viewerHost) {
            viewerHost.open(request)
          } else if (openBrowserTab) {
            if (action.remote) openBrowserTab(action.url, { remote: true })
            else openBrowserTab(action.url)
          } else if (viewerHost) {
            viewerHost.open(request)
          }
          // The first-open notice offers the "system browser always"
          // preference, which is the desktop's; a bridged dev server in web
          // mode has no such choice. Reaching this case at all means there
          // was somewhere to open into, so the capability alone answers it.
          if (
            !prefs.firstOpenSeen &&
            (browserCapabilitiesSnapshot()?.available ?? false)
          ) {
            markBrowserFirstOpenSeen()
            toast(t("firstOpen"), {
              description: t("firstOpenHint"),
              action: {
                label: t("useSystemAlways"),
                onClick: () => setAllDefaultLinkTargets("system"),
              },
            })
          }
          break
        }
        case "reject":
          // The one rejection this hook owns the wording of: a site rule
          // decided, and the user should learn which host it was.
          if (action.reason === "blocked-host") {
            toast.error(
              t("blockedHost", {
                host: displayHostPort(action.url) ?? action.url,
              })
            )
          }
          break
        case "file":
          break
      }
      return action
    },
    [decide, openBrowserTab, t, viewerHost]
  )

  return useCallback(
    (url: string, options: OpenUrlOptions): OpenUrlOutcome => {
      // On the desktop the decision for a WEB address needs the backend's
      // answer — whether a built-in browser exists and which site rules the
      // administrator has fixed. Before it is in (the first moments after
      // launch) such a click is held until it arrives rather than routed on
      // a guess: routed to the system browser it would slip past a managed
      // block. Only the desktop waits; there the system browser is reached
      // through a command, not through `window.open`, so no user gesture is
      // spent. In the browser the answer is immediate and this never runs.
      // `mailto:`, `tel:`, file paths and refused schemes do not depend on
      // the answer and go through at once.
      if (
        browserCapabilitiesSnapshot() === null &&
        isDesktop() &&
        classifyLinkTarget(url).kind === "http"
      ) {
        void browserCapabilities().then(() => {
          run(url, options)
        })
        return { kind: "deferred" }
      }
      return run(url, options)
    },
    [run]
  )
}
