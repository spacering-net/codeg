"use client"

/**
 * What a routine is, in words (6.9): when it runs — its schedule as the
 * automations say it, or the coding event it runs on — what it looks at
 * first, and how a run went.
 */

import { useLocale, useTranslations } from "next-intl"

import { ScheduleLabel } from "@/components/automations/schedule-label"
import type {
  RoutineDraft,
  RoutineEventSpec,
  RoutinePrecheck,
  RoutineRunOutcome,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/** Its schedule, or the event it runs on, in one line. */
export function RoutineWhen({
  cron,
  event,
  zone,
}: {
  cron: string | null | undefined
  event: RoutineEventSpec | null | undefined
  /** A zone of its own; left out, it runs in the owner's. */
  zone?: string | null
}) {
  const t = useTranslations("PersonalAgent.routines")
  if (cron) {
    return (
      <span data-pa-routine-when="schedule">
        <ScheduleLabel cron={cron} />
        {zone ? (
          <span className="text-muted-foreground"> {t("zone", { zone })}</span>
        ) : null}
      </span>
    )
  }
  if (event) {
    return (
      <span data-pa-routine-when="event">
        {t("onEvent", { event: eventWords(t, event) })}
      </span>
    )
  }
  return null
}

type T = ReturnType<typeof useTranslations<"PersonalAgent.routines">>

/** An event trigger's kind, and its filter, as the owner reads it. */
export function eventWords(t: T, e: RoutineEventSpec): string {
  const known = (
    [
      "dispatch_ended",
      "task_status",
      "session_waiting",
      "pr_checks_failed",
      "pr_checks_passed",
      "pr_conflict",
      "pr_mergeable",
      "pr_no_conflict",
      "pr_merged",
      "pr_closed",
      "pr_review",
      "forge_issue",
    ] as const
  ).find((k) => k === e.kind)
  const base = known ? t(`event.${known}`) : e.kind
  const more: string[] = []
  if (e.states && e.states.length > 0) more.push(e.states.join(", "))
  if (e.label) more.push(t("withLabel", { label: e.label }))
  if (e.mine) more.push(t("mineOnly"))
  return more.length > 0 ? `${base} (${more.join(" · ")})` : base
}

/** What it looks at first, or `null` when it does not. */
export function precheckWords(
  t: T,
  p: RoutinePrecheck | null | undefined
): string | null {
  if (!p || p.kind === "none") return null
  switch (p.kind) {
    case "commits":
      return t("precheck.commits", { branch: p.branch || "HEAD" })
    case "forge_new":
      return p.what === "pr" ? t("precheck.forgePr") : t("precheck.forgeIssue")
    case "items_waiting":
      return t("precheck.itemsWaiting", { hours: p.hours })
    case "changes":
      return t("precheck.changes")
  }
}

/** A run's outcome's colour: a dot, and its word. */
const OUTCOME_TONE: Record<RoutineRunOutcome, { dot: string; text: string }> = {
  running: { dot: "bg-primary", text: "text-primary" },
  asked: {
    dot: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-300",
  },
  reported: {
    dot: "bg-emerald-500",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  silent: { dot: "bg-muted-foreground/40", text: "" },
  skipped: { dot: "bg-muted-foreground/40", text: "" },
  missed: { dot: "bg-muted-foreground/40", text: "" },
  declined: { dot: "bg-muted-foreground/40", text: "" },
  stopped: { dot: "bg-muted-foreground/40", text: "" },
  failed: { dot: "bg-red-500", text: "text-red-700 dark:text-red-300" },
}

/** How a run went, in a word in a quiet line: a dot of its colour, the
 *  word in it when it says something (a report, a failure). */
export function OutcomeWord({ outcome }: { outcome: RoutineRunOutcome }) {
  const t = useTranslations("PersonalAgent.routines")
  const tone = OUTCOME_TONE[outcome] ?? OUTCOME_TONE.silent
  return (
    <span
      className={cn("inline-flex items-center gap-1", tone.text)}
      data-pa-routine-outcome={outcome}
    >
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", tone.dot)}
      />
      {t(`outcome.${outcome}` as "outcome.running")}
    </span>
  )
}

/** A time, near: today's as its clock, else its day and clock. */
export function useWhen(): (iso: string) => string {
  const locale = useLocale()
  return (iso) => {
    const d = new Date(iso)
    const now = new Date()
    const sameDay = d.toDateString() === now.toDateString()
    return sameDay
      ? d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleString(locale, {
          month: "short",
          day: "numeric",
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
  }
}

/** A routine's draft for the editor, from a card's data. */
export function asDraft(v: unknown): RoutineDraft | null {
  if (!v || typeof v !== "object") return null
  return v as RoutineDraft
}
