"use client"

/**
 * Where a piece of handed-out work stands on the PR ladder (8.5), and the
 * task card a task's work carries:
 * - `LadderChip`: the rung in a word, on its tone — the work still moving
 *   pulses a dot before it, as the state chips do;
 * - `TaskStrip`: under a task's row, one line of where it stands (the rung,
 *   its branch, its project), what it changed ("+214 −37, 6 files"), the
 *   pull request it reached as the watch last read it (its checks, its
 *   head; "may be out of date" when the read is old or held back), and
 *   [View PR] [Open session] [Stop] — the last while it still moves.
 *
 * The result card carries the strip on the latest news of its work only;
 * the panel's cards carry it always.
 */

import { useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { GitBranch } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { useBotId } from "@/contexts/personal-agent-context"
import { personalAgentDispatchStop } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { openInSystemBrowser } from "@/lib/link-open"
import type { DispatchInfo, Ladder, PrFacts } from "@/lib/types"
import { cn } from "@/lib/utils"

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

/** A rung as a tone, as the state chips have theirs: moving sky, waiting
 *  on the owner amber, ready to merge teal, a pull request violet, finished
 *  green, failed red, the rest quiet. */
export function ladderTone(ladder: Ladder): string {
  switch (ladder) {
    case "working":
    case "checking":
    case "merging":
    case "waiting_checks":
      return "bg-sky-500/15 text-sky-700 dark:text-sky-300"
    case "waiting_you":
    case "stuck":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300"
    case "mergeable":
      return "bg-teal-500/15 text-teal-700 dark:text-teal-300"
    case "pr_open":
      return "bg-violet-500/15 text-violet-700 dark:text-violet-300"
    case "merged":
    case "done":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
    case "failed":
    case "checks_failed":
      return "bg-red-500/15 text-red-700 dark:text-red-300"
    default:
      return "bg-muted text-muted-foreground"
  }
}

export function LadderChip({
  ladder,
  pr,
}: {
  ladder: Ladder | null
  pr?: PrFacts | null
}) {
  const t = useTranslations("PersonalAgent.ladder")
  if (!ladder) return null
  const moving =
    ladder === "working" ||
    ladder === "checking" ||
    ladder === "merging" ||
    ladder === "waiting_checks"
  return (
    <span
      data-pa-ladder={ladder}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[0.6875rem] font-medium whitespace-nowrap",
        ladderTone(ladder)
      )}
    >
      {moving ? (
        <span
          aria-hidden
          className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
        />
      ) : null}
      {ladder === "waiting_checks" && pr && pr.checks_known && pr.total > 0
        ? t("waiting_checks_n", { passed: pr.passed, total: pr.total })
        : t(ladder)}
    </span>
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

/** The task card's strip, under a task's row. `chip` draws the rung on its
 *  first line — left out where the row above says it already. `compact`,
 *  on the side panel's rows: the branch and what it changed on one line,
 *  without the project (the row's line says it) or [Open session] (the
 *  row itself opens it). */
export function TaskStrip({
  d,
  chip = false,
  compact = false,
}: {
  d: DispatchInfo
  chip?: boolean
  compact?: boolean
}) {
  const t = useTranslations("PersonalAgent.taskCard")
  const botId = useBotId()
  const { readOnly } = usePageScope()
  const openWork = useOpenWork()
  const [stopping, setStopping] = useState(false)
  const task = d.task
  if (!task) return null
  const target = workTargetOf(d)
  const canOpen = canOpenWork(target)
  // A task the board finished — its pull request ready to merge, say — is
  // past stopping.
  const live = LIVE_LADDERS.has(d.ladder) && d.state !== "completed"
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
  const stop = () => {
    setStopping(true)
    personalAgentDispatchStop(botId, d.id)
      .then((stopped) => {
        if (!stopped) toast.message(t("pastStopping"))
      })
      .catch((e) => toast.error(toErrorMessage(e)))
      .finally(() => setStopping(false))
  }
  const folder = compact ? null : d.folder_name
  const where = [task.branch, folder].filter(Boolean)
  const openShown = canOpen && !compact
  return (
    <div
      data-pa-task-strip
      className={cn(
        "flex min-w-0 flex-col text-xs text-muted-foreground",
        compact ? "mt-1 gap-1" : "mt-2 gap-1.5"
      )}
    >
      {chip || where.length > 0 || (compact && diff) ? (
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
          {compact && diff ? (
            <>
              {task.branch ? <span aria-hidden>·</span> : null}
              <span data-pa-task-diff className="shrink-0 tabular-nums">
                {diff}
              </span>
            </>
          ) : null}
        </div>
      ) : null}
      {diff && !compact ? (
        <div data-pa-task-diff className="tabular-nums">
          {diff}
        </div>
      ) : null}
      <PrLine d={d} />
      {task.pr_url || openShown || (live && !readOnly) ? (
        <div
          className={cn("flex flex-wrap", compact ? "mt-1 gap-1.5" : "gap-1")}
        >
          {task.pr_url ? (
            <Button
              size="xs"
              variant="outline"
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
          {openShown ? (
            <Button
              size="xs"
              variant="ghost"
              data-pa-task-act="open"
              onClick={() => openWork(target)}
            >
              {t("openSession")}
            </Button>
          ) : null}
          {live && !readOnly ? (
            <Button
              size="xs"
              variant={compact ? "outline" : "ghost"}
              data-pa-task-act="stop"
              disabled={stopping}
              className="text-destructive hover:text-destructive"
              onClick={stop}
            >
              {t("stop")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
