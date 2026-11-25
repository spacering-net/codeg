// SPDX-License-Identifier: Apache-2.0
/**
 * Central secret-redaction boundary.
 *
 * Every error message, log line and Telegram-facing error string passes through
 * `redactText` (directly or via `redactError`). Two layers are applied:
 *
 *  1. Known values registered with `registerSecret` (bot token, Codeg web token,
 *     proxy password, …) are replaced verbatim, whatever shape they have.
 *  2. Credential-shaped patterns are masked even when the value was never
 *     registered, so a leaked log from another process cannot carry a token
 *     either. Method names, hosts, ports, status codes and codes are preserved
 *     so the message stays diagnostic.
 */

const REDACTED = "[REDACTED]"

/** @type {Set<string>} */
const knownSecrets = new Set()

const MIN_SECRET_LEN = 6

/**
 * Register a secret value that must never appear in output.
 * Too-short values are ignored so that masking cannot mangle ordinary text.
 */
export function registerSecret(value) {
  if (typeof value !== "string") return
  const trimmed = value.trim()
  if (trimmed.length < MIN_SECRET_LEN) return
  knownSecrets.add(trimmed)
}

/** Forget all registered secrets (tests, config reload). */
export function resetRedaction() {
  knownSecrets.clear()
}

export function listRegisteredSecretCount() {
  return knownSecrets.size
}

function maskKnownSecrets(input) {
  if (knownSecrets.size === 0) return input
  const ordered = [...knownSecrets].sort((a, b) => b.length - a.length)
  let out = input
  for (const secret of ordered) {
    if (!secret) continue
    if (out.includes(secret)) out = out.split(secret).join(REDACTED)
  }
  return out
}

/**
 * Mask credential shapes regardless of whether the value is known:
 * - Telegram Bot API paths `/bot<id>:<secret>/method`
 * - Codeg WS subprotocol `codeg-token.<b64url>`
 * - `Authorization: Bearer <token>` / `Bearer <token>`
 * - URL userinfo `scheme://user:password@host`
 * - `Proxy-Authorization: Basic <b64>`
 * - `?token=`, `?access_token=`, `?api_key=` query values
 */
function maskCredentialShapes(input) {
  let out = input
  out = out.replace(/(\/bot)[0-9]{3,}:[A-Za-z0-9_-]{5,}/g, `$1${REDACTED}`)
  out = out.replace(/(file\/bot)[0-9]{3,}:[A-Za-z0-9_-]{5,}/g, `$1${REDACTED}`)
  out = out.replace(/codeg-token\.[A-Za-z0-9_-]+/g, `codeg-token.${REDACTED}`)
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`)
  out = out.replace(
    /(Proxy-Authorization:\s*Basic\s+)[A-Za-z0-9+/=]{4,}/gi,
    `$1${REDACTED}`
  )
  out = out.replace(/\/\/[^\s/@:]+:[^\s/@]+@/g, `//${REDACTED}@`)
  out = out.replace(
    /([?&](?:token|access_token|api_key|apikey|secret|password)=)[^\s&#]+/gi,
    `$1${REDACTED}`
  )
  return out
}

/** Mask secrets in any string. Non-strings are stringified; null/undefined become ''. */
export function redactText(input) {
  if (input === null || input === undefined) return ""
  const s = typeof input === "string" ? input : String(input)
  if (!s) return s
  return maskCredentialShapes(maskKnownSecrets(s))
}

const ERROR_STRING_FIELDS = [
  "description",
  "stack",
  "apiMessage",
  "detail",
  "causeMessage",
]

/**
 * Sanitize an Error in place and return it.
 *
 * The original instance (and therefore its class, `code`, `statusCode` and any
 * `instanceof` checks) is preserved on purpose: classification helpers such as
 * `isConflictError` / `isThreadNotFoundError` must keep working.
 */
export function redactError(err) {
  if (!err || typeof err !== "object") return err
  try {
    if (typeof err.message === "string") {
      const next = redactText(err.message)
      if (next !== err.message) err.message = next
    }
    for (const field of ERROR_STRING_FIELDS) {
      if (typeof err[field] === "string") {
        const next = redactText(err[field])
        if (next !== err[field]) err[field] = next
      }
    }
  } catch {
    // Frozen/exotic errors: nothing more we can do without breaking the instance.
  }
  return err
}

/** Build a plain Error whose message is already redacted. */
export function redactedError(
  message,
  { name = "Error", code = undefined } = {}
) {
  const err = new Error(redactText(message))
  err.name = name
  if (code !== undefined) err.code = code
  return err
}

/** Redact a URL for logging: keeps scheme/host/port, drops userinfo. */
export function redactUrl(rawUrl) {
  if (!rawUrl) return ""
  try {
    const u = new URL(String(rawUrl))
    if (u.username || u.password) {
      u.username = REDACTED
      u.password = ""
    }
    return redactText(u.toString())
  } catch {
    return redactText(String(rawUrl))
  }
}
