"use client"

/**
 * Read-only inline view of the codeg-mcp `ask_user_question` tool in the message
 * stream (historical transcripts + the in-flight tool marker).
 *
 * The answered / declined record is collapsed by default into a capsule that
 * summarizes the picks; expanding it reveals the live `AskQuestionCard` in its
 * `readOnly` mode, so the layout (tabs, headers, option cards) stays identical
 * to the interactive card the user actually answered — it just renders the
 * selection as disabled and drops the footer. The Q&A is reconstructed from the
 * tool's raw input JSON + the persisted `{ answers, declined }` result envelope
 * (see `@/lib/ask-question`). Error and in-flight states fall back to a compact
 * header card, since there is no answered selection to show yet.
 */

import { useMemo, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  MessageCircleQuestionMark,
} from "lucide-react"

import { AskQuestionCard } from "@/components/chat/ask-question-card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  matchSelections,
  parseAskQuestionInput,
  parseAskQuestionOutcome,
} from "@/lib/ask-question"
import type { PendingQuestionState } from "@/lib/types"
import type { ToolCallState } from "@/lib/adapters/ai-elements-adapter"

// Separator for the composite "header + question" lookup key. A control char
// (unit separator) that never appears in agent-authored text.
const KEY_SEP = String.fromCharCode(31)
const NOOP = () => {}

interface Props {
  input?: string | null
  output?: string | null
  errorText?: string | null
  state?: ToolCallState
}

