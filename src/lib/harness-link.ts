/**
 * "Open in Codeg" for a Harness item: the address a link carries, on its way
 * from wherever it arrived to the Harness page.
 *
 * A link reaches the workspace in one of three ways, and each ends here as a
 * checked address waiting for the workspace to open it:
 *
 * - `codeg://harness/install?ref=<publisher>/<name>`, which the desktop app
 *   parks for the local workspace window to claim (`takePendingHarnessLink`);
 * - `/workspace?harness=<publisher>/<name>`: a Codeg Web address, and where
 *   the desktop app points its window on a Windows or Linux cold start;
 * - that same address carried across the instance's login page, which the
 *   redirect to it would otherwise drop.
 *
 * A link only ever opens the item. Any web page can send one, so nothing here
 * installs anything, and an address that is not one stops at the first check.
 */

import { parseItemRef } from "@/lib/harness/item-ref"
import {
  forgetKeptForLogin,
  keepForLogin,
  takeKeptForLogin,
  takeQueryParamFromAddress,
  withoutQueryParam,
} from "@/lib/workspace-address"

export { AFTER_LOGIN_MAX_AGE_MS } from "@/lib/workspace-address"

/** The query parameter of `/workspace?harness=<publisher>/<name>`. */
export const HARNESS_LINK_PARAM = "harness"

/**
 * The item a query string asks for, or `null` — for none, and for a value that
 * is not an address. Parameters other than this one are no concern of it.
 */
export function harnessLinkRefOf(search: string): string | null {
  const value = new URLSearchParams(search).get(HARNESS_LINK_PARAM)
  return parseItemRef(value)?.ref ?? null
}

/** `search` without the parameter, every other one left exactly as it was
 *  written (`withoutQueryParam`). */
export function withoutHarnessLinkParam(search: string): string {
  return withoutQueryParam(search, HARNESS_LINK_PARAM)
}

/**
 * Read the item this page's address asks for, and take the parameter off the
 * address, so that nothing can read it a second time
 * (`takeQueryParamFromAddress`). Done for a value that is not an address too:
 * it is dropped, silently, and the workspace shows as usual.
 */
export function takeHarnessLinkFromAddress(): string | null {
  const value = takeQueryParamFromAddress(HARNESS_LINK_PARAM)
  return value === null ? null : (parseItemRef(value)?.ref ?? null)
}

// ─── The link waiting to be opened ────────────────────────────────────

// Outside React, because the two ends do not meet in one tree: the desktop
// claim happens beside the conversation deep links, outside the providers the
// Harness page needs, and a link can arrive before the workspace is up.
let waiting: string | null = null
const listeners = new Set<() => void>()

function setWaiting(next: string | null): void {
  if (next === waiting) return
  waiting = next
  for (const listener of [...listeners]) listener()
}

/**
 * Hand an address over to be opened as soon as the workspace can. One slot,
 * the newest link taking it: a second link that arrives before the first is
 * open is the one the user is now looking for. Anything that is not an address
 * is refused here as well, whoever handed it over.
 */
export function queueHarnessLink(ref: string): void {
  const parsed = parseItemRef(ref)
  if (parsed) setWaiting(parsed.ref)
}

/** The address waiting to be opened, or `null`. */
export function waitingHarnessLink(): string | null {
  return waiting
}

/** Take the waiting address: whoever gets it opens it, and nobody else can. */
export function takeWaitingHarnessLink(): string | null {
  const ref = waiting
  setWaiting(null)
  return ref
}

export function subscribeWaitingHarnessLink(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// ─── Across the instance's login ──────────────────────────────────────

const AFTER_LOGIN_KEY = "codeg:harness-link-after-login"

/**
 * Called on the way to `/login`, whose redirect drops the query: keep the
 * address still waiting to be opened for after the login, or — with none
 * waiting — make sure no older one is left to come back instead
 * (`keepForLogin`).
 */
export function keepHarnessLinkForLogin(): void {
  keepForLogin(AFTER_LOGIN_KEY, waiting === null ? null : { ref: waiting })
}

/**
 * The address kept for after the login, once: it is gone after this, whatever
 * it was. One kept too long ago, or that is not an address, is `null`.
 */
export function takeHarnessLinkAfterLogin(
  now: number = Date.now()
): string | null {
  const kept = takeKeptForLogin(AFTER_LOGIN_KEY, now)
  return parseItemRef(kept?.ref)?.ref ?? null
}

/** Drop an address kept for a login that never came. The workspace calls this
 *  as it loads: by then that login is over, one way or the other. */
export function forgetHarnessLinkForLogin(): void {
  forgetKeptForLogin(AFTER_LOGIN_KEY)
}

/** Where a successful login goes: the workspace, with the item kept for after
 *  the login — if there is one, and only this once. */
export function workspacePathAfterLogin(): string {
  const ref = takeHarnessLinkAfterLogin()
  return ref === null
    ? "/workspace"
    : `/workspace?${HARNESS_LINK_PARAM}=${encodeURIComponent(ref)}`
}

/** Test-only: forget the waiting link, so one test's is not the next one's. */
export function __resetHarnessLinkForTests(): void {
  waiting = null
  listeners.clear()
}
