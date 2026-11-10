"use client"

/**
 * Where a piece of handed-out work stands on the PR ladder (8.5), and the
 * task card a task's work carries:
 * - `LadderChip`: the rung in a word, on its tone — the work still moving
 *   pulses a dot before it, as the state chips do;
 * - `TaskStrip`: under a task's row, one line of where it stands (the rung,
 *   its branch, its project), what it changed ("+214 −37, 6 files"), a
 *   pull request it reached (and that codeg does not follow it yet), and
 *   [View PR] [Open session] [Stop] — the last while it still moves.
 *
 * The result card carries the strip on the latest news of its work only;
 * the panel's cards carry it always.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { GitBranch } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { useBotId } from "@/contexts/personal-agent-context"
import { personalAgentDispatchStop } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { openInSystemBrowser } from "@/lib/link-open"
import type { DispatchInfo, Ladder } from "@/lib/types"
import { cn } from "@/lib/utils"

import { canOpenWork, useOpenWork, usePageScope, workTargetOf } from "./shared"

const LADDERS: readonly Ladder[] = [
  "working",
  "waiting_you",
  "mergeable",
  "merging",
  "pr_open",
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
    case "merging":
      return "bg-sky-500/15 text-sky-700 dark:text-sky-300"
    case "waiting_you":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300"
    case "mergeable":
      return "bg-teal-500/15 text-teal-700 dark:text-teal-300"
    case "pr_open":
      return "bg-violet-500/15 text-violet-700 dark:text-violet-300"
    case "merged":
    case "done":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
    case "failed":
      return "bg-red-500/15 text-red-700 dark:text-red-300"
    default:
      return "bg-muted text-muted-foreground"
  }
}

export function LadderChip({ ladder }: { ladder: Ladder | null }) {
  const t = useTranslations("PersonalAgent.ladder")
  if (!ladder) return null
  const moving = ladder === "working" || ladder === "merging"
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
      {t(ladder)}
    </span>
  )
}

/** The task card's strip, under a task's row. `chip` draws the rung on its
 *  first line — left out where the row above says it already. */
export function TaskStrip({
  d,
  chip = false,
}: {
  d: DispatchInfo
  chip?: boolean
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
  const live = LIVE_LADDERS.has(d.ladder)
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
  const where = [task.branch, d.folder_name].filter(Boolean)
  return (
    <div
      data-pa-task-strip
      className="mt-2 flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground"
    >
      {chip || where.length > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          {chip ? <LadderChip ladder={d.ladder} /> : null}
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
          {task.branch && d.folder_name ? <span aria-hidden>·</span> : null}
          {d.folder_name ? (
            <span className="min-w-0 truncate">{d.folder_name}</span>
          ) : null}
        </div>
      ) : null}
      {diff ? (
        <div data-pa-task-diff className="tabular-nums">
          {diff}
        </div>
      ) : null}
      {d.ladder === "pr_open" ? (
        <div data-pa-task-pr>
          <span className="text-foreground">{t("prOpened")}</span>
          <span aria-hidden> · </span>
          <span>{t("prNotTracked")}</span>
        </div>
      ) : null}
      {task.pr_url || canOpen || (live && !readOnly) ? (
        <div className="flex flex-wrap gap-1">
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
          {canOpen ? (
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
              variant="ghost"
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