export function AskQuestionResultCard({
  input,
  output,
  errorText,
  state,
}: Props) {
  const t = useTranslations("Folder.chat.askQuestionResult")
  const [expanded, setExpanded] = useState(false)

  const questions = useMemo(() => parseAskQuestionInput(input), [input])
  // The asked questions let a CLI answer sentence be read by their exact text
  // (it escapes nothing) and split a multi-select answer back into its labels.
  const outcome = useMemo(
    () => parseAskQuestionOutcome(output, questions),
    [output, questions]
  )

  const isError = !!errorText?.trim()
  const isRunning = state === "input-available" || state === "input-streaming"
  const isInFlight = !isError && !outcome && isRunning

  // The question set, shaped for AskQuestionCard (synthetic ids: the persisted
  // input carries none — the backend mints them server-side).
  const pending = useMemo<PendingQuestionState | null>(() => {
    if (questions.length === 0) return null
    return {
      question_id: "result",
      created_at: "",
      questions: questions.map((q, i) => ({
        id: `q${i}`,
        question: q.question,
        header: q.header,
        multi_select: q.multiSelect,
        options: q.options,
        is_secret: q.isSecret,
      })),
    }
  }, [questions])

  // Seed each question's selection by matching its answer text against the
  // offered option labels (option-aware, so a label containing ", " survives).
  const initialSelections = useMemo(() => {
    const sel: Record<string, { chosen: string[]; otherText: string }> = {}
    if (!pending || outcome?.declined) return sel
    // codex `request_user_input` answers carry the question `id`; codeg-mcp / grok
    // asks carry none and match on the header+question signature instead.
    const byId = new Map(
      (outcome?.answers ?? [])
        .filter((a) => a.id)
        .map((a) => [a.id as string, a.selected])
    )
    const bySig = new Map(
      (outcome?.answers ?? []).map((a) => [
        `${a.header}${KEY_SEP}${a.question}`,
        a.selected,
      ])
    )
    // Kimi Code's native ask keys its answers by the bare question TEXT (its
    // envelope carries no header), so the header+question signature misses any
    // question that has one — fall back to the question text alone.
    const byQuestion = new Map(
      (outcome?.answers ?? [])
        .filter((a) => a.question)
        .map((a) => [a.question, a.selected])
    )
    pending.questions.forEach((q, i) => {
      const qid = questions[i]?.id
      const values =
        (qid ? byId.get(qid) : undefined) ??
        bySig.get(`${q.header}${KEY_SEP}${q.question}`) ??
        byQuestion.get(q.question) ??
        []
      const { selected, other } = matchSelections(
        values,
        q.options.map((o) => o.label)
      )
      sel[q.id] = { chosen: selected, otherText: other.join(", ") }
    })
    return sel
  }, [pending, outcome, questions])

  // Compact header card for the states with no answered selection to render.
  const shell = (subtitle: string | null, body?: ReactNode) => (
    <div
      data-testid="ask-question-result-card"
      className={cn(
        "mb-2 overflow-hidden rounded-xl border bg-card ws-msg-card",
        isError ? "border-destructive/30" : "border-primary/30"
      )}
    >
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-start gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-primary">
            <MessageCircleQuestionMark className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t("title")}</p>
            {subtitle && (
              <p className="text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
          {isInFlight && (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          )}
        </div>
        {body}
      </div>
    </div>
  )

  if (isError) {
    return shell(
      null,
      <p className="whitespace-pre-wrap text-xs text-destructive">
        {errorText?.trim()}
      </p>
    )
  }

  if (isInFlight) {
    // A live pending question is answered through the PINNED AskQuestionCard
    // (driven by the connection's `pendingAskQuestion`), not this in-stream
    // record. Until the question text streams onto the wire, claude-agent-acp's
    // arg-less initial `tool_call` leaves `input` empty, so `questions` is []:
    // rendering the bare "awaiting your answer" placeholder here only stacks
    // anonymous duplicates of the same wait — one per in-flight (or stranded)
    // question call. Drop it; the card reappears with its Q&A the moment the
    // input or the answer resolves, and the settled transcript is unaffected.
    if (questions.length === 0) return null
    return shell(
      t("awaiting"),
      <div className="flex flex-wrap gap-1.5">
        {questions.map((q, i) => (
          <Badge key={i} variant="outline" className="text-3xs">
            {q.header || q.question}
          </Badge>
        ))}
      </div>
    )
  }

  // Input didn't parse (e.g. a truncated transcript) but the result text did:
  // show the answers as chips so the record isn't lost.
  if (!pending) {
    const answers = outcome?.answers ?? []
    if (answers.length === 0) return null
    return shell(
      outcome?.declined ? t("declined") : null,
      <div className="space-y-2">
        {answers.map((a, i) => {
          const labels = matchSelections(a.selected, []).other
          return (
            <div key={i} className="space-y-1">
              {a.question && (
                <p className="text-xs text-foreground/90">{a.question}</p>
              )}
              {labels.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {labels.map((label) => (
                    <Badge key={label} className="text-xs">
                      {label}
                    </Badge>
                  ))}
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {t("noSelection")}
                </span>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  // Answered / declined. Collapsed by default into a capsule that summarizes the
  // picks; expanding reveals the live card (so the layout matches exactly).
  const picks = (outcome?.answers ?? [])
    .flatMap((a) => a.selected)
    .filter(Boolean)
  const summary = outcome?.declined
    ? t("declined")
    : picks.length > 0
      ? picks.join(", ")
      : t("noSelection")

  const capsule = (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      aria-expanded={expanded}
      data-testid="ask-question-result-card"
      className={cn(
        "flex w-fit max-w-full items-center gap-2 rounded-full border border-primary/30 bg-card ws-msg-card px-3 py-1.5 text-left transition-colors hover:bg-muted/40",
        !expanded && "mb-2"
      )}
    >
      <MessageCircleQuestionMark className="size-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate text-xs">
        <span className="mr-1 text-muted-foreground">{t("answeredLabel")}</span>
        <span className="text-foreground/90">{summary}</span>
      </span>
      {expanded ? (
        <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      )}
    </button>
  )

  if (!expanded) return capsule

  return (
    <div className="mb-2 space-y-1.5">
      {capsule}
      <AskQuestionCard
        readOnly
        question={pending}
        onAnswer={NOOP}
        initialSelections={initialSelections}
        title={t("title")}
        subtitle={outcome?.declined ? t("declined") : ""}
      />
    </div>
  )
}
