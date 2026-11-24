/**
 * Small, dependency-light lifecycle predicates for an adapted tool-call part,
 * shared by the generic empty-call filter (`dropEmptyInFlightToolCalls`) and the
 * specialized lane row-builders (`buildDelegationTaskRows`,
 * `buildBackgroundTaskRows`). Kept in its own module — with a TYPE-ONLY import
 * of `AdaptedToolCallPart` (erased at runtime) — so `background-task.ts` can use
 * it without forming a runtime import cycle with the adapter (the adapter
 * imports `background-task.ts`).
 */

import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"

/**
 * Whether a forwarded ACP tool status is present and not yet terminal. Absent
 * status (`undefined`/`null`, as on DB-persisted rows) counts as settled, so
 * historical tool calls are never treated as still-in-flight.
 */
export function toolStatusUnsettled(
  status: string | null | undefined
): boolean {
  if (status == null) return false
  const s = status.trim().toLowerCase()
  return s !== "completed" && s !== "failed"
}

/** Whether a forwarded ACP tool status is present and terminal — what a
 *  report closing its tool call carries. */
export function toolStatusTerminal(status: string | null | undefined): boolean {
  return status != null && !toolStatusUnsettled(status)
}

/**
 * A tool-call part that has NOT reached a terminal outcome: either its adapted
 * lifecycle state is still running, or its forwarded ACP status is unsettled.
 *
 * The status arm is what catches an interrupted arg-less orphan promoted into
 * `localTurns` at `COMPLETE_TURN`: the promotion re-adapts it with
 * `isStreaming=false`, flipping its state to `output-available`, but it never
 * actually completed — its forwarded status stays `pending`/`in_progress` until
 * an authoritative detail reload. Without this arm, the orphan re-inflates the
 * "运行 N 个命令" count and the delegation/background poll rows after a turn
 * completes. DB-persisted rows carry no forwarded status, so they are exempt.
 */
export function isUnsettledToolCall(part: AdaptedToolCallPart): boolean {
  return (
    part.state === "input-available" ||
    part.state === "input-streaming" ||
    toolStatusUnsettled(part.toolStatus)
  )
}
