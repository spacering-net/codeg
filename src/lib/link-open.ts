// The primitive ways of opening an external address from the app, shared by
// the transcript link flow and the built-in browser's link decision. No React.

import { getActiveRemoteConnectionId, isDesktop } from "@/lib/transport"
import { openUrl } from "@/lib/platform"

/**
 * True when `window.open` actually opens something — i.e. a real browser.
 *
 * NOT the same question as `isWebOpenerEnvironment` below. A Tauri window bound
 * to a remote codeg-server is still a TAURI WEBVIEW, and a webview that
 * registers no new-window handler opens nothing at all for `window.open` (wry
 * answers with nil on macOS, `SetHandled(true)` on Windows). Lumping remote
 * windows in with web mode here left every http(s) link in a remote workspace
 * silently dead; they must take the opener-plugin path instead, which
 * `capabilities/default.json` grants to the `remote-*` windows.
 */
export function windowOpenReachesABrowser(): boolean {
  return !isDesktop()
}

/**
 * True when a `mailto:`/`tel:` URL should be handed to the OS through a
 * synthetic anchor rather than the Tauri opener plugin — pure web, or a Tauri
 * window bound to a remote codeg-server.
 *
 * The remote arm stays deliberately: unlike `window.open`, a synthetic anchor
 * DOES reach the OS handler from inside a webview, and it sidesteps the
 * question of whether the opener capability covers non-http(s) schemes.
 */
export function isWebOpenerEnvironment(): boolean {
  return !isDesktop() || getActiveRemoteConnectionId() !== null
}

/**
 * Trigger an OS-registered protocol handler (mail client, dialer) from a
 * browser without leaving an empty tab. The synthetic anchor has no
 * `target`, so the browser hands the URL to the OS handler and stays on
 * the current page.
 */
export function dispatchOsHandlerUrl(url: string): void {
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.rel = "noreferrer noopener"
  document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
  }
}

/**
 * Open an external URL in a new tab. Callers MUST invoke this inside the
 * click's own call stack — see `openLinkWithSafety` in link-safety.tsx.
 */
export function openExternalTab(url: string): void {
  // `noreferrer` (which implies `noopener`) matters for AI-authored links: the
  // opened page gets no `window.opener` handle back into the app and no
  // Referer. It also makes `window.open` return null even on success (HTML
  // window open steps 12 and 17), so the return value carries no signal —
  // don't test it for a "popup blocked" check, it would fire on every success.
  window.open(url, "_blank", "noreferrer")
}

/**
 * Open an http(s) URL in the SYSTEM browser: `window.open` where that reaches
 * a browser (web mode — synchronous, inside the gesture), the Tauri opener
 * plugin otherwise (desktop, including remote windows; no gesture needed).
 */
export function openInSystemBrowser(url: string): Promise<void> {
  if (windowOpenReachesABrowser()) {
    openExternalTab(url)
    return Promise.resolve()
  }
  return openUrl(url)
}

/** `mailto:` / `tel:` — the OS handler route. */
export function openWithOsHandler(url: string): Promise<void> {
  if (isWebOpenerEnvironment()) {
    dispatchOsHandlerUrl(url)
    return Promise.resolve()
  }
  return openUrl(url)
}
