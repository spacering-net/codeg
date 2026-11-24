"use client"

/**
 * The work a reply handed out, as pills under its text (`WorkPill`): what
 * each piece is — and, for work handed over from another assistant, that
 * one's name — how it stands as an icon, and how long it has been going
 * while it runs — read from the
 * dispatch itself, so a pill in an old reply shows today's state, and the
 * same work in two replies (dispatched in one, continued in another) reads
 * the same. A follow-up's pill says so. A pill opens the work's session in
 * the drawer on the right (a task's own, or the conversation a chat or
 * session dispatch runs in); a chevron says it does. The rest — how it
 * runs and where — is the news card's, which comes later in the list.
 * Under a pill, the
 * assistant's acceptance criteria when it wrote them (7.5); over the pill of
 * the check codeg sent out for an acceptance, which round it checks; over a
 * round codeg runs on a watched pull request, which and why (7.4).
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { useElapsedLabel } from "@/hooks/use-elapsed-label"
import type {
  DispatchInfo,
  DispatchState,
  PrFixMark,
  TimelineRow,
} from "@/lib/types"
import { cn } from "@/lib/utils"

import {
  asDispatchState,
  asMode,
  canOpenWork,
  INSET_HOVER,
  num,
  str,
  useOpenWork,
  useOtherAssistant,
  workTargetOf,
} from "./shared"
import { CheckLabel, DoneWhen } from "./acceptance-bits"
import { WorkPill } from "./work-card"

/** Pills shown before the rest fold into "N more". */
const SHOWN_PILLS = 3

function prFixOf(v: unknown): PrFixMark | null {
  if (!v || typeof v !== "object") return null
  const f = v as Partial<PrFixMark>
  return typeof f.label === "string" && typeof f.cause === "string"
    ? (f as PrFixMark)
    : null
}

/** A round codeg runs on a watched pull request: which pull request, why,
 *  and which round of fixing it (7.4). */
function PrFixLabel({
  fix,
  className,
}: {
  fix: PrFixMark
  className?: string
}) {
  const t = useTranslations("PersonalAgent.pr.round")
  const why =
    fix.cause === "conflict"
      ? t("conflict", { n: fix.n })
      : fix.cause === "feedback"
        ? t("feedback")
        : t("checks", { n: fix.n })
  return (
    <p
      className={cn("text-xs text-muted-foreground", className)}
      data-pa-pr-round={fix.cause}
    >
      <span dir="ltr">{fix.label}</span> · {why}
    </p>
  )
}

function useTicking(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [on])
  return now
}

function DispatchPill({
  row,
  info,
}: {
  row: TimelineRow
  info: DispatchInfo | undefined
}) {
  const t = useTranslations("PersonalAgent.dispatchCard")
  const openWork = useOpenWork()
  const otherAssistant = useOtherAssistant()
  const elapsedLabel = useElapsedLabel()
  const data = row.data
  // A follow-up that never went out says so, whatever the work is doing.
  const notSent = data?.failed === true
  const state: DispatchState | null =
    info?.state ?? asDispatchState(data?.state)
  const running = state === "running" && !notSent
  const now = useTicking(running)
  const elapsed =
    running && info ? elapsedLabel(now - Date.parse(info.updated_at)) : null
  const target = workTargetOf(info, row)
  const title = info?.title ?? row.body
  // The acceptance check of other work (7.5): which round.
  const checkFor = info?.check_for ?? num(data, "check_for")
  const checkRound = info?.check_round ?? num(data, "check_round")
  const doneWhen = info?.done_when ?? str(data, "done_when")
  const prFix = prFixOf(data?.pr_fix)
  const pill = (
    <WorkPill
      rowId={row.id}
      state={state}
      notSent={notSent}
      mode={info?.mode ?? asMode(data?.mode)}
      by={otherAssistant(info)}
      title={data?.followup === true ? t("continue", { title }) : title}
      elapsed={elapsed}
      onOpen={canOpenWork(target) ? () => openWork(target) : null}
    />
  )
  if (checkFor == null && !doneWhen && !prFix) return pill
  return (
    <div className="flex max-w-full min-w-0 flex-col items-start gap-1">
      {checkFor != null ? (
        <CheckLabel round={checkRound} className="ps-1" />
      ) : null}
      {prFix ? <PrFixLabel fix={prFix} className="ps-1" /> : null}
      {pill}
      {doneWhen && data?.followup !== true ? (
        <DoneWhen text={doneWhen} className="ps-1" />
      ) : null}
    </div>
  )
}

export function DispatchAttachments({
  rows,
}: {
  rows: readonly TimelineRow[]
}) {
  const t = useTranslations("PersonalAgent.dispatchCard")
  const { dispatchById } = usePersonalAgent()
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? rows : rows.slice(0, SHOWN_PILLS)
  const hidden = rows.length - shown.length
  return (
    <div className="mt-2 flex flex-col items-start gap-1">
      {shown.map((row) => (
        <DispatchPill
          key={row.id}
          row={row}
          info={
            row.dispatch_id != null
              ? dispatchById.get(row.dispatch_id)
              : undefined
          }
        />
      ))}
      {hidden > 0 ? (
        <button
          type="button"
          className={cn(
            "inline-flex h-7 items-center rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            INSET_HOVER
          )}
          onClick={() => setExpanded(true)}
        >
          {t("more", { count: hidden })}
        </button>
      ) : null}
    </div>
  )
}
