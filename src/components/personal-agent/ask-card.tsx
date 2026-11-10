"use client"

/**
 * An executor's question or plan approval (7.3.1): the session of work an
 * assistant handed out stopped to ask, and that assistant answers it for the
 * owner — or forwards it to them. One card per request, following it:
 *
 * - **asking**: the assistant is answering it; nothing for the owner to do
 *   (they can still answer in the session — the first answer wins);
 * - **forwarded**: the owner's to answer, here: the question's options and a
 *   field of their own, or the plan with [Approve] [Request changes]
 *   [Abandon]; with why it came to them and, when the assistant forwarded
 *   it, what it leans to and why;
 * - **submitting**: a plan approval's answer on its way to the executor;
 * - **answered**: who answered (the assistant, the owner in the session or
 *   here, a chat channel) and what — the answer that took effect, whoever
 *   was second;
 * - **withdrawn**: the request went away unanswered.
 *
 * A mirror stands in the conversation the work came from, when that is
 * another assistant's (4.11): it answers the same ask.
 */

import { useTranslations } from "next-intl"
import { ListTodo, MessageCircleQuestion } from "lucide-react"
import { toast } from "sonner"

import { AskQuestionCard } from "@/components/chat/ask-question-card"
import { PlanApprovalCard } from "@/components/chat/plan-approval-card"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { Button } from "@/components/ui/button"
import { personalAgentAskAnswer } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  AgentType,
  AskAnsweredBy,
  AskCardData,
  AskPlanDecision,
  PlanApprovalDecision,
  QuestionAnswer,
  QuestionSpec,
} from "@/lib/types"
import { cn } from "@/lib/utils"

import { CollapsedText } from "./event-card"
import type { MessageItem } from "./message-items"
import { bubbleCorners, MessageRow } from "./message-row"
import {
  AGENT_SURFACE,
  asMode,
  canOpenWork,
  useOpenWork,
  usePageScope,
  useWorkMeta,
  workTargetOf,
} from "./shared"
import { WORK_WELL, WorkRow } from "./work-card"

type NoticeItem = Extract<MessageItem, { kind: "notice" }>

const FORWARD_REASONS = new Set([
  "assistant",
  "settings",
  "secret",
  "no_brain",
  "turn_ended",
  "turn_failed",
  "timeout",
  "handed_over",
])

