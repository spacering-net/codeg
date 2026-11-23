"use client"

/**
 * The small pieces of acceptance (7.5) other cards show:
 * - `VerdictChip`: what a check found, on its tone;
 * - `DoneWhen`: the assistant's acceptance criteria, on the work it handed
 *   out;
 * - `CheckLabel`: the line that says a piece of work is the acceptance check
 *   of another — which round.
 */

import { useTranslations } from "next-intl"

import type { CheckVerdict } from "@/lib/types"
import { cn } from "@/lib/utils"

const VERDICTS: readonly CheckVerdict[] = ["pass", "fail", "unverified"]

export function asVerdict(v: unknown): CheckVerdict | null {
  return typeof v === "string" && VERDICTS.includes(v as CheckVerdict)
    ? (v as CheckVerdict)
    : null
}

/** A verdict as a tone: passed green, failed red, unverified amber. */
export function verdictTone(v: CheckVerdict | null): string {
  switch (v) {
    case "pass":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
    case "fail":
      return "bg-red-500/15 text-red-700 dark:text-red-300"
    default:
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300"
  }
}

export function VerdictChip({ verdict }: { verdict: CheckVerdict | null }) {
  const t = useTranslations("PersonalAgent.acceptance.verdict")
  return (
    <span
      data-pa-verdict={verdict ?? "unverified"}
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[0.6875rem] font-medium whitespace-nowrap",
        verdictTone(verdict)
      )}
    >
      {t(verdict ?? "unverified")}
    </span>
  )
}

/** The assistant's acceptance criteria, as it wrote them. */
export function DoneWhen({
  text,
  className,
}: {
  text: string | null | undefined
  className?: string
}) {
  const t = useTranslations("PersonalAgent.dispatchCard")
  const body = text?.trim()
  if (!body) return null
  return (
    <div
      data-pa-done-when
      className={cn("text-xs leading-5 text-muted-foreground", className)}
    >
      <span className="font-medium text-foreground/80">{t("doneWhen")}</span>
      <p className="break-words whitespace-pre-line">{body}</p>
    </div>
  )
}

/** "Acceptance check · round 2". */
export function CheckLabel({
  round,
  className,
}: {
  round: number | null
  className?: string
}) {
  const t = useTranslations("PersonalAgent.dispatchCard")
  return (
    <p
      data-pa-check-label={round ?? ""}
      className={cn("text-xs text-muted-foreground", className)}
    >
      {round != null ? t("checkRound", { round }) : t("check")}
    </p>
  )
}
