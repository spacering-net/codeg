"use client"

/**
 * The personal agent's turn while it runs: its streaming reply and tool
 * activity, drawn by the conversation's own turn renderer, and the blocking
 * prompts it may be parked on (permission request, question, plan approval),
 * answered through the personal agent's own commands so the timeline records
 * them in full. Only shown while a turn is in flight — the timeline keeps the
 * reply text once it ends.
 *
 * The connection is the engine's, not this page's: the page attaches to it
 * read-only (`attachDelegationChild`, an identity parent mapping, as the task
 * transcript viewer does) and never spawns or disconnects it.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { AskQuestionCard } from "@/components/chat/ask-question-card"
import { PermissionDialog } from "@/components/chat/permission-dialog"
import { PlanApprovalCard } from "@/components/chat/plan-approval-card"
import { Message, MessageContent } from "@/components/ai-elements/message"
import { ActivityLiveProvider } from "@/components/message/activity/activity-live-context"
import { CompletedTurnContent } from "@/components/message/completed-turn-content"
import { useConnectionStateById } from "@/components/message/live-transcript-view"
import {
  extractPermissionToolCallId,
  useAcpActions,
} from "@/contexts/acp-connections-context"
import { adaptMessageTurn } from "@/lib/adapters/ai-elements-adapter"
import {
  personalAgentAnswerPlan,
  personalAgentAnswerQuestion,
  personalAgentRespondPermission,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { usePageHandoffName } from "@/lib/browser/use-page-handoff-name"
import type { AgentType } from "@/lib/types"
import { buildStreamingTurnsFromLiveMessage } from "@/stores/conversation-runtime-store"
import { toast } from "sonner"

/** Attach the page to the personal agent's live connection while it exists. */
export function usePersonalAgentAttachment(
  connectionId: string | null,
  agentType: AgentType | null
) {
  const { attachDelegationChild, detachDelegationChild } = useAcpActions()
  useEffect(() => {
    if (!connectionId || !agentType) return
    attachDelegationChild({
      connectionId,
      parentConnectionId: connectionId,
      parentToolUseId: `personal-agent-${connectionId}`,
      agentType,
      // The page opens onto whatever the session is doing now.
      hydrate: true,
    })
    return () => detachDelegationChild(connectionId)
  }, [connectionId, agentType, attachDelegationChild, detachDelegationChild])
}

interface LiveTurnProps {
  connectionId: string
  conversationId: number | null
  agentType: AgentType
}

/** The streaming reply of the turn in flight. */
export function LiveTurn({
  connectionId,
  conversationId,
  agentType,
}: LiveTurnProps) {
  const sharedT = useTranslations("Folder.chat.shared")
  const pageHandoffName = usePageHandoffName()
  const conn = useConnectionStateById(connectionId)
  const [roundOpen, setRoundOpen] = useState(true)
  const adapterText = useMemo(
    () => ({
      attachedResources: sharedT("attachedResources"),
      toolCallFailed: sharedT("toolCallFailed"),
      pageHandoffName,
    }),
    [sharedT, pageHandoffName]
  )
  const liveMessage = conn?.liveMessage ?? null
  const parts = useMemo(() => {
    if (!liveMessage) return []
    const built = buildStreamingTurnsFromLiveMessage(
      conversationId ?? -1,
      liveMessage
    )
    return (
      built.turns
        // The owner's own words are on the timeline already.
        .filter((turn) => turn.role === "assistant")
        .flatMap(
          (turn) =>
            adaptMessageTurn(
              turn,
              adapterText,
              true,
              built.inProgressToolCallIds
            ).content
        )
    )
  }, [liveMessage, conversationId, adapterText])
  const awaitingUser =
    conn?.pendingPermission != null ||
    conn?.pendingAskQuestion != null ||
    conn?.pendingPlanApproval != null
  const pendingPermission = conn?.pendingPermission ?? null
  const toolApprovals = conn?.toolApprovals
  const live = useMemo(
    () => ({
      awaitingToolCallId: pendingPermission
        ? extractPermissionToolCallId(pendingPermission)
        : null,
      awaitingUser,
      approvals: toolApprovals ?? {},
    }),
    [pendingPermission, awaitingUser, toolApprovals]
  )

  return (
    <div className="flex flex-col gap-3">
      <ActivityLiveProvider value={live}>
        <Message from="assistant">
          <MessageContent>
            <CompletedTurnContent
              parts={parts}
              completed={false}
              currentRound
              roundOpen={roundOpen}
              onRoundOpenChange={setRoundOpen}
              pending={parts.length === 0}
            />
          </MessageContent>
        </Message>
      </ActivityLiveProvider>
      <BlockingPrompts connectionId={connectionId} agentType={agentType} />
    </div>
  )
}

/** The prompt the agent is parked on, answered through the personal agent so
 *  the timeline keeps the answer. */
function BlockingPrompts({
  connectionId,
  agentType,
}: {
  connectionId: string
  agentType: AgentType
}) {
  const conn = useConnectionStateById(connectionId)
  if (!conn) return null
  const fail = (error: unknown) => toast.error(toErrorMessage(error))
  return (
    <>
      {conn.pendingPermission ? (
        <PermissionDialog
          permission={conn.pendingPermission}
          agentType={agentType}
          onRespond={(requestId, optionId) => {
            personalAgentRespondPermission(requestId, optionId).catch(fail)
          }}
        />
      ) : null}
      {conn.pendingAskQuestion ? (
        <AskQuestionCard
          question={conn.pendingAskQuestion}
          onAnswer={(questionId, answer) =>
            personalAgentAnswerQuestion(questionId, answer)
          }
        />
      ) : null}
      {conn.pendingPlanApproval ? (
        <PlanApprovalCard
          approval={conn.pendingPlanApproval}
          onAnswer={(approvalId, answer) =>
            personalAgentAnswerPlan(approvalId, answer)
          }
        />
      ) : null}
    </>
  )
}
