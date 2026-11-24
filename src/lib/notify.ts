/**
 * An agent session's warning or error: shown once, and kept.
 *
 * The toast is the notification — it takes the user's attention and leaves on
 * its own. The status-bar alert list is its record, so a toast that left before
 * it was read can be read again there. A notified message is never also drawn
 * as a strip under the composer: that dock is kept for what is still in
 * progress (a retry, a reconnect), which updates in place and clears itself.
 *
 * `key` names the MESSAGE, not the call. Telling the same thing again — a
 * notice the agent repeats, the typed account of a failure codeg already
 * reported — updates the toast on screen and replaces the list entry instead
 * of stacking copies.
 *
 * Info-level messages are toast-only: the list is for things that went wrong
 * or need attention ("Alerts"), and an FYI has nothing to come back to.
 */

import { toast } from "sonner"

import { recordAlert, type AlertAction } from "@/contexts/alert-context"

export type NotifyLevel = "error" | "warning" | "info"

export interface NotifyAction {
  label: string
  onClick: () => void
  /** Toast only: the button acts on the moment (re-send the prompt that just
   *  failed), and in the list it would outlive the moment it acts on. */
  toastOnly?: boolean
}

export interface NotifyInput {
  level: NotifyLevel
  /** The message's identity — see the module doc. */
  key: string
  title: string
  /** Supporting prose: the toast's second line and the entry's detail. */
  description?: string | null
  /** Machine output (an agent's stderr tail): list entry only, behind its
   *  disclosure — a toast is a glance, not a log viewer. */
  evidence?: string | null
  /** The toast's primary and secondary buttons, in order. A toast holds two:
   *  when more are given, the toast-only ones take its slots first, since
   *  every other action is kept in the list anyway. */
  actions?: NotifyAction[]
  /** Update the list entry without raising the toast again — for a follow-up
   *  that adds nothing worth interrupting for (the evidence behind a failure
   *  that is already on screen). */
  bellOnly?: boolean
}

/** Upstream text can be a multi-line error body; keep its line breaks, but
 *  only as many lines as a toast can hold. */
const DESCRIPTION_CLASS = "line-clamp-6 whitespace-pre-line break-words"

export function notify(input: NotifyInput): void {
  const description = input.description?.trim() || undefined
  const evidence = input.evidence?.trim() || undefined
  const actions = input.actions ?? []

  if (!input.bellOnly) {
    const show =
      input.level === "error"
        ? toast.error
        : input.level === "warning"
          ? toast.warning
          : toast.info
    const [primary, secondary] =
      actions.length <= 2
        ? actions
        : [
            ...actions.filter((action) => action.toastOnly),
            ...actions.filter((action) => !action.toastOnly),
          ]
    // Every field is set, present or not: raising a toast whose key is still
    // on screen UPDATES it, and sonner merges the update into the old props —
    // an omitted button or line would survive from the previous message.
    show(input.title, {
      id: input.key,
      description,
      classNames: description ? { description: DESCRIPTION_CLASS } : undefined,
      action: primary
        ? { label: primary.label, onClick: primary.onClick }
        : undefined,
      cancel: secondary
        ? { label: secondary.label, onClick: secondary.onClick }
        : undefined,
    })
  }

  if (input.level === "info") return
  const alertActions: AlertAction[] = actions
    .filter((action) => !action.toastOnly)
    .map((action) => ({ label: action.label, run: action.onClick }))
  recordAlert({
    key: input.key,
    level: input.level,
    message: input.title,
    ...(description ? { detail: description } : {}),
    ...(evidence ? { evidence } : {}),
    ...(alertActions.length > 0 ? { actions: alertActions } : {}),
  })
}

/** Take a notification's toast off the screen (its list entry stays) — for a
 *  toast that stopped being true: the failure it reports is over, or its
 *  buttons would act on a moment that has passed. */
export function dismissNotification(key: string): void {
  toast.dismiss(key)
}
