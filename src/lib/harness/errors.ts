import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"

/**
 * Why a Harness command failed, as the Discover section tells it apart.
 *
 * All but two are the backend's own: it stamps each failure with a
 * `Harness.errors.<kind>` i18n key, and the kind is that key's last part.
 * The two that are not:
 *
 * - `unsupported` — the backend has no such command at all: an older Codeg at
 *   the other end of a remote workspace window, or behind a browser. Not a
 *   network failure, and not the catalog being switched off: the answer is to
 *   update that Codeg.
 * - `unknown` — anything else (the Codeg server itself out of reach, a
 *   transport timeout). Shown with whatever text the failure carried.
 */
export const HARNESS_FAILURE_KINDS = [
  "disabled",
  "network",
  "rateLimited",
  "notFound",
  "invalidRef",
  "server",
  "tooLarge",
  "invalidResponse",
  "recordUnreadable",
  "resolveUnavailable",
  "unsupported",
  "unknown",
] as const

export type HarnessFailureKind = (typeof HARNESS_FAILURE_KINDS)[number]

/** A failure in a form that can be kept in a slot and shown later: plain
 *  data, no `Error` object. */
export interface HarnessFailure {
  kind: HarnessFailureKind
  /** `rateLimited`: how long the catalog asked to be left alone. */
  seconds?: number
  /** `server`: the HTTP status it answered with. */
  status?: string
  /** `unknown`: the failure's own text, untranslated; `recordUnreadable`:
   *  why the record could not be read, as the backend put it. Empty
   *  otherwise. */
  detail: string
}

const KEY_PREFIX = "Harness.errors."

/** The kinds the backend names, i.e. every kind but the two made up here. */
const BACKEND_KINDS: ReadonlySet<string> = new Set(
  HARNESS_FAILURE_KINDS.filter(
    (kind) => kind !== "unsupported" && kind !== "unknown"
  )
)

/** What a 429 without a usable `Retry-After` is taken to mean — the default
 *  the backend applies too. */
const DEFAULT_RETRY_SECONDS = 60

/**
 * A failure raised on this side of the transport: an address that cannot be
 * one, an answer that is not the shape a command promises. Carries its kind so
 * that it is told apart the same way a backend failure is.
 */
export class HarnessClientError extends Error {
  readonly kind: HarnessFailureKind

  constructor(kind: HarnessFailureKind, message: string) {
    super(message)
    this.name = "HarnessClientError"
    this.kind = kind
  }
}

/** The failure's own words: a rejected Tauri `invoke` is a bare string, a
 *  transport's failure an object with a `message`. */
function messageOf(error: unknown): string {
  if (typeof error === "string") return error.trim()
  if (error === null || typeof error !== "object") return ""
  const { message } = error as { message?: unknown }
  return typeof message === "string" ? message.trim() : ""
}

/**
 * Whether `error` is a backend saying it has no such command.
 *
 * Each transport says it its own way, and none of them with an i18n key — the
 * backend that would have to stamp one is the backend that predates it:
 *
 * - a browser: codeg-server answers any unknown `/api/<command>` with 501 and
 *   `{ code: "not_implemented" }`, which the web transport throws as it is;
 * - a remote workspace window: the desktop's proxy cannot read that body as an
 *   `AppCommandError` (the code is not one of its own), so it reports
 *   `network_error` with the message "Remote returned HTTP 501 …";
 * - the desktop app itself: Tauri rejects with "Command <name> not found".
 *   Its frontend and backend ship together, so this is a development build
 *   caught between two steps rather than something a user meets.
 *
 * Deliberately narrow. A catalog that answers 501 is the backend's
 * `Harness.errors.server`, which {@link harnessFailureOf} reads before it
 * asks this.
 */
export function isUnsupportedCommandError(error: unknown): boolean {
  const message = messageOf(error)
  if (/^Command \S+ not found$/.test(message)) return true
  if (error === null || typeof error !== "object") return false
  const { code } = error as { code?: unknown }
  if (code === "not_implemented") return true
  return code === "network_error" && /^Remote returned HTTP 501\b/.test(message)
}

function secondsOf(value: string | undefined): number {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0
    ? Math.ceil(seconds)
    : DEFAULT_RETRY_SECONDS
}

/** Sorts a rejected Harness command into a {@link HarnessFailure}. Never
 *  throws, whatever it is handed. */
export function harnessFailureOf(error: unknown): HarnessFailure {
  if (error instanceof HarnessClientError) {
    return { kind: error.kind, detail: "" }
  }
  // The backend's own account first: a failure it stamped is from a backend
  // that has the command, whatever its text happens to say.
  const appError = extractAppCommandError(error)
  const key = appError?.i18n_key
  if (key?.startsWith(KEY_PREFIX)) {
    const kind = key.slice(KEY_PREFIX.length)
    const params = appError?.i18n_params ?? {}
    if (kind === "rateLimited") {
      return { kind, seconds: secondsOf(params.seconds), detail: "" }
    }
    if (kind === "server") {
      return { kind, status: params.status ?? "", detail: "" }
    }
    if (kind === "recordUnreadable") {
      return { kind, detail: appError?.detail?.trim() ?? "" }
    }
    if (BACKEND_KINDS.has(kind)) {
      return { kind: kind as HarnessFailureKind, detail: "" }
    }
    // A kind a newer backend added: its English text is the best there is.
    return { kind: "unknown", detail: toErrorMessage(error) }
  }
  if (isUnsupportedCommandError(error)) {
    return { kind: "unsupported", detail: "" }
  }
  return { kind: "unknown", detail: toErrorMessage(error) }
}

/** Whether asking again can change the answer. An address that is malformed,
 *  or names nothing, will be just as wrong the second time; so will a backend
 *  that lacks the command, or has the catalog switched off. */
export function isRetryableFailure(failure: HarnessFailure): boolean {
  return (
    failure.kind !== "notFound" &&
    failure.kind !== "invalidRef" &&
    failure.kind !== "unsupported" &&
    failure.kind !== "disabled"
  )
}
