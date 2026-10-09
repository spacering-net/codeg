"use client"

/**
 * Inline header for a delegated child sub-session under the parent's
 * `delegate_to_agent` ToolCallBlock. Renders as a self-contained card —
 * never falls through the generic tool-call shell — so users see "Agent
 * delegating: task" instead of "mcp__codeg-delegate__delegate_to_agent: codex".
 *
 * The card is intentionally a status + navigation affordance ONLY: it does not
 * render the child's output inline and does not expand. The child's result is
 * delivered to the LLM via `get_delegation_status` and to the user by opening
 * the child session ("查看会话" → SubAgentSessionDialog, which also hosts the
 * child's permission prompts). When the child is awaiting a permission decision
 * the status badge reflects it, cueing the user to open the session.
 *
 * All agent-type / task / status / child-id resolution lives in
 * `useDelegationCardModel` (shared with the top-right `SubAgentOverlay`), so the
 * card and the overlay never disagree about a sub-agent; the row itself is
 * `DelegationCardRow`, shared with `ResumedDelegationCard`.
 */

import { useState } from "react"

import type { ToolCallState } from "@/lib/adapters/ai-elements-adapter"
import { DelegationCardRow } from "@/components/message/delegation-card-row"
import { SubAgentSessionDialog } from "@/components/message/sub-agent-session-dialog"
import { useSessionViewerHost } from "@/components/message/session-viewer-host"
import { useDelegationCardModel } from "@/hooks/use-delegation-card-model"

interface Props {
  parentToolUseId: string
  /** Raw JSON arguments the LLM sent to `delegate_to_agent`. Used to
   *  surface the task and agent_type before the broker's
   *  DelegationStarted event lands (or when binding never arrives — e.g.
   *  the wider session was reloaded with an inline child still around). */
  input?: string | null
  output?: string | null
  errorText?: string | null
  state?: ToolCallState
  /**
   * ACP extensibility metadata on this tool call. Read as a tertiary
   * fallback after the live `DelegationContext` binding when the parent UI
   * re-mounted on a page refresh and the live `delegation_started` event was
   * already consumed (lost): the snapshot's
   * `ToolCallState.meta["codeg.delegation"]` carries enough to re-bind the
   * card to the child conversation.
   */
  meta?: Record<string, unknown> | null
}

export function DelegatedSubThread({
  parentToolUseId,
  input,
  output,
  errorText,
  state,
  meta,
}: Props) {
  // Preferred: hand the viewer to the transcript-level host, which outlives
  // this card's virtual row. `null` means this card is rendering outside a
  // `MessageListView` (and so outside any virtualizer) — then it owns the
  // drawer itself, as it always did.
  const viewerHost = useSessionViewerHost()
  const [dialogOpen, setDialogOpen] = useState(false)
  const source = {
    parentToolUseId,
    input,
    output,
    errorText,
    state,
    meta,
  }
  const {
    agentType,
    task,
    taskId,
    status,
    errorCode,
    childConversationId,
    childConnectionId,
    model,
    hasModel,
  } = useDelegationCardModel(source)

  // A snapshot replay with an empty/unparseable input AND no live binding has
  // no useful card to draw — fall through to the standard renderer instead of
  // an "unknown sub-agent" stub. Placed AFTER all hooks so hook order is stable.
  if (!hasModel) {
    return null
  }

  return (
    <div
      data-testid="delegated-sub-thread"
      className="@container/delegcard rounded-lg border border-border bg-card ws-msg-card"
    >
      <DelegationCardRow
        agentType={agentType}
        taskId={taskId}
        pinnedModel={model}
        status={status}
        errorCode={errorCode}
        task={task}
        onOpenSession={
          childConversationId != null
            ? () =>
                viewerHost
                  ? viewerHost.open({ kind: "delegation", source })
                  : setDialogOpen(true)
            : undefined
        }
      />
      {viewerHost == null && childConversationId != null && (
        <SubAgentSessionDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          childConversationId={childConversationId}
          childConnectionId={childConnectionId}
          agentType={agentType}
          kickoffTask={task}
        />
      )}
    </div>
  )
}