/** A plan decision as the page sends it. */
export function askDecision(d: PlanApprovalDecision): AskPlanDecision {
  return d === "request_changes" ? "revise" : d
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

/** The answer that took effect, in the owner's words: a question's picks,
 *  or what became of the plan. */
export function useAnswerText(): (data: Partial<AskCardData>) => string {
  const t = useTranslations("PersonalAgent.ask")
  return (data) => {
    const answer = rec(data.answer)
    if (data.request === "question") {
      if (answer?.declined === true) return t("answer.skipped")
      const items = Array.isArray(answer?.answers) ? answer.answers : []
      const parts = items
        .map((raw) => {
          const a = rec(raw)
          const picked = Array.isArray(a?.selected)
            ? a.selected.filter((s): s is string => typeof s === "string")
            : []
          const label = text(a?.header) ?? text(a?.question)
          return label ? `${label}: ${picked.join(", ")}` : picked.join(", ")
        })
        .filter(Boolean)
      return parts.length > 0 ? parts.join("; ") : t("answer.empty")
    }
    if (data.request === "plan") {
      const feedback = text(answer?.feedback)
      switch (answer?.decision) {
        case "approve":
          return t("answer.approved")
        case "request_changes":
          return feedback
            ? t("answer.revisedWith", { feedback })
            : t("answer.revised")
        case "abandon":
          return t("answer.abandoned")
        default:
          return ""
      }
    }
    // A plan approval that was a permission request: the option taken.
    const kind = text(answer?.kind) ?? ""
    const name = text(answer?.name) ?? text(answer?.option_id) ?? ""
    return kind.startsWith("allow")
      ? t("answer.approvedAs", { option: name })
      : t("answer.sentBackAs", { option: name })
  }
}

/** Who answered, with what: "{name} answered for you: A". */
function useAnsweredLine(): (
  by: AskAnsweredBy | null | undefined,
  answer: string
) => string {
  const t = useTranslations("PersonalAgent.ask.by")
  return (by, answer) => {
    switch (by?.kind) {
      case "assistant":
        return t("assistant", { name: by.name ?? "", answer })
      case "owner":
        return by.where === "session"
          ? t("ownerSession", { answer })
          : by.where === "page"
            ? t("ownerPage", { answer })
            : t("owner", { answer })
      case "channel":
        return t("channel", { answer })
      case "policy":
        return t("policy", { answer })
      default:
        return t("someone", { answer })
    }
  }
}

export function AskCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.ask")
  const { readOnly, agentName } = usePageScope()
  const openWork = useOpenWork()
  const meta = useWorkMeta()
  const answerText = useAnswerText()
  const answeredLine = useAnsweredLine()
  const row = item.row
  const data = (row.data ?? {}) as Partial<AskCardData>
  const state = data.state ?? "asking"
  const askId = typeof data.ask_id === "number" ? data.ask_id : null
  const question = data.request === "question"
  const mirror = data.mirror_of ?? null
  // The assistant answering it: this page's, or — on a mirror — the one
  // the work was handed on to.
  const assistant = text(mirror?.name) ?? agentName
  const executor = text(data.executor)
  const questions: QuestionSpec[] = Array.isArray(data.questions)
    ? data.questions
    : []
  const plan = text(data.plan)
  const target = workTargetOf(undefined, {
    ...row,
    dispatch_id: data.dispatch_id ?? row.dispatch_id,
  })
  const openable = canOpenWork(target)
  const why =
    data.forward_reason && FORWARD_REASONS.has(data.forward_reason)
      ? t(`why.${data.forward_reason}` as "why.assistant", {
          name: assistant,
        })
      : null

  const send = async (params: {
    answer?: QuestionAnswer
    decision?: AskPlanDecision
    feedback?: string | null
  }) => {
    if (askId == null) return
    try {
      const out = await personalAgentAskAnswer({ askId, ...params })
      if (out.state === "already_answered") toast.info(t("toast.already"))
      else if (out.state === "withdrawn") toast.info(t("toast.withdrawn"))
    } catch (e) {
      toast.error(toErrorMessage(e))
      throw e
    }
  }

  const answerable = state === "forwarded" && !readOnly && askId != null
  const Icon = question ? MessageCircleQuestion : ListTodo
  const heading = question
    ? t("heading.question", { executor: executor ?? t("someone") })
    : t("heading.plan", { executor: executor ?? t("someone") })
  const answered =
    state === "answered"
      ? answeredLine(data.answered_by, answerText(data))
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
        data-pa-ask={state}
        className={cn(
          AGENT_SURFACE,
          bubbleCorners("start", item.tail),
          "min-w-0 p-3 text-sm text-foreground"
        )}
      >
        <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          {state === "asking" || state === "submitting" ? (
            <SyncedSpinner small className="size-3.5 shrink-0" />
          ) : (
            <Icon className="size-3.5 shrink-0" aria-hidden />
          )}
          <span className="font-medium">{heading}</span>
        </p>
        {mirror ? (
          <p className="mb-2 text-xs text-muted-foreground" data-pa-ask-mirror>
            {t("mirror", { name: assistant })}
          </p>
        ) : null}
        <div className={WORK_WELL}>
          <WorkRow
            executorId={data.executor_id ?? null}
            executor={executor}
            agentType={(data.agent_type as AgentType | null) ?? null}
            title={text(data.title) ?? row.body}
            meta={meta({
              executor,
              mode: asMode(data.mode),
              folder: null,
            })}
            chip={null}
            onOpen={openable ? () => openWork(target) : null}
          />
        </div>
        <p
          data-pa-ask-state
          className={cn(
            "mt-2.5 text-sm break-words",
            state === "forwarded" && "font-medium",
            state === "withdrawn" && "text-muted-foreground"
          )}
        >
          {state === "asking"
            ? t("state.asking", { name: assistant })
            : state === "forwarded"
              ? t("state.forwarded")
              : state === "submitting"
                ? t("state.submitting")
                : state === "withdrawn"
                  ? t("state.withdrawn")
                  : answered}
        </p>
        {state === "forwarded" && why ? (
          <p className="mt-1 text-xs text-muted-foreground">{why}</p>
        ) : null}
        {data.suggestion && state === "forwarded" ? (
          <p className="mt-1.5 text-xs break-words" data-pa-ask-suggestion>
            {t("suggestion", { name: assistant, suggestion: data.suggestion })}
          </p>
        ) : null}
        {data.reason &&
        (state === "forwarded" ||
          (state === "answered" && data.answered_by?.kind === "assistant")) ? (
          <p
            className="mt-1 text-xs break-words text-muted-foreground"
            data-pa-ask-reason
          >
            {t("reason", { reason: data.reason })}
          </p>
        ) : null}
        <div className="mt-2.5">
          {answerable && question ? (
            <AskQuestionCard
              question={{
                question_id: data.request_id ?? String(askId),
                questions,
                created_at: data.asked_at ?? row.created_at,
              }}
              onAnswer={(_, answer) => send({ answer })}
            />
          ) : answerable ? (
            <PlanApprovalCard
              approval={{
                approval_id: data.request_id ?? String(askId),
                tool_call_id: "",
                plan_markdown: plan ?? "",
                created_at: data.asked_at ?? row.created_at,
              }}
              onAnswer={(_, answer) =>
                send({
                  decision: askDecision(answer.decision),
                  feedback: answer.feedback ?? null,
                })
              }
            />
          ) : question ? (
            <QuestionList questions={questions} />
          ) : plan ? (
            <CollapsedText text={plan} />
          ) : null}
        </div>
        {openable && state !== "answered" && state !== "withdrawn" ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => openWork(target)}
            >
              {t("openSession")}
            </Button>
          </div>
        ) : null}
      </div>
    </MessageRow>
  )
}

/** The questions as asked, read-only: each with its options. */
function QuestionList({ questions }: { questions: QuestionSpec[] }) {
  return (
    <ul className="space-y-2" data-pa-ask-questions>
      {questions.map((q) => (
        <li key={q.id} className="min-w-0">
          <p className="text-sm break-words">{q.question}</p>
          {q.options.length > 0 ? (
            <ul className="mt-1 flex flex-wrap gap-1">
              {q.options.map((o) => (
                <li
                  key={o.label}
                  title={o.description || undefined}
                  className="rounded-full bg-(--pa-inset) px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {o.label}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
