"use client"

/**
 * The assistant brain's own question (`ask_user_question`), drawn as a
 * choice card in its reply's bubble (10.7): one question at a time — "1 /
 * 3" at the top, [Back] to the one before, answers kept — its choices
 * lettered and picked with a click or the letter's key, "Other" for the
 * owner's own words (codeg's questions always take them, so they go into
 * that question's answer), several choices toggled and then [Next] where
 * the question takes several. A question with no choices is just the line
 * to write in, masked when it asks for a secret.
 *
 * Answered, it folds to one line — "You picked: B. Look at local changes"
 * — that opens to the card as it was. The answer is the row's, so a reload
 * shows it. A page that only reads shows the question, not the way to
 * answer it.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  PenLine,
  Send,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { useBotId } from "@/contexts/personal-agent-context"
import { personalAgentAnswerQuestion } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { QuestionSpec, TimelineRow } from "@/lib/types"
import { cn } from "@/lib/utils"

import {
  CHOICE_INPUT_CLASS,
  CHOICE_OTHER_CLASS,
  CHOICE_WRITE_CLASS,
  ChoiceKey,
  choiceRowClass,
} from "./choice-card"
import { INSET_SURFACE, str, usePageScope } from "./shared"

/** The brain's question rows this card draws: an `ask_user_question` with
 *  its questions on the row (a plan approval is not one). */
export function isChoiceQuestionRow(row: TimelineRow): boolean {
  return (
    row.kind === "question" &&
    row.data?.kind !== "plan_approval" &&
    questionsOf(row.data?.questions).length > 0
  )
}

export function questionsOf(v: unknown): QuestionSpec[] {
  if (!Array.isArray(v)) return []
  return v.filter(
    (q): q is QuestionSpec =>
      q != null &&
      typeof q === "object" &&
      typeof (q as QuestionSpec).id === "string" &&
      typeof (q as QuestionSpec).question === "string" &&
      Array.isArray((q as QuestionSpec).options)
  )
}

const letter = (i: number) => String.fromCharCode(65 + i)

/** What the owner picked for one question: the choices' letters and their
 *  own words. */
export interface Pick {
  keys: string[]
  text: string
}

const EMPTY: Pick = { keys: [], text: "" }

function filled(p: Pick | undefined): boolean {
  return p != null && (p.keys.length > 0 || p.text.trim().length > 0)
}

interface RecordedAnswer {
  question?: string
  header?: string
  selected?: string[]
}

/** The answer on the row, by question, as letters and own words. */
export function recordedPicks(
  questions: readonly QuestionSpec[],
  answer: unknown
): Pick[] {
  const list: RecordedAnswer[] =
    answer &&
    typeof answer === "object" &&
    Array.isArray((answer as { answers?: unknown }).answers)
      ? ((answer as { answers: RecordedAnswer[] }).answers ?? [])
      : []
  // The row keeps answers in question order, without ids, and leaves out a
  // question not answered: each answer goes to the first question asked in
  // its words that has none yet.
  const used = new Set<number>()
  return questions.map((q, i) => {
    let at = list.findIndex(
      (x, j) =>
        !used.has(j) &&
        x.question === q.question &&
        (x.header == null || x.header === q.header)
    )
    if (at < 0 && list.length === questions.length && !used.has(i)) at = i
    if (at >= 0) used.add(at)
    const a = at >= 0 ? list[at] : undefined
    const keys: string[] = []
    const own: string[] = []
    for (const label of a?.selected ?? []) {
      const at = q.options.findIndex((o) => o.label === label)
      if (at >= 0) keys.push(letter(at))
      else own.push(label)
    }
    return { keys, text: own.join(", ") }
  })
}

/** One question's answer as the folded line says it. */
function pickText(q: QuestionSpec, p: Pick): string {
  const parts = p.keys.map((k) => {
    const o = q.options[k.charCodeAt(0) - 65]
    return o ? `${k}. ${o.label}` : k
  })
  if (p.text.trim()) parts.push(q.is_secret ? "•••" : p.text.trim())
  return parts.join(", ")
}

