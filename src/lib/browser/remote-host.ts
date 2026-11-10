// Which addresses belong to the remote codeg host a window is bound to.
//
// A remote-workspace window shows a workspace that lives on another machine,
// and the addresses its agents and terminals print — `localhost:3000`, a
// container's `172.17.0.2:8080` — are that machine's. The built-in browser is
// a webview of THIS computer, where the same address reaches this computer
// instead. Every place that opens a tab asks here first, so there is one
// answer for "is this address on the remote host?".

import { getServerBaseUrl, isRemoteDesktopMode } from "@/lib/transport"

import { hostnameOf, isLoopbackHost, isRemoteHostName } from "./browser-url"

/** The remote codeg-server's own host name, in a remote-workspace window;
 *  null anywhere else. */
export function remoteServerHost(): string | null {
  return isRemoteDesktopMode() ? hostnameOf(getServerBaseUrl()) : null
}

/** The remote codeg-server's host as a person recognises it — null when it
 *  is reached through this machine's own loopback (an SSH tunnel), which
 *  names this computer, not the remote host. */
export function remoteHostDisplayName(): string | null {
  const host = remoteServerHost()
  return host && !isLoopbackHost(host) ? host : null
}

/** Whether `url`, opened in this window, names a place on the remote codeg
 *  host rather than on this computer (see `isRemoteHostName`). Always false
 *  outside a remote-workspace window. */
export function isRemoteHostAddress(url: string): boolean {
  if (!isRemoteDesktopMode()) return false
  const hostname = hostnameOf(url)
  return hostname !== null && isRemoteHostName(hostname, remoteServerHost())
}

/** The name a remote tab on macOS gives the remote host's loopback: WebKit
 *  sends `localhost` around any proxy, so those tabs are sent to this name
 *  instead (`browser::remote::ALIAS_HOST` on the Rust side). */
export const REMOTE_ALIAS_HOST = "remote.localhost"

const REMOTE_PROFILE_PREFIX = "remote-"

/** The remote connection a remote profile belongs to (`remote-<id>`, the
 *  profile a remote tab's page lives in); null for every other profile. */
export function remoteConnectionOfProfile(
  profile: string | null | undefined
): number | null {
  if (!profile?.startsWith(REMOTE_PROFILE_PREFIX)) return null
  const id = Number(profile.slice(REMOTE_PROFILE_PREFIX.length))
  return Number.isInteger(id) && id > 0 ? id : null
}

/** A remote tab's address as the remote host knows it: the macOS alias put
 *  back to `localhost`. For whatever leaves the tab — a copied link, the
 *  address shown in its place — where the alias names nothing. A page sent to
 *  the chat is named this way by the backend (`browser::remote::host_address`)
 *  before it gets here. */
export function remoteHostAddress(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== REMOTE_ALIAS_HOST) return url
    parsed.hostname = "localhost"
    return parsed.toString()
  } catch {
    return url
  }
}
