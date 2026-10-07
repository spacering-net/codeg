// Client of the web-mode port bridge: when the workbench runs in a browser,
// a dev server on the codeg host (`http://localhost:3000` as an agent printed
// it) is shown through a bridge origin of its own — a listener the server
// binds next to its own port, or a hostname it answers for on that same port.
// The workbench asks the API for a grant, then loads the bridge's entry URL
// in an iframe; the entry sets the cookie and redirects to the page. No
// React, no DOM beyond `fetch` for the reachability probe.

import { getTransport, isDesktop } from "@/lib/transport"

import { isLoopbackHost } from "./browser-url"

export interface BridgeStatus {
  enabled: boolean
  /** Ports a listener may take (`0` = any free port); empty when targets are
   *  named by hostname. */
  ports: number[]
  /** Hostname to use for the bridge instead of the page's own. */
  publicHost: string | null
  /** How a target is named when the server addresses them by hostname on its
   *  own port (`{port}.codeg.example.com`, `auto`). */
  hostPattern: string | null
}

export interface BridgeGrant {
  targetPort: number
  /** Port of the listener that answers for this target; `null` when it is
   *  named by hostname and the browser keeps the port it already uses. */
  bridgePort: number | null
  /** Hostname that names this target, when the server addresses by host. */
  bridgeHost: string | null
  /** Path on the bridge origin that sets the cookie and redirects. */
  entryPath: string
  publicHost: string | null
  /** Path and query of the requested address, for the entry redirect. */
  path: string
}

const OFF: BridgeStatus = {
  enabled: false,
  ports: [],
  publicHost: null,
  hostPattern: null,
}

/** Pauses between attempts when the status call fails (the server is
 *  starting, a flaky connection): three tries in all, then the next caller
 *  asks again. */
export const STATUS_RETRY_DELAYS_MS = [1000, 3000]

let statusPromise: Promise<BridgeStatus> | null = null
let resolvedStatus: BridgeStatus | null = null

async function askStatus(): Promise<BridgeStatus> {
  for (let attempt = 0; ; attempt++) {
    try {
      const status = await getTransport().call<BridgeStatus>(
        "browser_bridge_status",
        {}
      )
      resolvedStatus = status
      return status
    } catch {
      const delay = STATUS_RETRY_DELAYS_MS[attempt]
      if (delay === undefined) {
        statusPromise = null
        return OFF
      }
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

/**
 * Whether this server bridges dev-server ports. Cached for the session; the
 * desktop never needs it (its browser tabs reach the host directly). A call
 * that fails after its retries is not cached, so the next caller asks again.
 */
export function bridgeStatus(): Promise<BridgeStatus> {
  if (isDesktop()) {
    resolvedStatus = OFF
    return Promise.resolve(OFF)
  }
  if (!statusPromise) statusPromise = askStatus()
  return statusPromise
}

/** Synchronous view for decisions inside a click; null until asked once. */
export function bridgeStatusSnapshot(): BridgeStatus | null {
  return resolvedStatus
}

/** Tests only. */
export function resetBridgeStatusForTests(): void {
  statusPromise = null
  resolvedStatus = null
}

export function bridgeOpen(url: string, tabId: string): Promise<BridgeGrant> {
  return getTransport().call<BridgeGrant>("browser_bridge_open", { url, tabId })
}

export function bridgeClose(tabId: string): Promise<void> {
  return getTransport()
    .call<unknown>("browser_bridge_close", { tabId })
    .then(() => undefined)
}

/**
 * An address the bridge can carry: plain http to the host's own loopback.
 * A private-network or public host is not the server's to forward, and the
 * bridge speaks to its target without TLS.
 */
export function isBridgeableUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)
  } catch {
    return false
  }
}

export interface PageLocation {
  /** `https:` / `http:` — the bridge follows the page's scheme. */
  protocol: string
  hostname: string
  /** `location.port`: empty for the scheme's default port. */
  port: string
}

/**
 * Origin of the grant's listener as this browser should reach it.
 *
 * Addressed by port: the server's public host when it named one, else the
 * host the workbench was loaded from — the same host, a different port,
 * which keeps the bridge's cookie same-site with the workbench. Addressed by
 * hostname: the name the server gave this target, on the port the browser is
 * already talking to, which is the same listener.
 */
export function bridgeOrigin(grant: BridgeGrant, page: PageLocation): string {
  const host = grant.bridgeHost ?? grant.publicHost ?? page.hostname
  const authority =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
  const port = grant.bridgePort ?? page.port
  return port
    ? `${page.protocol}//${authority}:${port}`
    : `${page.protocol}//${authority}`
}

/**
 * The URL the frame loads first: the entry that sets the cookie, told where
 * to go next. The grant carries the path and query; the fragment of the
 * address the user opened (`#install`) never reached the server and is
 * appended here.
 */
export function bridgeEntryUrl(
  grant: BridgeGrant,
  page: PageLocation,
  fragment = ""
): string {
  const path = grant.path.startsWith("/") ? grant.path : `/${grant.path}`
  const to = fragment && !path.includes("#") ? `${path}${fragment}` : path
  return `${bridgeOrigin(grant, page)}${grant.entryPath}?to=${encodeURIComponent(to)}`
}

/** `#install` of an address, or the empty string. */
export function fragmentOf(url: string): string {
  try {
    return new URL(url).hash
  } catch {
    return ""
  }
}

/**
 * Whether the listener answers from where this browser sits. Unmapped ports
 * (Docker without the range published, a firewall) are the likely failure,
 * and a blank frame would say nothing about it.
 */
export async function probeBridge(
  origin: string,
  timeoutMs = 4000
): Promise<boolean> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${origin}/__codeg_bridge/ping`, {
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    window.clearTimeout(timer)
  }
}
