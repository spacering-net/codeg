/**
 * What an ACP `error` event is, keyed on its stable `code` — which decides
 * what it leaves behind besides its notification.
 *
 * The backend raises one `error` event for very different things: a turn that
 * failed, an agent process that died, a mode switch the agent refused, an image
 * Grok dropped. Every one the user should hear about is a notification (a toast,
 * recorded in the status-bar alert list — see `lib/notify`); none is a strip
 * under the composer, which is kept for what is still in progress. They differ
 * in what else happens:
 *
 * - `session` — this session's state went wrong (the turn, the connection, the
 *   restore). It also becomes the session's current error (`conn.error`, read
 *   by the connection-status popover) until the next prompt, and an
 *   `error`-level one raises an OS notification for a user who is away.
 * - `action` — the answer to something the user just did (switch mode, pick a
 *   model or option, pause a goal, attach an image). The notification is all:
 *   no session state, no OS notification — the user is looking already.
 * - `transcript` — already shown by a card in the transcript; nothing at all.
 *   The backend still raises the `error` for readers that only see the event
 *   stream (chat-channel bridges, the pet), not for the app.
 *
 * Unknown and absent codes take the conservative default, a `session` error, so
 * a failure the table does not know about is never demoted.
 */

export type AcpErrorKind = "session" | "action" | "transcript"
export type AcpErrorLevel = "error" | "warning"

export interface AcpErrorRoute {
  kind: AcpErrorKind
  level: AcpErrorLevel
  /**
   * The localized text for this code does NOT include the backend's raw
   * message, so the raw message rides along as the notification's second line
   * instead of being lost.
   */
  rawAsDetail: boolean
}

const DEFAULT_ROUTE: AcpErrorRoute = {
  kind: "session",
  level: "error",
  rawAsDetail: false,
}

const ROUTES: Readonly<Record<string, AcpErrorRoute>> = {
  // The session could not be restored and the agent started a new one. It is
  // the session's state from here on — the agent no longer has the earlier
  // context — but not a failure of anything the user can retry: amber, and no
  // OS notification.
  session_load_fallback: {
    kind: "session",
    level: "warning",
    rawAsDetail: true,
  },
  // Verdicts on a selector the user just changed. The selector itself snaps
  // back (or keeps the agent's value), so the notification only says why.
  set_mode_failed: { kind: "action", level: "error", rawAsDetail: true },
  set_config_option_failed: {
    kind: "action",
    level: "error",
    rawAsDetail: true,
  },
  grok_model_switch_incompatible_agent: {
    kind: "action",
    level: "warning",
    rawAsDetail: false,
  },
  goal_control_failed: { kind: "action", level: "error", rawAsDetail: true },
  // Grok dropped an attached image before sending the prompt. The turn still
  // runs; the user needs to know the model never saw that image.
  image_dropped: { kind: "action", level: "warning", rawAsDetail: true },
  // A grok compaction that failed: the transcript's compaction card shows it
  // in its failed state, with the reason.
  compaction_failed: {
    kind: "transcript",
    level: "warning",
    rawAsDetail: false,
  },
}

export function routeAcpError(code: string | null | undefined): AcpErrorRoute {
  return (code && ROUTES[code]) || DEFAULT_ROUTE
}

/** OS notifications are for a session that broke while the user was away —
 *  not for warnings, and not for the answer to a click. */
export function acpErrorNotifiesDesktop(route: AcpErrorRoute): boolean {
  return route.kind === "session" && route.level === "error"
}

/**
 * codeg's verdict on a turn that ended badly (`turn_failed_refusal`,
 * `turn_failed_empty`, …). Raised at the turn's end, so it is the SAME failure
 * as any typed account the adapter published during that turn (claude's and
 * codex's AIR terminal records) — the two are told as one notification.
 */
export function isTurnFailureCode(code: string | null | undefined): boolean {
  return typeof code === "string" && code.startsWith("turn_failed_")
}
