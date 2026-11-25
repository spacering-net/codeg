"use client"

/**
 * Where a piece of handed-out work stands on the PR ladder (8.5), and the
 * task card a task's work carries:
 * - `LadderChip`: the rung in a word, on its tone — the work still moving
 *   pulses a dot before it, as the state chips do;
 * - `TaskStrip`: under a task's row, one line of where it stands (the rung,
 *   its branch, its project), what it changed ("+214 −37, 6 files"), the
 *   pull request it reached as the watch last read it (its checks, its
 *   head; "may be out of date" when the read is old or held back);
 * - `TaskActions`: [View PR] [Open session] [Stop] — the last while it
 *   still moves — on its card's last band.
 *
 * The result card carries the strip on the latest news of its work only;
 * the panel's cards carry it always.
 */

import { useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { GitBranch, Square } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { useBotId } from "@/contexts/personal-agent-context"
import { personalAgentDispatchStop } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { openInSystemBrowser } from "@/lib/link-open"
import type { DispatchInfo, Ladder, PrFacts } from "@/lib/types"
import { cn } from "@/lib/utils"

import { BranchChip } from "./aux-parts/kit/branch-chip"
import { StatusPill, type PillTone } from "./aux-parts/kit/status-pill"
import { canOpenWork, useOpenWork, usePageScope, workTargetOf } from "./shared"

const LADDERS: readonly Ladder[] = [
  "working",
  "waiting_you",
  "checking",
  "mergeable",
  "merging",
  "pr_open",
  "waiting_checks",
  "checks_failed",
  "stuck",
  "pr_closed",
  "merged",
  "done",
  "failed",
  "paused",
  "canceled",
  "handed_over",
]

/** The rungs of work still moving (or waiting) that [Stop] stops: one
 *  the board is merging is past stopping. */
export const LIVE_LADDERS: ReadonlySet<Ladder> = new Set<Ladder>([
  "working",
  "waiting_you",
  "checking",
  "mergeable",
])

export function asLadder(v: unknown): Ladder | null {
  return typeof v === "string" && LADDERS.includes(v as Ladder)
    ? (v as Ladder)
    : null
}

/** A rung as a pill's tone: moving sky, waiting on the owner amber, ready
 *  to merge teal, a pull request violet, finished green, failed red, the
 *  rest quiet. */
export function ladderPillTone(ladder: Ladder): PillTone {
  switch (ladder) {
    case "working":
    case "checking":
    case "merging":
    case "waiting_checks":
      return "sky"
    case "waiting_you":
    case "stuck":
      return "amber"
    case "mergeable":
      return "teal"
    case "pr_open":
      return "violet"
    case "merged":
    case "done":
      return "green"
    case "failed":
    case "checks_failed":
      return "red"
    default:
      return "muted"
  }
}

/** The rungs still moving: their pill pulses. */
const MOVING_LADDERS: ReadonlySet<Ladder> = new Set<Ladder>([
  "working",
  "checking",
  "merging",
  "waiting_checks",
])

export function LadderChip({
  ladder,
  pr,
}: {
  ladder: Ladder | null
  pr?: PrFacts | null
}) {
  const t = useTranslations("PersonalAgent.ladder")
  if (!ladder) return null
  return (
    <StatusPill
      data-pa-ladder={ladder}
      tone={ladderPillTone(ladder)}
      pulse={MOVING_LADDERS.has(ladder)}
    >
      {ladder === "waiting_checks" && pr && pr.checks_known && pr.total > 0
        ? t("waiting_checks_n", { passed: pr.passed, total: pr.total })
        : t(ladder)}
    </StatusPill>
  )
}

/** The rungs of work delivered as a pull request. */
const PR_LADDERS: ReadonlySet<Ladder> = new Set<Ladder>([
  "pr_open",
  "waiting_checks",
  "checks_failed",
  "stuck",
  "pr_closed",
])

/** What the watch last read of a task's pull request, in a line — and,
 *  when that may be out of date, a second one saying so. */
function PrLine({ d }: { d: DispatchInfo }) {
  const t = useTranslations("PersonalAgent.taskCard")
  const format = useFormatter()
  const pr = d.task?.pr ?? null
  const delivered =
    PR_LADDERS.has(d.ladder) ||
    (pr != null && (d.ladder === "mergeable" || d.ladder === "merged"))
  if (!delivered) return null
  if (!pr) {
    return (
      <div data-pa-task-pr>
        <span className="text-foreground">{t("prOpened")}</span>
        <span aria-hidden> · </span>
        <span>{t("prNotTracked")}</span>
      </div>
    )
  }
  const time = pr.last_read_at
    ? format.dateTime(new Date(pr.last_read_at), {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null
  const parts: string[] = []
  if (pr.phase !== "merged" && pr.phase !== "closed") {
    if (!pr.checks_known) parts.push(t("prChecksUnknown"))
    else if (pr.total === 0) parts.push(t("prNoChecks"))
    else {
      parts.push(t("prChecks", { passed: pr.passed, total: pr.total }))
      if (pr.failed > 0) parts.push(t("prChecksFailed", { n: pr.failed }))
      if (pr.pending > 0) parts.push(t("prChecksRunning", { n: pr.pending }))
    }
    if (pr.phase === "open" && pr.merge_state)
      parts.push(t("prWaitsOnForge", { state: pr.merge_state }))
    if (pr.phase === "no_conflict") parts.push(t("prNoConflict"))
  }
  if (pr.head) parts.push(t("prHead", { head: pr.head }))
  if (!pr.watching && pr.phase !== "merged" && pr.phase !== "closed")
    parts.push(t("prNotWatched"))
  return (
    <div data-pa-task-pr data-pa-task-pr-phase={pr.phase ?? ""}>
      {parts.length > 0 ? (
        <div className="tabular-nums">{parts.join(" · ")}</div>
      ) : null}
      {pr.stale && time ? (
        <div
          data-pa-task-pr-stale
          className="text-amber-700 dark:text-amber-300"
        >
          {t("prStale", { time })}
        </div>
      ) : null}
    </div>
  )
}

/** The task card's strip, under a task's row: where it stands, what it
 *  changed, its pull request — its buttons on the card's last band
 *  (`TaskActions`). `chip` draws the rung on its first line — left out
 *  where the row above says it already. `compact`,
 *  on the side panel's cards: the branch a chip and what it changed after
 *  it on one line, without the project (the card's line says it) or [Open
 *  session] (the card itself opens it); its buttons a size up, [Stop]
 *  (`TaskStopButton`) at the row's end. */
export function TaskStrip({
  d,
  chip = false,
  compact = false,
  stop: withStop = true,
  bot,
}: {
  d: DispatchInfo
  chip?: boolean
  compact?: boolean
  /** [Stop] on it (`compact`): not where the card has a row of buttons
   *  it goes on instead (`TaskStopButton`). */
  stop?: boolean
  /** The assistant the work is of, when it is not the page's (another's
   *  row on the primary's activity): what stopping it goes to. */
  bot?: number | null
}) {
  const t = useTranslations("PersonalAgent.taskCard")
  const stoppable = useTaskStoppable(d)
  const task = d.task
  if (!task) return null
  const diffTags = {
    add: (chunks: React.ReactNode) => (
      <span className="text-emerald-700 dark:text-emerald-400">{chunks}</span>
    ),
    del: (chunks: React.ReactNode) => (
      <span className="text-red-700 dark:text-red-400">{chunks}</span>
    ),
  }
  const diff =
    task.additions != null && task.deletions != null
      ? task.files_changed != null
        ? t.rich("diff", {
            added: task.additions,
            removed: task.deletions,
            files: task.files_changed,
            ...diffTags,
          })
        : t.rich("diffOnly", {
            added: task.additions,
            removed: task.deletions,
            ...diffTags,
          })
      : null
  const prButton = task.pr_url ? (
    <Button
      size="sm"
      variant="outline"
      data-pa-task-act="pr"
      onClick={() => {
        const url = task.pr_url
        if (url)
          openInSystemBrowser(url).catch((e) => toast.error(toErrorMessage(e)))
      }}
    >
      {t("viewPr")}
    </Button>
  ) : null
  if (compact) {
    // The side panel's: the branch a chip and what it changed after it on
    // one line, [Stop] at its end; with a pull request, [View PR] and
    // [Stop] a line of their own under it.
    const stopButton =
      withStop && stoppable ? (
        <TaskStopButton d={d} bot={bot} className="ms-auto" />
      ) : null
    return (
      <div
        data-pa-task-strip
        className="flex min-w-0 flex-col gap-2 text-xs text-muted-foreground"
      >
        {task.branch || diff || (stopButton && !prButton) ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {task.branch ? <BranchChip branch={task.branch} /> : null}
            {diff ? (
              <span data-pa-task-diff className="shrink-0 tabular-nums">
                {diff}
              </span>
            ) : null}
            {prButton ? null : stopButton}
          </div>
        ) : null}
        <PrLine d={d} />
        {prButton ? (
          <div className="flex flex-wrap items-center gap-2">
            {prButton}
            {stopButton}
          </div>
        ) : null}
      </div>
    )
  }
  const folder = d.folder_name
  const where = [task.branch, folder].filter(Boolean)
  return (
    <div
      data-pa-task-strip
      className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground"
    >
      {chip || where.length > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          {chip ? <LadderChip ladder={d.ladder} pr={task.pr} /> : null}
          {task.branch ? (
            <span
              data-pa-task-branch
              className="inline-flex min-w-0 items-center gap-1 font-mono"
            >
              <GitBranch className="size-3 shrink-0" aria-hidden />
              <span className="truncate" dir="ltr">
                {task.branch}
              </span>
            </span>
          ) : null}
          {task.branch && folder ? <span aria-hidden>·</span> : null}
          {folder ? <span className="min-w-0 truncate">{folder}</span> : null}
        </div>
      ) : null}
      {diff ? (
        <div data-pa-task-diff className="tabular-nums">
          {diff}
        </div>
      ) : null}
      <PrLine d={d} />
    </div>
  )
}

/** Whether a task's work can be stopped from here: still moving or
 *  waiting — one the board finished (its pull request ready to merge, say)
 *  is past stopping — on a page that runs here. */
export function useTaskStoppable(d: DispatchInfo | null): boolean {
  const { readOnly } = usePageScope()
  return (
    d?.task != null &&
    !readOnly &&
    LIVE_LADDERS.has(d.ladder) &&
    d.state !== "completed"
  )
}

/** [Stop] on a side panel's card: red words on an outlined button, as
 *  quiet as the buttons next to it until hovered. Nothing when the work
 *  cannot be stopped (`useTaskStoppable`). */
export function TaskStopButton({
  d,
  bot,
  className,
}: {
  d: DispatchInfo
  /** The assistant the work is of, when it is not the page's. */
  bot?: number | null
  className?: string
}) {
  const t = useTranslations("PersonalAgent.taskCard")
  const pageBot = useBotId()
  const botId = bot !== undefined ? bot : pageBot
  const stoppable = useTaskStoppable(d)
  const [stopping, setStopping] = useState(false)
  if (!stoppable) return null
  const stop = () => {
    setStopping(true)
    personalAgentDispatchStop(botId, d.id)
      .then((stopped) => {
        if (!stopped) toast.message(t("pastStopping"))
      })
      .catch((e) => toast.error(toErrorMessage(e)))
      .finally(() => setStopping(false))
  }
  return (
    <Button
      size="sm"
      variant="outline"
      data-pa-task-act="stop"
      disabled={stopping}
      className={cn(
        "text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-400/10 dark:hover:text-red-300",
        className
      )}
      onClick={stop}
    >
      <Square aria-hidden className="size-2.5 fill-current" />
      {t("stop")}
    </Button>
  )
}

/** Whether the task card has a button to show: a pull request to view, a
 *  session to open, work to stop. */
export function hasTaskActions(d: DispatchInfo, readOnly: boolean): boolean {
  const task = d.task
  if (!task) return false
  const live = LIVE_LADDERS.has(d.ladder) && d.state !== "completed"
  return (
    task.pr_url != null || canOpenWork(workTargetOf(d)) || (live && !readOnly)
  )
}

/** The task card's buttons, on its card's last band (`SheetActions`):
 *  [View PR] [Open session] [Stop] — the last while the work still moves.
 *  Nothing when there is none. */
export function TaskActions({ d }: { d: DispatchInfo }) {
  const t = useTranslations("PersonalAgent.taskCard")
  const botId = useBotId()
  const { readOnly } = usePageScope()
  const openWork = useOpenWork()
  const [stopping, setStopping] = useState(false)
  const task = d.task
  if (!task) return null
  const target = workTargetOf(d)
  const canOpen = canOpenWork(target)
  const live = LIVE_LADDERS.has(d.ladder) && d.state !== "completed"
  if (!hasTaskActions(d, readOnly)) return null
  const stop = () => {
    setStopping(true)
    personalAgentDispatchStop(botId, d.id)
      .then((stopped) => {
        if (!stopped) toast.message(t("pastStopping"))
      })
      .catch((e) => toast.error(toErrorMessage(e)))
      .finally(() => setStopping(false))
  }
  return (
    <>
      {task.pr_url ? (
        <Button
          size="sm"
          variant="secondary"
          data-pa-task-act="pr"
          onClick={() => {
            const url = task.pr_url
            if (url)
              openInSystemBrowser(url).catch((e) =>
                toast.error(toErrorMessage(e))
              )
          }}
        >
          {t("viewPr")}
        </Button>
      ) : null}
      {canOpen ? (
        <Button
          size="sm"
          variant="secondary"
          data-pa-task-act="open"
          onClick={() => openWork(target)}
        >
          {t("openSession")}
        </Button>
      ) : null}
      {live && !readOnly ? (
        <Button
          size="sm"
          variant="destructive"
          data-pa-task-act="stop"
          disabled={stopping}
          onClick={stop}
        >
          {t("stop")}
        </Button>
      ) : null}
    </>
  )
}
