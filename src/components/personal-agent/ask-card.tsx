"use client"

/**
 * A piece of work's question or plan approval (7.3.1): the session of work an
 * assistant handed out stopped to ask, and that assistant answers it for the
 * owner — or forwards it to them. One card per request, following it:
 *
 * - **asking**: the assistant is answering it; nothing for the owner to do
 *   (they can still answer in the session — the first answer wins);
 * - **forwarded**: the owner's to answer, here: the question's options and a
 *   field of their own, or the plan with [Approve] [Request changes]
 *   [Abandon]; with why it came to them and, when the assistant forwarded
 *   it, what it leans to and why;
 * - **submitting**: a plan approval's answer on its way to the work;
 * - **answered**: who answered (the assistant, the owner in the session or
 *   here, a chat channel) and what — the answer that took effect, whoever
 *   was second;
 * - **withdrawn**: the request went away unanswered.
 *
 * A mirror stands in the conversation the work came from, when that is
 * another assistant's (4.11): it answers the same ask.
 */

import { useTranslations } from "next-intl"
import {
  CircleAlert,
  CircleCheck,
  CircleSlash,
  ListTodo,
  MessageCircleQuestion,
} from "lucide-react"
import { toast } from "sonner"

import { AskQuestionCard } from "@/components/chat/ask-question-card"
import { PlanApprovalCard } from "@/components/chat/plan-approval-card"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { Button } from "@/components/ui/button"
import { personalAgentAskAnswer } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
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
import { MessageRow } from "./message-row"
import {
  asMode,
  canOpenWork,
  CardMessage,
  SheetActions,
  SheetPart,
  useOpenWork,
  usePageScope,
  useWorkMeta,
  workTargetOf,
} from "./shared"
import { WorkRow } from "./work-card"

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

/** A request's own card (a question, a plan, a permission — the chat's)
 *  as a band of this one: its frame, shadow and margins off, so it is not a
 *  card in a card. */
export const FLAT_REQUEST =
  "p-0 [&>*]:!m-0 [&>*]:!rounded-none [&>*]:!border-0 [&>*]:!bg-transparent [&>*]:!shadow-none"

/** Where an ask stands, on its tone: the owner's to answer amber and
 *  heavier, answered green, the rest quiet. */
const STATE_TONE: Record<string, string> = {
  asking: "text-muted-foreground",
  forwarded: "font-medium text-amber-700 dark:text-amber-400",
  submitting: "text-muted-foreground",
  withdrawn: "text-muted-foreground",
  answered: "text-foreground",
}

function StateIcon({ state }: { state: string }) {
  const cls = "mt-0.5 size-4 shrink-0"
  if (state === "asking" || state === "submitting")
    return <SyncedSpinner small className="mt-0.5 size-4" />
  if (state === "forwarded") return <CircleAlert className={cls} aria-hidden />
  if (state === "withdrawn") return <CircleSlash className={cls} aria-hidden />
  return (
    <CircleCheck
      className={cn(cls, "text-emerald-600 dark:text-emerald-400")}
      aria-hidden
    />
  )
}

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
  // Only the assistant speaks here: the work asks, unnamed.
  const heading = question ? t("heading.question") : t("heading.plan")
  // The assistant's grounds: while it is the owner's to answer, or when
  // the assistant answered it.
  const shownReason =
    data.reason &&
    (state === "forwarded" ||
      (state === "answered" && data.answered_by?.kind === "assistant"))
      ? data.reason
      : null
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
      <CardMessage
        data-pa-ask={state}
        head={
          <>
            <Icon aria-hidden />
            <span className="font-medium">{heading}</span>
          </>
        }
      >
        {/* The work that asks: the card's head. */}
        <WorkRow
          flat
          mode={asMode(data.mode)}
          title={text(data.title) ?? row.body}
          meta={meta({
            mode: asMode(data.mode),
            folder: null,
          })}
          chip={null}
          onOpen={openable ? () => openWork(target) : null}
        />
        {/* Where its question stands, and on whose word: the state on
              its tone, why it came to the owner, what the assistant leans
              to and on what — its words set in as a quote. */}
        <SheetPart className="flex flex-col gap-2">
          {mirror ? (
            <p className="text-xs text-muted-foreground" data-pa-ask-mirror>
              {t("mirror", { name: assistant })}
            </p>
          ) : null}
          <p
            className={cn(
              "flex items-start gap-1.5 text-sm leading-5 break-words",
              STATE_TONE[state]
            )}
          >
            <StateIcon state={state} />
            <span data-pa-ask-state>
              {state === "asking"
                ? t("state.asking", { name: assistant })
                : state === "forwarded"
                  ? t("state.forwarded")
                  : state === "submitting"
                    ? t("state.submitting")
                    : state === "withdrawn"
                      ? t("state.withdrawn")
                      : answered}
            </span>
          </p>
          {state === "forwarded" && why ? (
            <p className="text-xs text-muted-foreground">{why}</p>
          ) : null}
          {(data.suggestion && state === "forwarded") || shownReason ? (
            <div className="flex flex-col gap-0.5 border-s-2 border-border ps-3">
              {data.suggestion && state === "forwarded" ? (
                <p
                  className="text-sm leading-5 break-words"
                  data-pa-ask-suggestion
                >
                  {t("suggestion", {
                    name: assistant,
                    suggestion: data.suggestion,
                  })}
                </p>
              ) : null}
              {shownReason ? (
                <p
                  className="text-xs break-words text-muted-foreground"
                  data-pa-ask-reason
                >
                  {t("reason", { reason: shownReason })}
                </p>
              ) : null}
            </div>
          ) : null}
        </SheetPart>
        {/* What it asks: to answer here, or as it was asked. */}
        {answerable || question || plan ? (
          <SheetPart className={cn(answerable && FLAT_REQUEST)}>
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
            ) : (
              <CollapsedText text={plan ?? ""} />
            )}
          </SheetPart>
        ) : null}
        {openable && state !== "answered" && state !== "withdrawn" ? (
          <SheetActions>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => openWork(target)}
            >
              {t("openSession")}
            </Button>
          </SheetActions>
        ) : null}
      </CardMessage>
    </MessageRow>
  )
}

/** The questions as asked, read-only: each with its options, a hairline
 *  between two. */
function QuestionList({ questions }: { questions: QuestionSpec[] }) {
  return (
    <ul
      className="flex flex-col divide-y divide-border/60"
      data-pa-ask-questions
    >
      {questions.map((q) => (
        <li key={q.id} className="min-w-0 py-2 first:pt-0 last:pb-0">
          {q.header ? (
            <p className="text-xs leading-4 text-muted-foreground">
              {q.header}
            </p>
          ) : null}
          <p className="text-sm leading-5 break-words">{q.question}</p>
          {q.options.length > 0 ? (
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {q.options.map((o) => (
                <li
                  key={o.label}
                  title={o.description || undefined}
                  className="inline-flex h-6 items-center rounded-full bg-muted px-2.5 text-xs text-foreground/80"
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
