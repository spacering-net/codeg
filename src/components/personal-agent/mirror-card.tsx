"use client"

/**
 * Another assistant's question or permission request, shown in the
 * conversation where what it is working on began: the owner asked here, it
 * was handed on, and the one doing it now needs an answer. It names who asks
 * and quotes what it is for. Answering here answers there — it is one
 * request: once it is answered in either place, both say so.
 */

import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { AssistantAvatar } from "@/components/assistants/assistant-avatar"
import { AskQuestionCard } from "@/components/chat/ask-question-card"
import { PermissionDialog } from "@/components/chat/permission-dialog"
import { useBotId } from "@/contexts/personal-agent-context"
import {
  personalAgentAnswerQuestion,
  personalAgentRespondPermission,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  AgentType,
  AssistantAvatar as AvatarValue,
  PermissionOptionInfo,
  QuestionSpec,
} from "@/lib/types"
import { cn } from "@/lib/utils"

import type { MessageItem } from "./message-items"
import { bubbleCorners, MessageRow } from "./message-row"
import { QuoteBar } from "./quote-bar"
import { AGENT_SURFACE, num, str, useBotName, usePageScope } from "./shared"

type MirrorItem = Extract<MessageItem, { kind: "mirror" }>

export function MirrorCard({ item }: { item: MirrorItem }) {
  const t = useTranslations("PersonalAgent.mirror")
  const botId = useBotId()
  const { readOnly } = usePageScope()
  const row = item.row
  const data = row.data ?? {}
  const from =
    data.from_bot && typeof data.from_bot === "object"
      ? (data.from_bot as Record<string, unknown>)
      : null
  const name = useBotName()({
    id: num(from, "id"),
    name: str(from, "name"),
    kind: str(from, "kind"),
  })
  const avatar = (from?.avatar as AvatarValue | null | undefined) ?? null
  const state = str(data, "state") ?? "pending"
  const pending = state === "pending"
  const forRow = num(data, "for_row")
  const refId = row.ref_id ?? ""
  const fail = (e: unknown) => toast.error(toErrorMessage(e))
  const heading =
    row.kind === "permission"
      ? t("permission", { name })
      : t("question", { name })
  const settled =
    state === "answered"
      ? t("answered")
      : state === "skipped"
        ? t("skipped")
        : state === "withdrawn"
          ? t("withdrawn")
          : state === "resolved"
            ? t("resolved")
            : null
  return (
    <MessageRow
      rowId={row.id}
      side="start"
      gap={item.gap}
      tail={item.tail}
      roomy
      actions={{ rowId: row.id, text: row.body, at: row.created_at }}
    >
      <div
        data-bubble
        data-pa-mirror={state}
        className={cn(
          AGENT_SURFACE,
          bubbleCorners("start", item.tail),
          "min-w-0 p-3 text-sm text-foreground"
        )}
      >
        <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <AssistantAvatar avatar={avatar} name={name} size={16} />
          <span className="font-medium">{heading}</span>
        </p>
        {forRow != null ? (
          <QuoteBar targetId={forRow} tone="light" className="mb-2" />
        ) : null}
        {pending && !readOnly && refId ? (
          row.kind === "permission" ? (
            <PermissionDialog
              permission={{
                request_id: refId,
                tool_call: data.tool_call ?? null,
                options: (data.options as PermissionOptionInfo[]) ?? [],
              }}
              agentType={
                (str(data, "agent_type") as AgentType) ?? "claude_code"
              }
              onRespond={(requestId, optionId) => {
                personalAgentRespondPermission(
                  requestId,
                  optionId,
                  botId
                ).catch(fail)
              }}
            />
          ) : (
            <AskQuestionCard
              question={{
                question_id: refId,
                questions: (data.questions as QuestionSpec[]) ?? [],
                created_at: row.created_at,
              }}
              onAnswer={(questionId, answer) =>
                personalAgentAnswerQuestion(questionId, answer, botId)
              }
            />
          )
        ) : (
          <p className="text-sm break-words">{row.body}</p>
        )}
        {settled ? (
          <p className="mt-1.5 text-xs text-muted-foreground">{settled}</p>
        ) : null}
      </div>
    </MessageRow>
  )
}
