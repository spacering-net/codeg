"use client"

import { useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Loader2,
  MessageCircleQuestionMark,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Checkbox } from "@/components/ui/checkbox"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { splitRecommended } from "@/lib/ask-question"
import type {
  PendingQuestionState,
  QuestionAnswer,
  QuestionSpec,
} from "@/lib/types"

interface AskQuestionCardProps {
  /** The awaiting-answer question set. The shell renders this card only when a
   *  question is pending, so the prop is always present. */
  question: PendingQuestionState
  /** Resolves the parked tool call. Returns a promise so the card can show an
   *  in-flight state and surface a retryable error if the round-trip fails. */
  onAnswer: (questionId: string, answer: QuestionAnswer) => void | Promise<void>
  /** Read-only/answered view (the in-message record): controls are disabled,
   *  the footer is dropped, and selections are seeded from `initialSelections`
   *  rather than collected. Omit it for the live, interactive card. */
  readOnly?: boolean
  /** Pre-filled selections per question id, used only in the read-only view. */
  initialSelections?: SeedSelections
  /** Header overrides (already localized) for the read-only view. */
  title?: string
  subtitle?: string
}

/** Seeded selections for the read-only view: chosen real-option labels plus any
 *  free-text "Other" answer, keyed by question id. */
type SeedSelections = Record<string, { chosen: string[]; otherText: string }>

/** Single-select sentinel value for the host-injected free-text "Other" choice,
 *  so it can live inside the same `RadioGroup` as the real options. */
const OTHER_VALUE = "__other__"

interface QState {
  /** Selected real-option labels (verbatim). For single-select, ≤ 1. */
  chosen: string[]
  otherActive: boolean
  otherText: string
}

function initialState(
  questions: QuestionSpec[],
  seed?: SeedSelections
): Record<string, QState> {
  const out: Record<string, QState> = {}
  for (const q of questions) {
    const s = seed?.[q.id]
    out[q.id] = s
      ? {
          chosen: s.chosen,
          otherActive: s.otherText.trim().length > 0,
          otherText: s.otherText,
        }
      : { chosen: [], otherActive: false, otherText: "" }
  }
  return out
}

/** A question is answered once it has a real option or non-empty "Other" text. */
function isAnswered(s: QState | undefined): boolean {
  if (!s) return false
  const hasOther = s.otherActive && s.otherText.trim().length > 0
  return s.chosen.length > 0 || hasOther
}

