"use client"

import { useEffect } from "react"

import { useWorkspaceActions } from "@/contexts/workspace-context"
import {
  browserAnswerOpenRequest,
  browserCapabilities,
  browserClose,
  browserListDownloads,
  browserListTabs,
  browserSetHostRules,
  browserSetSignInUserAgent,
} from "@/lib/browser/browser-api"
import {
  applyDefaultAgentGrant,
  forgetDefaultAgentGrant,
} from "@/lib/browser/browser-agent-grant"
import { watchBlankPageTheme } from "@/lib/browser/blank-page-theme"
import {
  getBrowserPrefs,
  subscribeBrowserPrefs,
} from "@/lib/browser/browser-prefs"
import {
  hydrateBrowserDownloads,
  setBrowserDownload,
} from "@/lib/browser/browser-downloads-store"
import { setBrowserEgressStatus } from "@/lib/browser/browser-egress-store"
import {
  browserWorkspaceTabId,
  getBrowserTabState,
  recordBrowserAgentActivity,
  removeBrowserTabState,
  requestBrowserFind,
  setBrowserConsoleErrors,
  setBrowserTabNotice,
  setBrowserTabState,
  setDocGuestState,
  requestBrowserBoundsResync,
  takeSuspendCloseRequest,
} from "@/lib/browser/browser-tab-store"
import {
  BROWSER_AGENT_ACTIVITY_EVENT,
  BROWSER_AGENT_GRANT_EVENT,
  BROWSER_CLOSED_EVENT,
  BROWSER_CONSOLE_ERRORS_EVENT,
  BROWSER_DEVTOOLS_CLOSED_EVENT,
  BROWSER_DOC_STATE_EVENT,
  BROWSER_DOWNLOAD_EVENT,
  BROWSER_EGRESS_EVENT,
  BROWSER_NAVIGATION_BLOCKED_EVENT,
  BROWSER_OPEN_REQUEST_EVENT,
  BROWSER_POPUP_EVENT,
  BROWSER_SHORTCUT_EVENT,
  BROWSER_STATE_EVENT,
  type AgentActivityPayload,
  type AgentGrantPayload,
  type BrowserClosedPayload,
  type BrowserConsoleErrorsPayload,
  type BrowserDevtoolsClosedPayload,
  type BrowserDownload,
  type BrowserEgressPayload,
  type BrowserNavigationBlockedPayload,
  type BrowserOpenRequestPayload,
  type BrowserPopupPayload,
  type BrowserShortcutPayload,
  type BrowserTabState,
  type DocGuestState,
} from "@/lib/browser/types"
import { getShellTransport, isDesktop } from "@/lib/transport"
import { bridgeStatus } from "@/lib/browser/browser-bridge"
import { getCurrentWindowLabel } from "@/lib/browser/window-label"
import { browserTabBackendId } from "@/lib/file-tab-id"

/**
 * The one subscriber to the backend's `browser://*` streams. Mounted once
 * inside the workspace providers (it needs the workspace actions to add and
 * remove tab records); renders nothing.
 *
 * - `browser://state`  → the tab store (toolbar, status layer, tab title), and
 *   the standing sharing default applied to a page that has just committed
 * - `browser://popup`  → an adopted popup becomes a tab next to its opener
 * - `browser://closed` → a surface the backend tore down (owned window closed
 *   by the user, owner window gone) drops its tab record
 * - `browser://open-request` → the backend (an agent tool, a deep link, the
 *   dev puppet) asks this window's workspace to open a URL
 * - `browser://download` → the download bar of the tab that started it
 * - `browser://shortcut` → a browser shortcut the page had focus for (⌘F)
 * - `browser://navigation-blocked` → a notice on the tab whose navigation
 *   policy refused
 * - `browser://doc-state` → the mode of a document guest (the file column's
 *   HTML preview), including a fall-back to safe mode
 * - `browser://agent-grant` → a notice when a page navigating away took its
 *   own sharing with it
 * - `browser://agent-activity` → the activity strip of the tab an agent
 *   reached for
 * - `browser://console-errors` → the mark on the "send to chat" control of a
 *   tab whose page has printed an error, and its removal when a new document
 *   commits
 * - `browser://egress` → whether a remote connection's tunnel still carries
 *   its tabs (the banner over a remote tab turns red when it does not)
 *
 * It also carries two preferences the other way: the user's site rules (the
 * backend enforces `block` on every navigation a tab attempts) and the
 * sign-in user-agent switch (applied on navigations to Google's sign-in
 * hosts). Both go at startup and whenever they change (the settings window
 * writes them; the storage event brings them over).
 *
 * Only subscribes where a built-in browser exists; in web mode there is
 * nothing to hear.
 */
