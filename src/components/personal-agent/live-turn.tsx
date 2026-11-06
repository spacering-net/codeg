"use client"

/**
 * The personal agent's live connection, as its page uses it: attached
 * read-only (`attachDelegationChild`, an identity parent mapping, as the task
 * transcript viewer does — the page never spawns or disconnects it), for the
 * prompts the agent may be parked on: a permission request, a question, a
 * plan approval. They are answered through the personal agent's own
 * commands, so its timeline records the answers.
 *
 * The reply itself is not read from here: the engine builds it from the same
 * events and pushes the step it is on (`replyView`).
 */

import { useEffect } from "react"
import { toast } from "sonner"

import { AskQuestionCard } from "@/components/chat/ask-question-card"
import { PermissionDialog } from "@/components/chat/permission-dialog"
import { PlanApprovalCard } from "@/components/chat/plan-approval-card"
import { useConnectionStateById } from "@/components/message/live-transcript-view"
import { useAcpActions } from "@/contexts/acp-connections-context"
import {
  personalAgentAnswerPlan,
  personalAgentAnswerQuestion,
  personalAgentRespondPermission,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { AgentType } from "@/lib/types"

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

/** The prompt the agent is parked on, answered through the personal agent so
 *  the timeline keeps the answer. */
export function BlockingPrompts({
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