export function AskQuestionCard({
  question,
  onAnswer,
  readOnly = false,
  initialSelections,
  title,
  subtitle,
}: AskQuestionCardProps) {
  const t = useTranslations("Folder.chat.askQuestion")
  const questions = question.questions
  const [state, setState] = useState<Record<string, QState>>(() =>
    initialState(questions, initialSelections)
  )
  // Active tab in the multi-question layout.
  const [activeId, setActiveId] = useState(() => questions[0]?.id ?? "")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(false)
  // Synchronous guard against a double-submit before `submitting` re-renders.
  const inFlight = useRef(false)
  // Tracks which question set the above state belongs to. If the card is reused
  // for a different set (a new question_id) without remounting, reset so stale
  // selections never carry over — the component stays correct on its own rather
  // than relying on the caller to supply a fresh React key.
  const [renderedId, setRenderedId] = useState(question.question_id)

  // Panel-presence state (live card only): shrink the card to its header row
  // so a long set stops squeezing the message list, while the question stays
  // pending and visible. Reset alongside the rest whenever a different set
  // renders into this instance — see the swap guard below.
  const [collapsed, setCollapsed] = useState(false)

  // How many questions are answered — drives the progress bar, the counter, and
  // the submit gate (every question must be answered).
  const answeredCount = useMemo(
    () => questions.filter((q) => isAnswered(state[q.id])).length,
    [questions, state]
  )
  const complete = answeredCount === questions.length

  // Reserve one stable content height for the whole set so switching between a
  // few-option tab and a many-option tab never resizes the card. Sized to the
  // tallest question (its option count plus the always-present "Other" row),
  // capped to the viewport; a taller-than-estimated tab scrolls internally.
  const maxRows = useMemo(
    () => questions.reduce((m, q) => Math.max(m, q.options.length + 1), 1),
    [questions]
  )
  const bodyHeight = `min(${maxRows * 4 + 1}rem, 50svh)`

  if (question.question_id !== renderedId) {
    setRenderedId(question.question_id)
    setState(initialState(questions, initialSelections))
    setActiveId(questions[0]?.id ?? "")
    setSubmitting(false)
    setError(false)
    // Collapsed too, and this one is not housekeeping. A replacement set is a
    // NEW blocking request; left collapsed it renders as the same header row
    // the user already dismissed from view — identical title, and an
    // identically-sized set even shows the same counter — so they can miss it
    // entirely and leave the agent stalled.
    setCollapsed(false)
    // `inFlight` is intentionally not reset here — refs must not be written
    // during render. `run` clears it whenever the round-trip resolves (both the
    // success and failure paths), so it is already idle by the time a replacement
    // question set renders into this same instance.
  }

  const select = (q: QuestionSpec, label: string) => {
    setState((prev) => {
      const s = prev[q.id] ?? { chosen: [], otherActive: false, otherText: "" }
      if (q.multi_select) {
        const has = s.chosen.includes(label)
        return {
          ...prev,
          [q.id]: {
            ...s,
            chosen: has
              ? s.chosen.filter((l) => l !== label)
              : [...s.chosen, label],
          },
        }
      }
      // Single-select: picking a real option clears "Other".
      return { ...prev, [q.id]: { ...s, chosen: [label], otherActive: false } }
    })
    // A single-select pick advances to the next question so a multi-question set
    // reads as a guided sequence. Multi-select must not jump (you may pick
    // several); toggling "Other" must not jump (you still need to type).
    if (!q.multi_select) {
      const idx = questions.findIndex((x) => x.id === q.id)
      const next = questions[idx + 1]
      if (next) setActiveId(next.id)
    }
  }

  const toggleOther = (q: QuestionSpec) => {
    setState((prev) => {
      const s = prev[q.id] ?? { chosen: [], otherActive: false, otherText: "" }
      const nextActive = !s.otherActive
      return {
        ...prev,
        [q.id]: {
          ...s,
          otherActive: nextActive,
          // Single-select: turning on "Other" clears real options.
          chosen: q.multi_select ? s.chosen : nextActive ? [] : s.chosen,
        },
      }
    })
  }

  const setOtherText = (q: QuestionSpec, text: string) => {
    setState((prev) => {
      const s = prev[q.id] ?? { chosen: [], otherActive: false, otherText: "" }
      return { ...prev, [q.id]: { ...s, otherActive: true, otherText: text } }
    })
  }

  // Single-select: re-clicking the chosen option clears it. radix never fires
  // onValueChange for the already-selected value, so this is wired via onClick.
  const clearChosen = (q: QuestionSpec) => {
    setState((prev) => {
      const s = prev[q.id] ?? { chosen: [], otherActive: false, otherText: "" }
      return { ...prev, [q.id]: { ...s, chosen: [] } }
    })
  }

  // Single-select picks flow through the shared RadioGroup using index-based
  // radix values ("0", "1", …) so a real option whose label happens to equal the
  // "Other" sentinel can never collide with it. The sentinel turns on free text
  // (no advance); a real index selects its option by verbatim label + advances.
  const onRadioChange = (q: QuestionSpec, value: string) => {
    if (value === OTHER_VALUE) {
      // radix never fires this when "Other" is already the value, so toggleOther
      // only ever switches it on here.
      toggleOther(q)
      return
    }
    const opt = q.options[Number(value)]
    if (opt) select(q, opt.label)
  }

  // Run an answer/skip round-trip, holding the card in an in-flight state until
  // it resolves. On success the backend's `question_resolved` clears
  // `pendingAskQuestion`, which unmounts this card — so we intentionally stay
  // disabled rather than flash the controls back on. On failure we re-enable and
  // surface a retryable error instead of swallowing it.
  const run = async (answer: QuestionAnswer) => {
    if (inFlight.current) return
    inFlight.current = true
    setSubmitting(true)
    setError(false)
    try {
      await onAnswer(question.question_id, answer)
      // Clear the re-entrancy guard on success too (symmetric with the catch).
      // The card normally unmounts here, but if this instance is reused for the
      // next question the guard must not stay latched. `submitting` stays true so
      // the controls don't flash back on before the unmount/replacement.
      inFlight.current = false
    } catch {
      setError(true)
      setSubmitting(false)
      inFlight.current = false
      // Collapsing mid-flight hides the footer, and with it the retry and the
      // error line — a failed answer to a still-blocking question would be
      // silent. Come back out so the failure is where the user can see it.
      setCollapsed(false)
    }
  }

  const submit = () => {
    const answers = questions.map((q) => {
      const s = state[q.id]
      const labels = [...(s?.chosen ?? [])]
      if (s?.otherActive && s.otherText.trim()) labels.push(s.otherText.trim())
      return { questionId: q.id, labels }
    })
    void run({ answers, declined: false })
  }

  const skip = () => void run({ answers: [], declined: true })

  const isMulti = questions.length > 1
  // The read-only/answered view passes an empty subtitle; with no second line the
  // header row centers the icon, title and count instead of top-aligning them.
  const resolvedSubtitle = subtitle ?? t("subtitle")
  const activeIndex = questions.findIndex((q) => q.id === activeId)
  const nextId =
    activeIndex >= 0 && activeIndex < questions.length - 1
      ? questions[activeIndex + 1].id
      : null

  // Every control is inert while a live answer is in flight (`submitting`) and in
  // the read-only/answered view (`readOnly`). Tabs stay navigable in both.
  const locked = submitting || readOnly

  // A selectable option card: the radix control state colors the card. The
  // accent comes from our own selection state (not a radix data-attribute) so it
  // is reliable regardless of the primitive's styling internals. The read-only
  // view keeps the selection crisp (no opacity dim) so the answer stands out.
  const cardClass = (selected: boolean) =>
    cn(
      "flex w-full items-start gap-2.5 rounded-lg border p-2.5 font-normal transition-colors",
      selected ? "border-primary bg-primary/10" : "border-border/60",
      submitting && "cursor-not-allowed opacity-60",
      readOnly && !submitting && "cursor-default",
      !submitting && !readOnly && "cursor-pointer",
      !selected && !submitting && !readOnly && "hover:bg-muted/40"
    )

  const optionBody = (
    text: string,
    recommended: boolean,
    description?: string
  ) => (
    <span className="min-w-0 flex-1">
      <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
        {text}
        {recommended && (
          <Badge variant="secondary" className="text-3xs">
            {t("recommended")}
          </Badge>
        )}
      </span>
      {description && (
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {description}
        </span>
      )}
    </span>
  )

  // The options + free-text "Other" block for one question, reused by the
  // single-question layout and each tab panel.
  const renderOptions = (q: QuestionSpec) => {
    const s = state[q.id]
    const otherId = `${q.id}-other`
    // Secret questions (codex marks API keys etc. with `is_secret`) mask the
    // typed answer.
    const inputType = q.is_secret ? "password" : "text"
    const inputClass =
      "w-full rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-sm outline-none focus:border-ring disabled:cursor-not-allowed disabled:opacity-60"

    // Free-text question (no options — codex elicitation and MCP-server forms
    // ask open questions this way): the text input IS the answer field, always
    // visible, with no "Other" toggle to click through first. Typing marks the
    // question answered (`setOtherText` activates the free-text state).
    if (q.options.length === 0) {
      return (
        <input
          id={otherId}
          type={inputType}
          aria-label={q.question}
          disabled={locked}
          value={s?.otherText ?? ""}
          onChange={(e) => setOtherText(q, e.target.value)}
          placeholder={t("otherPlaceholder")}
          className={inputClass}
        />
      )
    }

    const otherInput = s?.otherActive ? (
      <input
        id={otherId}
        type={inputType}
        autoFocus
        aria-label={t("other")}
        disabled={locked}
        value={s.otherText}
        onChange={(e) => setOtherText(q, e.target.value)}
        placeholder={t("otherPlaceholder")}
        className={inputClass}
      />
    ) : null

    if (q.multi_select) {
      return (
        <div className="space-y-1.5">
          {q.options.map((opt) => {
            const selected = s?.chosen.includes(opt.label) ?? false
            const { text, recommended } = splitRecommended(opt.label)
            return (
              <Label key={opt.label} className={cardClass(selected)}>
                <Checkbox
                  checked={selected}
                  disabled={locked}
                  onCheckedChange={() => select(q, opt.label)}
                  className="mt-0.5"
                />
                {optionBody(text, recommended, opt.description)}
              </Label>
            )
          })}
          <Label className={cardClass(s?.otherActive ?? false)}>
            <Checkbox
              checked={s?.otherActive ?? false}
              disabled={locked}
              onCheckedChange={() => toggleOther(q)}
              className="mt-0.5"
            />
            <span className="text-sm font-medium">{t("other")}</span>
          </Label>
          {otherInput}
        </div>
      )
    }

    const selectedIdx = s?.chosen[0]
      ? q.options.findIndex((o) => o.label === s.chosen[0])
      : -1
    const value = s?.otherActive
      ? OTHER_VALUE
      : selectedIdx >= 0
        ? String(selectedIdx)
        : ""
    return (
      <div className="space-y-1.5">
        <RadioGroup
          value={value}
          onValueChange={(v) => onRadioChange(q, v)}
          disabled={locked}
          className="gap-1.5"
        >
          {q.options.map((opt, i) => {
            const selected = s?.chosen.includes(opt.label) ?? false
            const { text, recommended } = splitRecommended(opt.label)
            return (
              <Label key={opt.label} className={cardClass(selected)}>
                <RadioGroupItem
                  value={String(i)}
                  onClick={() => {
                    if (selected) clearChosen(q)
                  }}
                  className="mt-0.5 data-[state=checked]:border-primary data-[state=checked]:bg-primary"
                />
                {optionBody(text, recommended, opt.description)}
              </Label>
            )
          })}
          <Label className={cardClass(s?.otherActive ?? false)}>
            <RadioGroupItem
              value={OTHER_VALUE}
              onClick={() => {
                if (s?.otherActive) toggleOther(q)
              }}
              className="mt-0.5 data-[state=checked]:border-primary data-[state=checked]:bg-primary"
            />
            <span className="text-sm font-medium">{t("other")}</span>
          </Label>
        </RadioGroup>
        {otherInput}
      </div>
    )
  }

  const questionHeading = (q: QuestionSpec) => (
    <div className="flex items-center gap-2">
      <Badge variant="outline" className="shrink-0 text-3xs">
        {q.multi_select ? t("multiSelect") : t("singleSelect")}
      </Badge>
      <p className="text-sm text-foreground/90">{q.question}</p>
    </div>
  )

  // Defensive: the backend mints a non-empty set and ConversationShell also
  // guards the mount, but never render an empty card — it would show 0/0 and a
  // Submit that posts an empty affirmative answer rather than a decline.
  if (questions.length === 0) return null

  return (
    // Capped to the viewport (header + footer pinned, body scrolls) so a tall set
    // never covers the whole message list and always keeps Submit/Skip reachable.
    // Collapsed, only the header row is left, so the message list gets the space
    // back outright.
    // `overflow-hidden` clips the full-bleed progress bar to the rounded corners.
    <div
      role="group"
      aria-label={title ?? t("title")}
      className={cn(
        "mb-2 flex max-h-[88svh] flex-col overflow-hidden rounded-xl border border-primary/30 bg-card ws-msg-card",
        readOnly ? "shadow-sm" : "shadow-lg"
      )}
    >
      {isMulti && !collapsed && (
        <Progress
          value={(answeredCount / questions.length) * 100}
          aria-label={t("title")}
          aria-valuetext={`${answeredCount}/${questions.length}`}
          className="h-1 shrink-0 rounded-none"
        />
      )}

      <div
        className={cn("flex min-h-0 flex-col gap-3 p-3", collapsed && "p-2")}
      >
        {/* Header. Collapsed, this row IS the card, so it centers on the single
            line rather than top-aligning against a subtitle that is gone. */}
        <div
          className={cn(
            "flex shrink-0 gap-2.5",
            resolvedSubtitle && !collapsed ? "items-start" : "items-center"
          )}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-primary">
            <MessageCircleQuestionMark className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{title ?? t("title")}</p>
            {resolvedSubtitle && !collapsed && (
              <p className="text-xs text-muted-foreground">
                {resolvedSubtitle}
              </p>
            )}
          </div>
          {isMulti && (
            <span className="shrink-0 self-center text-xs tabular-nums text-muted-foreground">
              {`${answeredCount}/${questions.length}`}
            </span>
          )}
          {/* Live card only: the read-only/answered record has its own
              expand/collapse capsule (`AskQuestionResultCard`), so a second
              chevron here would fight it. */}
          {!readOnly && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0 self-center"
              aria-label={collapsed ? t("expand") : t("collapse")}
              aria-expanded={!collapsed}
              title={collapsed ? t("expand") : t("collapse")}
              onClick={() => setCollapsed((v) => !v)}
            >
              {collapsed ? (
                <ChevronUp className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
            </Button>
          )}
        </div>

        {!collapsed &&
          (isMulti ? (
            <Tabs
              value={activeId}
              onValueChange={setActiveId}
              className="flex min-h-0 flex-col gap-2"
            >
              <TabsList className="w-full shrink-0">
                {questions.map((q, i) => {
                  const done = isAnswered(state[q.id])
                  return (
                    <TabsTrigger
                      key={q.id}
                      value={q.id}
                      disabled={submitting}
                      data-answered={done ? "true" : "false"}
                      className="min-w-0 gap-1.5 data-[state=active]:bg-background data-[state=active]:shadow-sm data-[answered=true]:text-primary"
                    >
                      {done ? (
                        <Check className="size-3.5 shrink-0 text-primary" />
                      ) : (
                        <span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-current text-3xs leading-none">
                          {i + 1}
                        </span>
                      )}
                      <span className="truncate">{q.header}</span>
                    </TabsTrigger>
                  )
                })}
              </TabsList>
              {questions.map((q) => (
                <TabsContent
                  key={q.id}
                  value={q.id}
                  style={{ height: bodyHeight }}
                  className="mt-0 flex-none space-y-2.5 overflow-y-auto pr-1"
                >
                  {questionHeading(q)}
                  {renderOptions(q)}
                </TabsContent>
              ))}
            </Tabs>
          ) : (
            <div className="min-h-0 space-y-2.5 overflow-y-auto pr-1">
              {questions.map((q) => (
                <div key={q.id} className="space-y-2.5">
                  {questionHeading(q)}
                  {renderOptions(q)}
                </div>
              ))}
            </div>
          ))}

        {/* Footer — dropped in the read-only/answered view and while collapsed */}
        {!readOnly && !collapsed && (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={skip}
              disabled={submitting}
            >
              {t("skip")}
            </Button>
            <div className="ml-auto flex items-center gap-2">
              {error && (
                <span role="alert" className="text-xs text-destructive">
                  {t("submitError")}
                </span>
              )}
              {isMulti && nextId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setActiveId(nextId)}
                  disabled={submitting}
                >
                  {t("next")}
                  <ChevronRight className="ml-1 size-3.5" />
                </Button>
              )}
              <Button
                size="sm"
                disabled={!complete || submitting}
                onClick={submit}
              >
                {submitting && (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                )}
                {t("submit")}
                {isMulti && (
                  <span className="ml-1 tabular-nums">{`(${answeredCount})`}</span>
                )}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
