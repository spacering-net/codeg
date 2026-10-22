"use client"

/**
 * A connection's blocking prompts — permission request, codeg-mcp
 * `ask_user_question`, plan approval — answered through THAT connection's id.
 *
 * For answering a session from outside its own conversation panel: the
 * read-only transcript viewers (`LiveTranscriptView`) and the
 * `get_delegation_status` row, both of which reach a delegated sub-agent.
 * The panel that owns a connection mounts the same three cards itself
 * (`ConversationShell`), wired to its own handlers.
 */

import { memo, useCallback } from "react"

import { AskQuestionCard } from "@/components/chat/ask-question-card"
import { PermissionDialog } from "@/components/chat/permission-dialog"
import { PlanApprovalCard } from "@/components/chat/plan-approval-card"
import { useAcpActions } from "@/contexts/acp-connections-context"
import type { BlockingPrompts } from "@/lib/blocking-prompts"
import type { AgentType, PlanApprovalAnswer, QuestionAnswer } from "@/lib/types"

interface Props {
  /** The connection the prompts belong to — and the one every answer goes to. */
  connectionId: string
  prompts: BlockingPrompts
  /** Which agent asked; lets the permission card localise option labels. */
  agentType?: AgentType | null
  /** Wraps each card. */
  itemClassName?: string
}

function ConnectionBlockingPromptsImpl({
  connectionId,
  prompts,
  agentType,
  itemClassName,
}: Props) {
  const { respondPermission, answerQuestion, answerPlanApproval } =
    useAcpActions()

  const onRespondPermission = useCallback(
    (requestId: string, optionId: string) => {
      void respondPermission(connectionId, requestId, optionId)
    },
    [connectionId, respondPermission]
  )
  const onAnswerAskQuestion = useCallback(
    (questionId: string, answer: QuestionAnswer) =>
      answerQuestion(connectionId, questionId, answer),
    [connectionId, answerQuestion]
  )
  const onAnswerPlanApproval = useCallback(
    (approvalId: string, answer: PlanApprovalAnswer) =>
      answerPlanApproval(connectionId, approvalId, answer),
    [connectionId, answerPlanApproval]
  )

  return (
    <>
      {prompts.permission && (
        <div className={itemClassName}>
          <PermissionDialog
            permission={prompts.permission}
            onRespond={onRespondPermission}
            agentType={agentType}
          />
        </div>
      )}
      {prompts.askQuestion && (
        <div className={itemClassName}>
          <AskQuestionCard
            question={prompts.askQuestion}
            onAnswer={onAnswerAskQuestion}
          />
        </div>
      )}
      {prompts.planApproval && (
        <div className={itemClassName}>
          <PlanApprovalCard
            key={prompts.planApproval.approval_id}
            approval={prompts.planApproval}
            onAnswer={onAnswerPlanApproval}
          />
        </div>
      )}
    </>
  )
}

// Memoized: the hosts re-render with their transcripts, the prompts only when
// the connection asks something else.
export const ConnectionBlockingPrompts = memo(ConnectionBlockingPromptsImpl)
