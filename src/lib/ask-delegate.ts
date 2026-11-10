/**
 * What the assistant that dispatched a session answers there for the owner
 * (personal agent 7.3.1): its questions — except those asking for a secret —
 * and its plan approvals. A window holds back its notification of those
 * until the backend forwards one to the owner (`ask_forwarded`); everything
 * else (the executor's other permission requests) notifies as always.
 *
 * Pure, so it can be tested alone.
 */

import type { AskDelegate, PermissionOptionInfo, QuestionSpec } from "./types"

/** Whether a permission request is a plan approval: Claude Code's
 *  `ExitPlanMode` (its `exit-plan-*` options) or a Codex plan review (the
 *  `plan-review:<item>` call offering `implement_plan`). Mirrors the
 *  backend's `PlanPermission::of`. */
export function isPlanPermission(
  toolCall: unknown,
  options: readonly Pick<PermissionOptionInfo, "option_id">[] | null | undefined
): boolean {
  const opts = options ?? []
  if (opts.some((o) => o.option_id.startsWith("exit-plan-"))) return true
  if (opts.some((o) => o.option_id === "implement_plan")) return true
  const call =
    toolCall && typeof toolCall === "object"
      ? (toolCall as Record<string, unknown>)
      : null
  const id = call?.toolCallId ?? call?.tool_call_id
  return typeof id === "string" && id.startsWith("plan-review:")
}

/** Whether a question set goes to the dispatching assistant first: one that
 *  asks for a secret is the owner's. */
export function delegatesQuestion(
  delegate: AskDelegate | null | undefined,
  questions: readonly Pick<QuestionSpec, "is_secret">[]
): boolean {
  return !!delegate?.questions && !questions.some((q) => q.is_secret)
}

/** Whether an extension plan approval (Grok, Cursor) goes to the assistant. */
export function delegatesPlan(
  delegate: AskDelegate | null | undefined
): boolean {
  return !!delegate?.plans
}

/** Whether a permission request goes to the assistant: only a plan
 *  approval does. */
export function delegatesPermission(
  delegate: AskDelegate | null | undefined,
  toolCall: unknown,
  options: readonly Pick<PermissionOptionInfo, "option_id">[] | null | undefined
): boolean {
  return !!delegate?.plans && isPlanPermission(toolCall, options)
}
