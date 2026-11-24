/**
 * One status vocabulary for every activity step, after Zed's seven tool-call
 * states. Visually `pending` draws like `running` and `rejected` like `failed`
 * (with its own wording); `cancelled` is the "interrupted" state.
 */

import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"
import { isUnsettledToolCall } from "@/lib/tool-call-lifecycle"

export type StepStatus =
  | "pending"
  | "running"
  | "awaiting"
  | "succeeded"
  | "failed"
  | "rejected"
  | "cancelled"

/**
 * Claude Code's result for a call the user declined in the permission prompt,
 * and the generic "rejected/denied by user" wording other adapters use.
 */
const REJECTED_RE =
  /^The user doesn't want to proceed with this tool use|\b(?:rejected|denied|declined) by (?:the )?user\b/i
/** Claude Code's result for a call the user stopped mid-flight. */
const INTERRUPTED_RE = /^\[Request interrupted by user/i

export function isLiveStatus(status: StepStatus): boolean {
  return status === "pending" || status === "running"
}

export function isFailureStatus(status: StepStatus): boolean {
  return status === "failed" || status === "rejected"
}

/**
 * The status of one tool call. Liveness comes only from the adapter's own
 * lifecycle predicate (`isUnsettledToolCall`), so a call the adapter still
 * treats as in flight is never painted finished here — the same rule every
 * other surface follows.
 */
export function toolCallStatus(
  part: AdaptedToolCallPart,
  opts?: { awaiting?: boolean }
): StepStatus {
  if (opts?.awaiting) return "awaiting"
  const errorText = part.errorText?.trim()
  if (part.state === "output-error" || errorText) {
    const text = (errorText || part.output || "").trim()
    if (INTERRUPTED_RE.test(text)) return "cancelled"
    if (REJECTED_RE.test(text)) return "rejected"
    return "failed"
  }
  if (isUnsettledToolCall(part)) {
    return part.state === "input-streaming" ? "pending" : "running"
  }
  return "succeeded"
}

/** Fold member statuses into one for a group row: anything live wins, then
 *  anything waiting on the user, then a failure. */
export function combineStatuses(statuses: StepStatus[]): StepStatus {
  if (statuses.some(isLiveStatus)) return "running"
  if (statuses.includes("awaiting")) return "awaiting"
  if (statuses.some(isFailureStatus)) return "failed"
  if (statuses.length > 0 && statuses.every((s) => s === "cancelled")) {
    return "cancelled"
  }
  return "succeeded"
}
