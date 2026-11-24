/**
 * How a Codeg Web sign-in ended: `/workspace?srn=<result>`, where the
 * server's callback sends the browser back. Read once as the workspace loads,
 * taken off the address, and shown once in the SRN popover — the way
 * `lib/harness-link.ts` handles `?harness=`, with the same helpers
 * (`lib/workspace-address.ts`), including the trip across the instance's
 * login.
 */

import {
  forgetKeptForLogin,
  keepForLogin,
  takeKeptForLogin,
  takeQueryParamFromAddress,
} from "@/lib/workspace-address"
import type { SrnProblem, SrnProblemName } from "./problems"

export const SRN_RESULT_PARAM = "srn"

/** Where a result not shown yet is kept across the instance's login. */
const AFTER_LOGIN_KEY = "codeg:srn-result-after-login"

/**
 * Every value the server writes there (`CALLBACK_RESULTS` in
 * `src-tauri/src/srn/web/types.rs`), and the problem each one is. Anything
 * else is not a result.
 */
const RESULT_PROBLEMS: Readonly<Record<string, SrnProblemName | null>> = {
  ok: null,
  access_denied: "accessDenied",
  expired: "expired",
  flow_missing: "flowMissing",
  invalid_callback: "invalidCallback",
  exchange_failed: "exchangeFailed",
  client_rejected: "clientRejected",
  network: "network",
  rate_limited: "rateLimited",
  server: "server",
  invalid_response: "invalidResponse",
  account_changed: "accountChanged",
  revoked: "revoked",
  not_enabled: "notEnabled",
  key_unavailable: "keyUnavailable",
  // The code and the key differ here, as the keychain's do on the desktop.
  storage_failed: "storage",
  internal: "internal",
}

/** A sign-in's result: `ok` or a problem's code. */
export type SrnWebResult = string

export function isSrnWebResult(value: unknown): value is SrnWebResult {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(RESULT_PROBLEMS, value)
  )
}

/** What the popover says for a result: nothing for `ok` (the account says
 *  it), the problem otherwise — with no number, which a result never has. */
export function srnProblemOfResult(result: SrnWebResult): SrnProblem | null {
  const name = RESULT_PROBLEMS[result] ?? null
  return name === null
    ? null
    : { name, params: { code: result }, detail: null, fallback: result }
}

/**
 * The result this page's address carries, taken off the address (other
 * parameters and the hash kept) so nothing can read it twice. A value that is
 * not a result is dropped with the parameter.
 */
export function takeSrnResultFromAddress(): SrnWebResult | null {
  const value = takeQueryParamFromAddress(SRN_RESULT_PARAM)
  return isSrnWebResult(value) ? value : null
}

// ─── The result waiting to be shown ───────────────────────────────────

// Outside React: the status bar's entry is mounted again whenever the bar
// switches between its phone and desktop layouts, and a result read off the
// address must survive that until it has been shown.
let waiting: SrnWebResult | null = null
const listeners = new Set<() => void>()

function setWaiting(next: SrnWebResult | null): void {
  if (next === waiting) return
  waiting = next
  for (const listener of [...listeners]) listener()
}

/** Hold a result until the popover can show it; the newest wins. */
export function queueSrnResult(result: SrnWebResult): void {
  if (isSrnWebResult(result)) setWaiting(result)
}

export function waitingSrnResult(): SrnWebResult | null {
  return waiting
}

/** Take the waiting result: whoever gets it shows it, and nobody else can. */
export function takeWaitingSrnResult(): SrnWebResult | null {
  const result = waiting
  setWaiting(null)
  return result
}

export function subscribeWaitingSrnResult(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * As the workspace loads: whatever was kept for a login is over with (the
 * login page has put it back in the address, or the login never came), and
 * a result the address carries waits to be shown.
 */
export function claimSrnResultFromAddress(): void {
  forgetKeptForLogin(AFTER_LOGIN_KEY)
  const result = takeSrnResultFromAddress()
  if (result !== null) queueSrnResult(result)
}

// ─── Across the instance's login ──────────────────────────────────────

/** On the way to `/login`: keep a result not shown yet for after the login,
 *  or make sure no older one is left. */
export function keepSrnResultForLogin(): void {
  keepForLogin(AFTER_LOGIN_KEY, waiting === null ? null : { result: waiting })
}

/** The result kept for after the login, once; `null` for none, for a stale
 *  one, and for anything that is not a result. */
export function takeSrnResultAfterLogin(
  now: number = Date.now()
): SrnWebResult | null {
  const result = takeKeptForLogin(AFTER_LOGIN_KEY, now)?.result
  return isSrnWebResult(result) ? result : null
}

/** `path` (the workspace the login goes to) with the kept result back in
 *  its address, if there is one. */
export function withSrnResultAfterLogin(path: string): string {
  const result = takeSrnResultAfterLogin()
  if (result === null) return path
  return `${path}${path.includes("?") ? "&" : "?"}${SRN_RESULT_PARAM}=${result}`
}

/** Test-only: forget the waiting result. */
export function __resetSrnResultForTests(): void {
  waiting = null
  listeners.clear()
}
