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
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentDispatchStop } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { openInSystemBrowser } from "@/lib/link-open"
import type {
  DispatchInfo,
  DispatchState,
  Ladder,
  PrFacts,
  StoppedBy,
} from "@/lib/types"
import { refreshActivity } from "@/stores/personal-agent-activity-store"
import { useRoster } from "@/stores/personal-agent-roster-store"
import { cn } from "@/lib/utils"

import { BranchChip } from "./aux-parts/kit/branch-chip"
import { StatusPill, type PillTone } from "./aux-parts/kit/status-pill"
import { useActSettle } from "./aux-parts/activity/act-settle"
import {
  canOpenWork,
  useBotName,
  useOpenWork,
  usePageScope,
  workTargetOf,
} from "./shared"

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
  from = "page",
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
  /** Where the strip is: what its [Stop] reads again after it. */
  from?: "activity" | "page"
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
        <WorkStopButton d={d} bot={bot} from={from} className="ms-auto" />
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

/** The states a piece of work can be stopped in. */
const STOPPABLE: ReadonlySet<DispatchState> = new Set<DispatchState>([
  "queued",
  "running",
  "waiting_input",
  "review",
])

/** Whether a piece of work can be stopped from here (5.7) — a board task,
 *  a chat or a session alike: still moving or waiting (one merging is past
 *  stopping), on a page that runs here. */
export function useWorkStoppable(d: DispatchInfo | null): boolean {
  const { readOnly } = usePageScope()
  return workStoppable(d, readOnly)
}

/** {@link useWorkStoppable} for a list that knows whether it is read-only. */
export function workStoppable(
  d: DispatchInfo | null,
  readOnly: boolean
): boolean {
  return (
    d != null && !readOnly && STOPPABLE.has(d.state) && d.ladder !== "merging"
  )
}

/** The old name of {@link useWorkStoppable}. */
export const useTaskStoppable = useWorkStoppable

/** Who stopped a piece of work, as the owner reads it ("You stopped it",
 *  "Dev stopped it: …"). A stop card from before codeg kept who: the
 *  owner's. */
export function useStoppedWords(): (
  by: StoppedBy | string | null | undefined,
  reason: string | null | undefined,
  name: string
) => string {
  const t = useTranslations("PersonalAgent.stopped")
  return (by, reason, name) => {
    switch (by) {
      case "owner_in_session":
        return t("inSession")
      case "owner_on_board":
        return t("onBoard")
      case "agent":
        return reason?.trim()
          ? t("agent", { name, reason: reason.trim() })
          : t("agentPlain", { name })
      default:
        return t("owner")
    }
  }
}

/** [Stop] on a piece of work, wherever it shows — its row on the activity,
 *  its news on the timeline, its pill (5.7): red words on an outlined
 *  button, quiet until hovered. It sends what it read (the work's version,
 *  its board task's run and version): a stale one stops nothing new. Once
 *  stopped it stays off until the work is read again past that stop (here
 *  or in another window: a follow-up there opens it again). Nothing when
 *  the work cannot be stopped. */
export function WorkStopButton({
  d,
  bot,
  className,
  from = "page",
}: {
  d: DispatchInfo
  /** The assistant the work is of, when it is not the page's. */
  bot?: number | null
  className?: string
  /** What reads it again: the activity's list, or the page's dispatches. */
  from?: "activity" | "page"
}) {
  const t = useTranslations("PersonalAgent.taskCard")
  const stoppedWords = useStoppedWords()
  const { botId: pageBot, refetchDispatches } = usePersonalAgent()
  const botId = bot !== undefined ? bot : pageBot
  const stoppable = useWorkStoppable(d)
  const botName = useBotName()
  const roster = useRoster()
  const { agentName } = usePageScope()
  // The assistant the work is of, by name: the page's own, or another's as
  // the roster names it.
  const whose = () => {
    if (bot == null || bot === pageBot) return agentName
    const entry = roster?.find((e) => e.id === bot)
    return botName(entry ?? { id: bot, kind: "worker" })
  }
  const reread = () => {
    if (from === "activity") refreshActivity()
    else void refetchDispatches?.([d.id])
  }
  const settle = useActSettle(`dispatch:${d.id}`, d.updated_at, reread)
  const [stopping, setStopping] = useState(false)
  if (!stoppable) return null
  const stop = () => {
    setStopping(true)
    personalAgentDispatchStop(botId, d.id, {
      updatedAt: d.updated_at,
      runSeq: d.task?.run_seq ?? null,
      taskUpdatedAt: d.task?.updated_at ?? null,
    })
      .then((reply) => {
        switch (reply.outcome) {
          case "stopped":
            if (reply.updated_at) settle.waitFor({ atLeast: reply.updated_at })
            break
          case "already_stopped":
            toast.message(
              t("alreadyStopped", {
                who: stoppedWords(reply.by, reply.reason, whose()),
              })
            )
            reread()
            break
          case "changed":
            toast.message(t("changed"))
            reread()
            break
          case "board_refused":
            toast.message(t("boardRefused"))
            break
          default:
            toast.message(t("pastStopping"))
        }
      })
      .catch((e) => toast.error(toErrorMessage(e)))
      .finally(() => setStopping(false))
  }
  return (
    <Button
      size="sm"
      variant="outline"
      data-pa-task-act="stop"
      disabled={stopping || settle.waiting}
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

/** The old name of {@link WorkStopButton}. */
export const TaskStopButton = WorkStopButton

/** Whether the task card has a button of its own to show: a pull request
 *  to view, a session to open. ([Stop] is the card's, for any work:
 *  `WorkStopButton`.) */
export function hasTaskActions(d: DispatchInfo): boolean {
  const task = d.task
  if (!task) return false
  return task.pr_url != null || canOpenWork(workTargetOf(d))
}

/** The task card's buttons, on its card's last band (`SheetActions`):
 *  [View PR] [Open session]. Nothing when there is none. */
export function TaskActions({ d }: { d: DispatchInfo }) {
  const t = useTranslations("PersonalAgent.taskCard")
  const openWork = useOpenWork()
  const task = d.task
  if (!task) return null
  const target = workTargetOf(d)
  const canOpen = canOpenWork(target)
  if (!hasTaskActions(d)) return null
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
    </>
  )
}
