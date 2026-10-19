// SSR-safe adapter between the `WebTransport` connection-health state machine
// and React's `useSyncExternalStore`. Kept as plain functions (no context,
// no hooks) so the single global `<WebConnectionGuard>` can subscribe without
// threading the transport singleton through the tree.
//
// Every accessor is guarded three ways:
//   1. SSR / static-export prerender (`window` undefined) → stable "connected"
//      so the dialog never renders server-side and hydration stays clean.
//   2. Non-web runtime (Tauri desktop) → no-op; desktop has no browser WS.
//   3. Remote-desktop windows → no-op; those use their own full-screen
//      "connection expired" gate (see remote-connection-context.tsx) and must
//      not stack a second dialog.

import { detectEnvironment } from "./detect"
import { getShellTransport, isRemoteDesktopMode } from "./index"
import type { WebConnState, WebTransport } from "./web-transport"

// Module-level constant so `getServerSnapshot` returns a STABLE reference on
// every call — React warns / loops if the server snapshot identity changes.
const CONNECTED: WebConnState = "connected"

const noop = () => {}

// Resolve the active WebTransport, or null when the reconnect dialog must stay
// dormant (SSR, desktop, remote-desktop). The shape check is belt-and-braces:
// the env guard already guarantees a WebTransport, but it keeps a future
// transport swap from crashing the dialog plumbing.
function webTransport(): WebTransport | null {
  if (typeof window === "undefined") return null
  if (detectEnvironment() !== "web" || isRemoteDesktopMode()) return null
  const transport = getShellTransport()
  if (
    typeof (transport as Partial<WebTransport>).subscribeConnection !==
    "function"
  ) {
    return null
  }
  return transport as WebTransport
}

/** Whether this page was served by the server it talks to — false on desktop
 *  and in remote-desktop windows, whose pages ship with the app. */
export function usesWebTransport(): boolean {
  return webTransport() !== null
}

export function subscribeWebConnection(callback: () => void): () => void {
  const transport = webTransport()
  if (!transport) return noop
  return transport.subscribeConnection(callback)
}

export function getWebConnectionSnapshot(): WebConnState {
  return webTransport()?.getConnectionSnapshot() ?? CONNECTED
}

export function getWebConnectionServerSnapshot(): WebConnState {
  return CONNECTED
}

/** Manual "Reconnect now" from the dialog: forces an immediate health probe. */
export function reconnectWebNow(): void {
  webTransport()?.reconnectNow()
}

/**
 * Funnel a definitive HTTP 401 (e.g. from a raw file-upload fetch in
 * `lib/api.ts` that bypasses `WebTransport.call`) into the same unauthorized
 * dialog state, rather than an abrupt redirect. No-op off the web shell.
 */
export function notifyWebUnauthorized(): void {
  webTransport()?.markUnauthorized()
}