export function QuestionChoiceCard({
  row,
  live = true,
}: {
  row: TimelineRow
  /** The turn that asked it is the one in flight: only then can it be
   *  answered (a question left pending by a turn that is gone shows, but
   *  waits on nothing). */
  live?: boolean
}) {
  const t = useTranslations("PersonalAgent.bots.choice")
  const tReply = useTranslations("PersonalAgent.reply")
  const { readOnly } = usePageScope()
  const botId = useBotId()
  const data = row.data ?? {}
  const questions = useMemo(() => questionsOf(data.questions), [data.questions])
  const state = str(data, "state") ?? "pending"
  const pendingNow = state === "pending"
  const recorded = useMemo(
    () => recordedPicks(questions, data.answer),
    [questions, data.answer]
  )
  const [unfolded, setUnfolded] = useState(false)

  if (pendingNow) {
    return (
      <div
        className={cn(INSET_SURFACE, "mt-2 rounded-xl p-3")}
        data-pa-question-card="open"
      >
        <Stepper
          questions={questions}
          disabled={readOnly || !live}
          onAnswer={(picks) =>
            personalAgentAnswerQuestion(
              row.ref_id ?? "",
              {
                answers: questions
                  .map((q, i) => ({
                    questionId: q.id,
                    labels: [
                      ...picks[i].keys
                        .map((k) => q.options[k.charCodeAt(0) - 65]?.label)
                        .filter((l): l is string => typeof l === "string"),
                      ...(picks[i].text.trim() ? [picks[i].text.trim()] : []),
                    ],
                  }))
                  .filter((a) => a.labels.length > 0),
                declined: false,
              },
              botId
            )
          }
          onSkip={() =>
            personalAgentAnswerQuestion(
              row.ref_id ?? "",
              { answers: [], declined: true },
              botId
            )
          }
        />
      </div>
    )
  }

  const line =
    state === "answered"
      ? questions.length === 1 &&
        recorded[0].keys.length === 0 &&
        recorded[0].text.trim()
        ? t("answeredOwn", { text: pickText(questions[0], recorded[0]) })
        : t("answered", {
            choice: questions
              .map((q, i) => pickText(q, recorded[i]))
              .filter(Boolean)
              .join(" · "),
          })
      : state === "skipped"
        ? tReply("answeredSkipped")
        : t("noLongerAsked")

  return (
    <div
      className="mt-1.5 text-xs text-muted-foreground"
      data-pa-question-card={state}
      data-row-id={row.id}
    >
      <button
        type="button"
        onClick={() => setUnfolded((u) => !u)}
        aria-expanded={unfolded}
        className="flex w-full items-center gap-1.5 text-start hover:text-foreground"
        data-pa-choice-answered
      >
        {unfolded ? (
          <ChevronDown className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronRight
            className="size-3.5 shrink-0 rtl:rotate-180"
            aria-hidden
          />
        )}
        <span className="min-w-0 flex-1 break-words">{line}</span>
      </button>
      {unfolded ? (
        <div
          className={cn(
            INSET_SURFACE,
            "mt-1.5 rounded-xl p-3 text-sm text-foreground"
          )}
        >
          {questions.map((q, i) => (
            <QuestionView
              key={q.id}
              question={q}
              pick={recorded[i]}
              className={i > 0 ? "mt-3" : undefined}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** One question as it was answered, nothing to press. */
function QuestionView({
  question,
  pick,
  className,
}: {
  question: QuestionSpec
  pick: Pick
  className?: string
}) {
  const t = useTranslations("PersonalAgent.bots.choice")
  return (
    <div className={className}>
      <p className="mb-2 text-sm font-medium break-words">
        {question.question}
      </p>
      <div className="flex flex-col gap-2">
        {question.options.map((o, i) => (
          <div
            key={`${i}-${o.label}`}
            className={choiceRowClass(pick.keys.includes(letter(i)))}
          >
            <ChoiceKey
              letter={letter(i)}
              chosen={pick.keys.includes(letter(i))}
            />
            <span className="min-w-0 flex-1 break-words">{o.label}</span>
          </div>
        ))}
        {pick.text.trim() ? (
          <div className={choiceRowClass(true)}>
            <span className="min-w-0 flex-1 break-words">
              {t("otherWrote", {
                text: question.is_secret ? "•••" : pick.text.trim(),
              })}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** The questions one at a time; the last answer sends them all. */
export function Stepper({
  questions,
  disabled,
  onAnswer,
  onSkip,
}: {
  questions: readonly QuestionSpec[]
  disabled: boolean
  onAnswer: (picks: Pick[]) => Promise<void>
  onSkip: () => Promise<void>
}) {
  const t = useTranslations("PersonalAgent.bots.choice")
  const [at, setAt] = useState(0)
  const [picks, setPicks] = useState<Pick[]>(() => questions.map(() => EMPTY))
  const [writing, setWriting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const q = questions[Math.min(at, questions.length - 1)]
  const pick = picks[at] ?? EMPTY
  const total = questions.length
  const last = at === total - 1
  const freeText = q.options.length === 0
  const otherKey = freeText ? null : letter(q.options.length)
  const blocked = disabled || busy

  const run = async (work: () => Promise<void>) => {
    if (blocked) return
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (e) {
      setError(toErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  /** On with these picks: the next question, or — after the last — send. */
  const advance = (next: Pick[]) => {
    setPicks(next)
    if (!last) {
      const n = at + 1
      setAt(n)
      setWriting(questions[n].options.length === 0 || next[n].text.length > 0)
      return
    }
    void run(() => onAnswer(next))
  }
  const withPick = (p: Pick) => picks.map((x, i) => (i === at ? p : x))

  const choose = (k: string) => {
    if (blocked) return
    if (q.multi_select) {
      const keys = pick.keys.includes(k)
        ? pick.keys.filter((x) => x !== k)
        : [...pick.keys, k].sort()
      setPicks(withPick({ ...pick, keys }))
      return
    }
    advance(withPick({ keys: [k], text: "" }))
  }
  const writeOwn = () => {
    const text = pick.text.trim()
    if (!text || blocked) return
    if (q.multi_select) advance(withPick({ ...pick, text }))
    else advance(withPick({ keys: [], text }))
  }
  const back = () => {
    if (at === 0 || blocked) return
    const n = at - 1
    setAt(n)
    setWriting(questions[n].options.length === 0 || picks[n].text.length > 0)
  }

  const showInput = freeText || writing
  return (
    <div
      data-pa-choice-card
      data-pa-question-step={at + 1}
      tabIndex={blocked ? undefined : 0}
      onKeyDown={(e) => {
        if (blocked || e.metaKey || e.ctrlKey || e.altKey) return
        if ((e.target as HTMLElement).tagName === "INPUT") return
        if (e.key === "Enter" && q.multi_select && filled(pick)) {
          e.preventDefault()
          advance(picks)
          return
        }
        if (freeText || e.key.length !== 1) return
        const k = e.key.toUpperCase()
        const i = k.charCodeAt(0) - 65
        if (i >= 0 && i < q.options.length) {
          e.preventDefault()
          choose(k)
        } else if (k === otherKey) {
          e.preventDefault()
          setWriting(true)
        }
      }}
      className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        {total > 1 ? (
          <span className="tabular-nums" data-pa-question-progress>
            {t("progress", { at: at + 1, total })}
          </span>
        ) : null}
        {q.header ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] font-medium">
            {q.header}
          </span>
        ) : null}
        {q.multi_select ? <span>{t("several")}</span> : null}
      </div>
      <p className="mb-2.5 text-sm font-medium break-words">{q.question}</p>
      <div role="group" aria-label={q.question} className="flex flex-col gap-2">
        {q.options.map((o, i) => {
          const k = letter(i)
          const chosen = pick.keys.includes(k)
          return (
            <button
              key={`${i}-${o.label}`}
              type="button"
              disabled={blocked}
              aria-pressed={q.multi_select ? chosen : undefined}
              data-pa-choice={k}
              onClick={() => choose(k)}
              className={choiceRowClass(chosen)}
            >
              <ChoiceKey letter={k} chosen={chosen} />
              <span className="min-w-0 flex-1 break-words">
                {o.label}
                {o.description ? (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {o.description}
                  </span>
                ) : null}
              </span>
            </button>
          )
        })}
        {showInput ? (
          <form
            className={CHOICE_WRITE_CLASS}
            onSubmit={(e) => {
              e.preventDefault()
              writeOwn()
            }}
          >
            {otherKey ? <ChoiceKey letter={otherKey} /> : null}
            <Input
              autoFocus={!freeText}
              type={q.is_secret ? "password" : "text"}
              value={pick.text}
              disabled={blocked}
              onChange={(e) =>
                setPicks(withPick({ ...pick, text: e.target.value }))
              }
              placeholder={t("otherPlaceholder")}
              aria-label={t("other")}
              className={CHOICE_INPUT_CLASS}
              data-pa-choice-other-input
            />
            <Button
              type="submit"
              size="icon-sm"
              disabled={!pick.text.trim() || blocked}
              aria-label={t("send")}
            >
              <Send aria-hidden />
            </Button>
          </form>
        ) : (
          <button
            type="button"
            disabled={blocked}
            data-pa-choice={otherKey ?? undefined}
            onClick={() => setWriting(true)}
            className={CHOICE_OTHER_CLASS}
          >
            {otherKey ? <ChoiceKey letter={otherKey} /> : null}
            <span className="min-w-0 flex-1 break-words">{t("other")}</span>
            <PenLine aria-hidden className="size-3.5 shrink-0 opacity-60" />
          </button>
        )}
      </div>
      <div className="mt-2.5 flex items-center gap-1.5">
        {at > 0 ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={blocked}
            onClick={back}
            data-pa-question-back
          >
            <ChevronLeft className="rtl:rotate-180" aria-hidden />
            {t("back")}
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          disabled={blocked}
          onClick={() => void run(onSkip)}
          className="text-muted-foreground"
          data-pa-question-skip
        >
          {t("skip")}
        </Button>
        <span className="flex-1" />
        {busy ? <SyncedSpinner small className="size-3.5" /> : null}
        {q.multi_select ? (
          <Button
            size="xs"
            disabled={blocked || !filled(pick)}
            onClick={() => advance(picks)}
            data-pa-question-next
          >
            {last ? t("submit") : t("next")}
          </Button>
        ) : !last && filled(pick) ? (
          <Button
            size="xs"
            variant="outline"
            disabled={blocked}
            onClick={() => advance(picks)}
            data-pa-question-next
          >
            {t("next")}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs break-words text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
