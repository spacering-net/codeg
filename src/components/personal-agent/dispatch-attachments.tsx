"use client"

/**
 * The work a reply handed out, as pills under its text (`WorkPill`): who
 * runs each piece (their avatar and name) and what it is, how it stands as
 * an icon, and how long it has been going while it runs — read from the
 * dispatch itself, so a pill in an old reply shows today's state, and the
 * same work in two replies (dispatched in one, continued in another) reads
 * the same. A follow-up's pill says so. A pill opens the work's session in
 * the drawer on the right (a task's own, or the conversation a chat or
 * session dispatch runs in); a chevron says it does. The rest — the agent's
 * mark, the kind of work and where — is the news card's, from the assistant
 * that ran it, which comes later in the list.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { useElapsedLabel } from "@/hooks/use-elapsed-label"
import type { DispatchInfo, DispatchState, TimelineRow } from "@/lib/types"
import { cn } from "@/lib/utils"

import {
  asDispatchState,
  canOpenWork,
  INSET_HOVER,
  num,
  str,
  useOpenWork,
  workTargetOf,
} from "./shared"
import { WorkPill } from "./work-card"

/** Pills shown before the rest fold into "N more". */
const SHOWN_PILLS = 3

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
  return (
    <WorkPill
      rowId={row.id}
      state={state}
      notSent={notSent}
      executorId={info?.executor.assistant_id ?? num(data, "executor_id")}
      executor={info?.executor.name ?? str(data, "executor")}
      title={data?.followup === true ? t("continue", { title }) : title}
      elapsed={elapsed}
      onOpen={canOpenWork(target) ? () => openWork(target) : null}
    />
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
