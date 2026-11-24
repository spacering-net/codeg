"use client"

import { useSyncExternalStore } from "react"

import { getActiveRemoteConnectionId } from "@/lib/transport"
import { harnessStatus } from "./api"
import { harnessOrigin } from "./display"
import { isUnsupportedCommandError } from "./errors"

/**
 * What this window knows of `harness_status`: whether the workspace's host
 * offers the catalog, and where the catalog lives.
 *
 * One store per window, outside React, because two things read it that do not
 * share a component: the workspace layout (whether the Harness page has a
 * Discover section) and the Discover section itself (which origin a "view on
 * the website" link is built on, and whether the backend is too old).
 */
export interface HarnessStatusSnapshot {
  /**
   * Whether Discover is offered. The backend's answer once it has given one;
   * until then the last answer this device got from the same host, and on a
   * first visit `true` — the section should not flash in after a moment, nor
   * vanish a moment after it was drawn.
   */
  enabled: boolean
  /** The SpaceRing origin links are built on; `null` until the backend has
   *  answered with one that can be linked. */
  origin: string | null
  /**
   * `unsupported`: the backend has no `harness_status` — an older Codeg. That
   * is NOT "switched off": `enabled` keeps its remembered value, the section
   * stays, and it says the Codeg on the other end needs updating.
   */
  support: "unknown" | "supported" | "unsupported"
}

/** The remembered answer, per host: `"1"` or `"0"`. */
const STORAGE_KEY = "workspace:harness-discover-enabled"

const SERVER_SNAPSHOT: HarnessStatusSnapshot = {
  enabled: true,
  origin: null,
  support: "unknown",
}

/**
 * A remote workspace window shares its `localStorage` with the local windows
 * (same app origin) but asks a different backend, so each remote connection
 * remembers its own answer. In a browser the page's origin already is the
 * host.
 */
function storageKey(): string {
  const remoteId = getActiveRemoteConnectionId()
  return remoteId === null ? STORAGE_KEY : `${STORAGE_KEY}:remote-${remoteId}`
}

function loadRemembered(): boolean {
  if (typeof window === "undefined") return true
  try {
    return localStorage.getItem(storageKey()) !== "0"
  } catch {
    return true
  }
}

function remember(enabled: boolean): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(storageKey(), enabled ? "1" : "0")
  } catch {
    /* ignore */
  }
}

let snapshot: HarnessStatusSnapshot | null = null
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

/** Built on first read rather than at import: by then the remote connection
 *  (if this is a remote window) is configured, and the right key is read. */
export function getHarnessStatus(): HarnessStatusSnapshot {
  snapshot ??= { enabled: loadRemembered(), origin: null, support: "unknown" }
  return snapshot
}

function publish(next: HarnessStatusSnapshot): void {
  const prev = getHarnessStatus()
  if (
    prev.enabled === next.enabled &&
    prev.origin === next.origin &&
    prev.support === next.support
  ) {
    return
  }
  snapshot = next
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Ask the backend again. Calls that overlap share one request.
 *
 * Never rejects. A backend without the command is recorded as `unsupported`;
 * any other failure (the Codeg server out of reach) changes nothing, so the
 * remembered answer stands until the backend can be asked.
 */
export function refreshHarnessStatus(): Promise<void> {
  inFlight ??= (async () => {
    try {
      const status = await harnessStatus()
      remember(status.enabled)
      publish({
        enabled: status.enabled,
        origin: harnessOrigin(status.origin),
        support: "supported",
      })
    } catch (error) {
      if (isUnsupportedCommandError(error)) {
        publish({ ...getHarnessStatus(), support: "unsupported" })
      }
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

export function useHarnessStatus(): HarnessStatusSnapshot {
  return useSyncExternalStore(
    subscribe,
    getHarnessStatus,
    () => SERVER_SNAPSHOT
  )
}

/** Test-only: forget everything, so one test's answer is not the next one's
 *  remembered state. */
export function __resetHarnessStatusForTests(): void {
  snapshot = null
  inFlight = null
  listeners.clear()
}
