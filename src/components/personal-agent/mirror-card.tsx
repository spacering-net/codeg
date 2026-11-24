"use client"

/**
 * Another assistant's question or permission request, shown in the
 * conversation where what it is working on began: the owner asked here, it
 * was handed on, and the one doing it now needs an answer. It names who asks
 * and quotes what it is for. Answering here answers there — it is one
 * request: once it is answered in either place, both say so.
 */

import { useTranslations } from "next-intl"
import { CircleCheck, CircleSlash, Undo2 } from "lucide-react"
import { toast } from "sonner"

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
  BotAvatar as AvatarValue,
  PermissionOptionInfo,
  QuestionSpec,
} from "@/lib/types"
import { cn } from "@/lib/utils"

import { BotAvatar } from "./bot-avatar"
import type { MessageItem } from "./message-items"
import { MessageRow } from "./message-row"
import { FLAT_REQUEST } from "./ask-card"
import { QuoteBar } from "./quote-bar"
import {
  CardMessage,
  num,
  SheetPart,
  str,
  useBotName,
  usePageScope,
} from "./shared"

type MirrorItem = Extract<MessageItem, { kind: "mirror" }>

/** How it was settled, on its tone: answered green, the rest quiet. */
const SETTLED_TONE: Record<string, string> = {
  answered: "text-emerald-700 dark:text-emerald-400",
  resolved: "text-emerald-700 dark:text-emerald-400",
}

function SettledIcon({ state }: { state: string }) {
  const Icon =
    state === "answered" || state === "resolved"
      ? CircleCheck
      : state === "withdrawn"
        ? Undo2
        : CircleSlash
  return <Icon className="size-3.5 shrink-0" aria-hidden />
}

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
      <CardMessage
        data-pa-mirror={state}
        head={
          <>
            <BotAvatar avatar={avatar} name={name} size={16} />
            <span className="font-medium">{heading}</span>
          </>
        }
      >
        {/* The message it is about. */}
        {forRow != null ? (
          <SheetPart>
            <QuoteBar targetId={forRow} tone="light" />
          </SheetPart>
        ) : null}
        {/* What it asks: to answer here — the request's own card as a band
            of this one — or as it was asked. */}
        {pending && !readOnly && refId ? (
          <SheetPart className={FLAT_REQUEST}>
            {row.kind === "permission" ? (
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
            )}
          </SheetPart>
        ) : (
          <SheetPart>
            <p className="text-sm leading-5 break-words">{row.body}</p>
          </SheetPart>
        )}
        {/* Settled: how, where its answer was. */}
        {settled ? (
          <SheetPart
            className={cn(
              "flex items-center gap-1.5 py-2.5 text-xs",
              SETTLED_TONE[state] ?? "text-muted-foreground"
            )}
            data-pa-mirror-settled={state}
          >
            <SettledIcon state={state} />
            <span>{settled}</span>
          </SheetPart>
        ) : null}
      </CardMessage>
    </MessageRow>
  )
}
