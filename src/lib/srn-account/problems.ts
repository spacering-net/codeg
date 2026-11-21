import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"

/**
 * Every problem the SRN account names: the last part of its
 * `SrnAccount.errors.<name>` i18n key. A wire contract with
 * `src-tauri/src/srn/error.rs` (both runtimes) and `srn/web/types.rs` (Codeg
 * Web's own); each has words in every language.
 */
export const SRN_PROBLEMS = [
  "network",
  "rateLimited",
  "server",
  "invalidResponse",
  "clientRejected",
  "exchangeFailed",
  "accessDenied",
  "expired",
  "accountChanged",
  "keychainRead",
  "keychainWrite",
  "keychainDelete",
  "keychainCleanup",
  "credentialInvalid",
  "revoked",
  "signedOutLocally",
  "alreadySignedIn",
  "noPendingSignIn",
  "openBrowser",
  "loopback",
  "internal",
  // Codeg Web's own (`w2-api.md` §5).
  "notEnabled",
  "originRefused",
  "invalidRequest",
  "flowMissing",
  "invalidCallback",
  "sessionUnreadable",
  "keyUnavailable",
  "storage",
] as const

export type SrnProblemName = (typeof SRN_PROBLEMS)[number]

const KEY_PREFIX = "SrnAccount.errors."
const NAMES: ReadonlySet<string> = new Set(SRN_PROBLEMS)

/** The stable `code` param of each problem, back to its name: how a
 *  `signedOutLocally`'s `reason` is told. */
const NAME_OF_CODE: Readonly<Record<string, SrnProblemName>> = {
  network: "network",
  rate_limited: "rateLimited",
  server: "server",
  invalid_response: "invalidResponse",
  client_rejected: "clientRejected",
  exchange_failed: "exchangeFailed",
  access_denied: "accessDenied",
  expired: "expired",
  account_changed: "accountChanged",
  keychain_read_failed: "keychainRead",
  keychain_write_failed: "keychainWrite",
  keychain_delete_failed: "keychainDelete",
  keychain_cleanup_failed: "keychainCleanup",
  credential_invalid: "credentialInvalid",
  revoked: "revoked",
  signed_out_locally: "signedOutLocally",
  already_signed_in: "alreadySignedIn",
  no_pending_sign_in: "noPendingSignIn",
  open_browser_failed: "openBrowser",
  loopback_failed: "loopback",
  internal: "internal",
  not_enabled: "notEnabled",
  origin_refused: "originRefused",
  invalid_request: "invalidRequest",
  flow_missing: "flowMissing",
  invalid_callback: "invalidCallback",
  session_unreadable: "sessionUnreadable",
  key_unavailable: "keyUnavailable",
  storage_failed: "storage",
}

/** A failure, in a form the popover can keep and say. */
export interface SrnProblem {
  /** `null`: not one the account names (a transport failure, a command an
   *  older backend lacks) — `fallback` is all there is to say then. */
  name: SrnProblemName | null
  /** The message's params, as the backend sent them (`seconds`, `status`,
   *  `url`, `reason`). */
  params: Record<string, string>
  /** The platform's or transport's own words, for a "details" disclosure. */
  detail: string | null
  /** The failure's English text. */
  fallback: string
}

/** Sorts any failure — a state's `problem` or a command's rejection. Never
 *  throws. */
export function srnProblemOf(error: unknown): SrnProblem {
  const appError = extractAppCommandError(error)
  const key = appError?.i18n_key
  const name =
    key?.startsWith(KEY_PREFIX) && NAMES.has(key.slice(KEY_PREFIX.length))
      ? (key.slice(KEY_PREFIX.length) as SrnProblemName)
      : null
  const detail = appError?.detail?.trim() || null
  return {
    name,
    params: appError?.i18n_params ?? {},
    // Named problems are said in words; the detail is the evidence.
    detail: name ? detail : null,
    fallback: appError
      ? appError.detail?.trim() || appError.message
      : toErrorMessage(error),
  }
}

/** Why SpaceRing did not confirm a sign-out (`signedOutLocally`'s
 *  `reason`), as a problem of its own, or `null` if it names none. */
export function srnReasonOf(problem: SrnProblem): SrnProblemName | null {
  const reason = problem.params.reason
  return reason ? (NAME_OF_CODE[reason] ?? null) : null
}

/** The stable code of a state's `problem`, or `null`. */
export function srnProblemCode(error: unknown): string | null {
  return extractAppCommandError(error)?.i18n_params?.code ?? null
}

/**
 * Codeg Web: the instance itself refused the request (401) — no token, a
 * wrong one, a proxy's expired session. Not the account's to say: the
 * transport's unauthorized dialog has been raised, and the popover says
 * nothing of its own.
 */
export class SrnInstanceUnauthorized extends Error {
  constructor() {
    super("Unauthorized")
    this.name = "SrnInstanceUnauthorized"
  }
}