/** Delay before the one retry of a failed site-rule push. */
const HOST_RULES_RETRY_MS = 1000

export function BrowserEventsBridge() {
  const { adoptBrowserTab, closeFileTab, openBrowserTab } =
    useWorkspaceActions()

  // The empty tab's page is a document the BACKEND paints (the engine's own
  // is white in every theme — `browser::blank_page`), in colours only this
  // side knows: they are variables of the running theme. Its own effect, not
  // the preference push below: this follows the theme, not the browser's
  // settings, and it is pushed before any capability round trip so the first
  // tab of a run opens in the right colours. In web mode there are no native
  // surfaces to paint.
  useEffect(() => {
    if (!isDesktop()) return
    return watchBlankPageTheme()
  }, [])

  useEffect(() => {
    let cancelled = false
    const unsubscribers: Array<() => void> = []

    // The user's site rules and the sign-in user-agent switch go to the
    // backend, which enforces `block` on every navigation and the identity
    // on Google's sign-in hosts. Subscribed BEFORE the first await: a change
    // written by the settings window while the capabilities round trip is
    // in flight must reach this document's cache (the subscription is what
    // installs the cross-window listener) and then the backend. The first
    // push happens once capabilities say a browser exists, and carries
    // whatever is current then. A push that fails is retried once — the
    // commands have no reason to fail except the app shutting down, and a
    // silent divergence would be an unenforced rule.
    let ready = false
    const push = (retry: boolean) => {
      // Before the backend is known to exist a change only invalidates the
      // cache (the subscription did that); the first push below picks up
      // whatever is current by then.
      if (!ready) return
      const prefs = getBrowserPrefs()
      void Promise.all([
        browserSetHostRules(prefs.hostRules),
        browserSetSignInUserAgent(prefs.signInUserAgent),
      ]).catch(() => {
        if (cancelled) return
        if (retry) {
          window.setTimeout(() => {
            if (!cancelled) push(false)
          }, HOST_RULES_RETRY_MS)
        } else {
          console.warn(
            "[browser] browser preferences could not be sent to the backend"
          )
        }
      })
    }
    unsubscribers.push(subscribeBrowserPrefs(() => push(true)))

    void (async () => {
      // In a browser the only browser-tab surface is the port bridge; ask
      // once now so a click on `localhost:3000` can be routed synchronously.
      if (!isDesktop()) void bridgeStatus()
      const capabilities = await browserCapabilities()
      if (cancelled || !capabilities.available) return
      // Tab records are session-only, so any surface the backend still holds
      // for this window when the bridge first mounts is an orphan of a
      // previous document (a dev reload, a crashed frontend). Close them,
      // or they would stay painted over the new UI with nothing to hide them.
      try {
        const orphans = await browserListTabs()
        await Promise.all(orphans.map((tab) => browserClose(tab.tabId)))
      } catch {
        /* nothing to sweep */
      }
      // Downloads outlive the tabs that started them (and this document): a
      // reload must not lose the record of a file that is still arriving.
      try {
        hydrateBrowserDownloads(await browserListDownloads())
      } catch {
        /* no downloads to show */
      }
      if (cancelled) return
      // This app's own backend, as for the commands (see `browser-api.ts`).
      const transport = getShellTransport()
      const subs = await Promise.all([
        transport.subscribe<BrowserTabState>(BROWSER_STATE_EVENT, (state) => {
          setBrowserTabState(state)
          // A committed page is the moment the standing sharing default has
          // something to bind to, and this event is the only one that says a
          // page committed — whoever asked for it.
          applyDefaultAgentGrant(state)
        }),
        transport.subscribe<BrowserPopupPayload>(
          BROWSER_POPUP_EVENT,
          (popup) => {
            if (popup.presentation === "denied") {
              setBrowserTabNotice(browserWorkspaceTabId(popup.openerTabId), {
                kind: "popup-denied",
                url: popup.url,
                reason: popup.reason,
              })
              return
            }
            if (!popup.tabId) return
            // Every window hears every popup; only the one its opener lives
            // in takes it in, or each workspace window would grow the tab.
            // The popup's own state, sent just before this event, names that
            // window (the one it inherited from its opener); failing that,
            // the opener's own state does. Only with neither in hand is the
            // popup taken in as it always was.
            const owner =
              getBrowserTabState(browserWorkspaceTabId(popup.tabId))
                ?.ownerWindow ??
              getBrowserTabState(browserWorkspaceTabId(popup.openerTabId))
                ?.ownerWindow
            if (owner && owner !== getCurrentWindowLabel()) return
            adoptBrowserTab({
              backendTabId: popup.tabId,
              url: popup.url,
              openerBackendTabId: popup.openerTabId,
              profile: popup.profile,
            })
          }
        ),
        transport.subscribe<BrowserClosedPayload>(
          BROWSER_CLOSED_EVENT,
          (closed) => {
            // The answer to a close this side asked for to SUSPEND a tab: the
            // surface goes and the tab stays. Every close arrives as this one
            // event, so a suspend looks exactly like a page closing its own
            // popup — and acted on it would take the tab off the strip and
            // forget what its sites were shared at, the whole of what a
            // suspend must not do. Matched on the request id and not on the
            // tab, because only one close event is ever emitted per tab: a
            // real close that overtakes a suspend is the only one there will
            // be, and must still be acted on.
            if (takeSuspendCloseRequest(closed.requestId)) return
            const tabId = browserWorkspaceTabId(closed.tabId)
            removeBrowserTabState(tabId)
            // The tab is over: this side closed it (and has already taken it
            // off the strip), an agent closed it, its profile was deleted, or
            // the window it lived in went away. Its sites are nobody's
            // answers now.
            forgetDefaultAgentGrant(closed.tabId)
            closeFileTab(tabId)
          }
        ),
        // A tab's web inspector has gone. Put the page back where the host
        // wants it — unconditionally, because the host cannot tell whether it
        // has to: an inspector docked into this window (which is not how they
        // open, but is what WebKit gives whoever asks it for that) leaves the
        // page filling the window, and the placeholder never moved, so nothing
        // the host measures differs. For one that was in its own window all
        // along this re-sends the bounds the page already has.
        transport.subscribe<BrowserDevtoolsClosedPayload>(
          BROWSER_DEVTOOLS_CLOSED_EVENT,
          (closed) => {
            requestBrowserBoundsResync(closed.tabId)
          }
        ),
        transport.subscribe<BrowserShortcutPayload>(
          BROWSER_SHORTCUT_EVENT,
          (payload) => {
            if (payload.shortcut === "find") {
              requestBrowserFind(browserWorkspaceTabId(payload.tabId))
            }
          }
        ),
        transport.subscribe<BrowserDownload>(
          BROWSER_DOWNLOAD_EVENT,
          (download) => {
            setBrowserDownload(download)
          }
        ),
        transport.subscribe<BrowserNavigationBlockedPayload>(
          BROWSER_NAVIGATION_BLOCKED_EVENT,
          (blocked) => {
            setBrowserTabNotice(browserWorkspaceTabId(blocked.tabId), {
              kind: "navigation-blocked",
              url: blocked.url,
              reason: blocked.reason,
            })
          }
        ),
        transport.subscribe<DocGuestState>(BROWSER_DOC_STATE_EVENT, (doc) => {
          setDocGuestState(doc)
        }),
        transport.subscribe<AgentGrantPayload>(
          BROWSER_AGENT_GRANT_EVENT,
          (grant) => {
            // What the level IS travels on `browser://state`, which the
            // toolbar reads. The only things worth a notice here are the
            // transitions the user did not perform, and an agent that was
            // working on the tab has just started being refused for.
            if (!grant.origin) return
            if (grant.change === "navigated") {
              // The page walked off the origin it was shared for. Worth
              // interrupting for only where sharing is something the person
              // did: with a standing default in force this fires on every
              // cross-site click, and an alarm bar on every click is worse
              // than none — the toolbar says what the new page is shared at,
              // in the same place it always does.
              //
              // The cost is paid in the case where the tab lands somewhere
              // the default cannot cover (an address no grant binds to, or
              // one the backend refuses): the grant ends, nothing replaces
              // it, and nothing says so. That is the same silence a page
              // nobody shared already lives in, and the price of not crying
              // wolf on the ordinary path.
              if (getBrowserPrefs().defaultAgentGrant !== "none") return
              setBrowserTabNotice(browserWorkspaceTabId(grant.tabId), {
                kind: "agent-grant-lost",
                origin: grant.origin,
              })
            } else if (grant.change === "replaced") {
              // The page stayed put and the server behind it changed.
              setBrowserTabNotice(browserWorkspaceTabId(grant.tabId), {
                kind: "agent-grant-replaced",
                origin: grant.origin,
              })
            }
          }
        ),
        transport.subscribe<AgentActivityPayload>(
          BROWSER_AGENT_ACTIVITY_EVENT,
          (activity) => {
            recordBrowserAgentActivity(activity)
          }
        ),
        transport.subscribe<BrowserConsoleErrorsPayload>(
          BROWSER_CONSOLE_ERRORS_EVENT,
          (payload) => {
            setBrowserConsoleErrors(
              browserWorkspaceTabId(payload.tabId),
              payload.errors
            )
          }
        ),
        // Every connection's: a window only looks up the one its remote
        // tabs go through.
        transport.subscribe<BrowserEgressPayload>(
          BROWSER_EGRESS_EVENT,
          (payload) => {
            setBrowserEgressStatus(payload.connectionId, payload.status)
          }
        ),
        transport.subscribe<BrowserOpenRequestPayload>(
          BROWSER_OPEN_REQUEST_EVENT,
          (request) => {
            // Every window hears every event; only the addressed one acts.
            const target = request.ownerWindow ?? "main"
            if (target !== getCurrentWindowLabel()) return
            const openerTabId = request.openerTabId
              ? browserWorkspaceTabId(request.openerTabId)
              : undefined
            const workspaceTabId = openBrowserTab(request.url, {
              activate: request.activate,
              openerTabId,
              profile: request.profile ?? undefined,
            })
            // An asker that named itself is waiting to hear which tab this
            // became — an agent's `browser_open_tab`, which has no other way
            // to name the page it just asked for. The backend id is known as
            // soon as the record is (the native surface is built later, when
            // the tab is on screen), so the answer does not wait on a webview.
            if (!request.requestId) return
            void browserAnswerOpenRequest(
              request.requestId,
              workspaceTabId ? browserTabBackendId(workspaceTabId) : null
            ).catch(() => {
              // Nobody to tell. The waiter's own timeout covers this, and the
              // tab — if there is one — is on screen regardless.
            })
          }
        ),
      ])
      if (cancelled) {
        for (const unsubscribe of subs) unsubscribe()
        return
      }
      unsubscribers.push(...subs)
      ready = true
      // The first push, whether or not a change arrived meanwhile: the
      // backend starts with an empty table.
      push(true)
    })()

    return () => {
      cancelled = true
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [adoptBrowserTab, closeFileTab, openBrowserTab])

  return null
}
