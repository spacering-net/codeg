// Where each remote connection's egress stands, from `browser://egress`:
// whether the remote tabs of that connection still reach the remote host.
// Keyed by connection id. A connection nothing has been heard about is taken
// to be fine — its tabs only exist because an open through it succeeded.

import { useSyncExternalStore } from "react"

import type { BrowserEgressStatus } from "./types"

const statuses = new Map<number, BrowserEgressStatus>()
const listeners = new Set<() => void>()

export function setBrowserEgressStatus(
  connectionId: number,
  status: BrowserEgressStatus
): void {
  statuses.set(connectionId, status)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getServerNull(): null {
  return null
}

/** The egress of `connectionId` as last heard; null when nothing was. */
export function useBrowserEgressStatus(
  connectionId: number | null
): BrowserEgressStatus | null {
  return useSyncExternalStore(
    subscribe,
    () => (connectionId === null ? null : (statuses.get(connectionId) ?? null)),
    getServerNull
  )
}

/** Whether the tunnel of a connection in this state carries nothing: the
 *  pages of its tabs cannot load until it is back. */
export function egressIsDown(status: BrowserEgressStatus | null): boolean {
  return (
    status?.state === "down" ||
    status?.state === "unsupported" ||
    status?.state === "disabled"
  )
}

/** Tests only. */
export function resetBrowserEgressStoreForTests(): void {
  statuses.clear()
}
