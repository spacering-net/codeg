"use client"

/**
 * Inline card for the codeg-mcp delegation companion tools
 * `get_delegation_status` and `cancel_delegation`.
 *
 * A single collapsed line framed around the user's actual intent — "waiting for
 * task <id>'s result" (status) / "canceling task <id>" (cancel) — followed by
 * the task's execution time and a status badge, expandable to reveal the
 * result. Parsing + status resolution live in `@/lib/delegation-status` so this
 * card and the merged `DelegationStatusGroupCard` stay in lockstep.
 *
 * After the adapter collapses consecutive `get_delegation_status` polls into a
 * `delegation-status-group`, this card renders the `cancel` tool and serves as
 * a defensive fallback for a stray ungrouped status poll. The row itself
 * (`DelegationStatusRow`) is shared with the group card.
 */

import { useMemo } from "react"

import { cn } from "@/lib/utils"
import {
  deriveBadge,
  parseStatusReport,
  parseTaskId,
} from "@/lib/delegation-status"
import type {
  AdaptedToolCallPart,
  ToolCallState,
} from "@/lib/adapters/ai-elements-adapter"
import { DelegationStatusRow } from "@/components/message/delegation-status-row"
import { DelegationStatusGroupCard } from "@/components/message/delegation-status-group-card"

interface Props {
  /** Which companion tool this card represents — selects the label + icon. */
  kind: "status" | "cancel"
  /** Raw JSON arguments sent to the tool — status: `{ task_ids, wait_ms? }` (or
   *  a legacy `{ task_id }` in historical transcripts); cancel: `{ task_id }`. */
  input?: string | null
  output?: string | null
  errorText?: string | null
  state?: ToolCallState
  /** The call's id. A stray status poll keeps it as its one poll's id, which
   *  is how the transcript's index tells this row from the task's other ones
   *  (`@/lib/delegation-status-index`). */
  toolCallId?: string | null
}

export function DelegationStatusCard({
  kind,
  input,
  output,
  errorText,
  state,
  toolCallId,
}: Props) {
  // Status: reuse the batch-aware `DelegationStatusGroupCard` (the real render
  // path groups status polls into it upstream) so a stray ungrouped poll —
  // single OR batch (`task_ids`) — renders identically. Wrapped as a stable
  // one-poll array so the group card's memo holds across rerenders. The card's
  // own `delegation-status-card` test id is preserved via `testId`.
  const statusPolls = useMemo<AdaptedToolCallPart[]>(
    () => [
      {
        type: "tool-call",
        toolCallId: toolCallId ?? "status",
        toolName: "get_delegation_status",
        input: input ?? null,
        state: state ?? "output-available",
        output: output ?? null,
        errorText: errorText ?? undefined,
      },
    ],
    [toolCallId, input, output, errorText, state]
  )

  // Cancel: always a single task — keep the single-report path.
  const cancelReport = useMemo(
    () => parseStatusReport(output, errorText),
    [output, errorText]
  )
  const cancelTaskId = useMemo(
    () => parseTaskId(input) ?? cancelReport.taskId,
    [input, cancelReport]
  )
  const cancelBadge = useMemo(
    () => deriveBadge("cancel", cancelReport, state, !!errorText),
    [cancelReport, state, errorText]
  )

  if (kind === "status") {
    return (
      <DelegationStatusGroupCard
        polls={statusPolls}
        testId="delegation-status-card"
      />
    )
  }

  const isError = cancelBadge.status === "err"
  return (
    <div
      data-testid="delegation-status-card"
      className={cn(
        "overflow-hidden rounded-lg border text-xs ws-msg-card",
        isError
          ? "border-destructive/30 bg-destructive/5"
          : "border-border bg-card"
      )}
    >
      <DelegationStatusRow
        kind="cancel"
        taskId={cancelTaskId}
        report={cancelReport}
        badge={cancelBadge}
      />
    </div>
  )
}
