"use client"

/**
 * Answering one of an assistant's questions from its conversation (C1,
 * [Answer] on the activity): the bar over the input box that says which
 * question the next message answers, and how that question stands as the
 * activity last read it — the bar goes once it can no longer be answered.
 */

import { useTranslations } from "next-intl"
import { MessageCircleQuestionMark, X } from "lucide-react"

import type { ActivityRow, PersonalAgentActivity } from "@/lib/types"
import { cn } from "@/lib/utils"
import { usePersonalAgentActivity } from "@/stores/personal-agent-activity-store"

/** The question the next message answers. */
export interface AnsweringQuestion {
  itemId: number
  summary: string
}

/** How a question being answered stands: still the owner's to answer,
 *  answered already (from another window), settled, or not in what was
 *  read. */
export type AnswerStanding = "open" | "answered" | "ended" | "unknown"

function standingIn(
  view: PersonalAgentActivity | null,
  itemId: number
): AnswerStanding {
  if (!view) return "unknown"
  const rows: ActivityRow[] = [
    ...view.needs,
    ...view.watching,
    ...view.next,
    ...view.done,
  ]
  for (const r of rows) {
    if (r.today?.kind === "matter_closed" && r.today.item_id === itemId)
      return "ended"
    const item = r.item
    if (!item || item.id !== itemId) continue
    if (item.status === "done" || item.status === "dropped") return "ended"
    if (item.waits_for === "agent" && item.answer_state === "linked")
      return "answered"
    return "open"
  }
  return "unknown"
}

/** How question `itemId` stands in the activity as it was last read, on
 *  any page that holds it. */
export function useAnswerStanding(
  itemId: number | null,
  bot: number | null
): AnswerStanding {
  return usePersonalAgentActivity((s) => {
    if (itemId == null || bot == null) return "unknown"
    let found: AnswerStanding = "unknown"
    for (const read of Object.values(s.reads)) {
      const here = standingIn(read.view, itemId)
      if (here === "open") return "open"
      if (here !== "unknown") found = here
    }
    return found
  })
}

/** Over the input box: "Answer: <the question>", and × to send the message
 *  as a plain one. */
export function AnswerBar({
  question,
  onDismiss,
  className,
}: {
  question: AnsweringQuestion
  onDismiss: () => void
  className?: string
}) {
  const t = useTranslations("PersonalAgent.answer")
  return (
    <div
      className={cn("flex min-w-0 items-center gap-1", className)}
      data-pa-answer-bar={question.itemId}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border-s-2 border-primary/45 bg-foreground/[0.045] px-2 py-1.5 text-xs leading-snug">
        <MessageCircleQuestionMark
          aria-hidden
          className="size-3.5 shrink-0 text-primary/80"
        />
        <span className="min-w-0 truncate text-foreground/85">
          {t("bar", { question: question.summary })}
        </span>
      </span>
      <button
        type="button"
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        onClick={onDismiss}
        title={t("dismiss")}
        aria-label={t("dismiss")}
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  )
}

/** On the owner's own message: the question it answered. */
export function AnswerLabel({ summary }: { summary: string }) {
  const t = useTranslations("PersonalAgent.answer")
  return (
    <span
      className="flex min-w-0 items-center gap-1 text-[0.6875rem] leading-4 text-muted-foreground"
      data-pa-answer-label
    >
      <MessageCircleQuestionMark aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 truncate">
        {t("label", { question: summary })}
      </span>
    </span>
  )
}
