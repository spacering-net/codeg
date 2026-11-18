"use client"

import { useRemoteConnection } from "@/contexts/remote-connection-context"
import { isDesktop } from "@/lib/platform"

/**
 * The machine whose configuration the Harness page reads and writes.
 *
 * Every MCP, skill and skill-pack command goes through the window's transport,
 * so the answer is whatever that transport talks to:
 *
 * - `local` — the desktop app's own backend: this computer.
 * - `remote` — a desktop window bound to a remote codeg server: that host,
 *   under the name the user gave the connection.
 * - `web` — a browser: the server the page was served from. Whether that is
 *   also the machine in front of the user cannot be told from here (a server
 *   on localhost and a port-forwarded one look the same), so it is named by
 *   its address and nothing is claimed about where it runs.
 */
export type HarnessHost =
  | { kind: "local" }
  | { kind: "remote"; name: string; address: string }
  | { kind: "web"; name: string; address: string }

export function useHarnessHost(): HarnessHost {
  // Non-null only in a remote workspace window, and only once the connection
  // has loaded — the gate renders nothing of the workspace before that.
  const remote = useRemoteConnection()?.connection ?? null
  if (remote) {
    return {
      kind: "remote",
      name: remote.name.trim() || remote.base_url,
      address: remote.base_url,
    }
  }
  if (isDesktop()) return { kind: "local" }
  // The page only ever renders in a browser (a workbench route is entered by
  // a client-side switch), but a prerender must not throw for it either.
  if (typeof window === "undefined") {
    return { kind: "web", name: "", address: "" }
  }
  return {
    kind: "web",
    name: window.location.host,
    address: window.location.origin,
  }
}
