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

const OUTCOME_TONE: Record<RoutineRunOutcome, string> = {
  running: "bg-primary/10 text-primary",
  asked: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  reported: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  silent: "bg-muted text-muted-foreground",
  skipped: "bg-muted text-muted-foreground",
  missed: "bg-muted text-muted-foreground",
  declined: "bg-muted text-muted-foreground",
  stopped: "bg-muted text-muted-foreground",
  failed: "bg-red-500/10 text-red-700 dark:text-red-300",
}

/** How a run went, as a chip. */
export function OutcomeChip({ outcome }: { outcome: RoutineRunOutcome }) {
  const t = useTranslations("PersonalAgent.routines")
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[11px] leading-none",
        OUTCOME_TONE[outcome] ?? OUTCOME_TONE.silent
      )}
      data-pa-routine-outcome={outcome}
    >
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
