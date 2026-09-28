"use client"

import { useTranslations } from "next-intl"
import { CircleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { formatRelative } from "@/components/conversations/sidebar-conversation-grouping"
import { cn } from "@/lib/utils"
import {
  isLiveStatus,
  liveNote,
  MergeQueuedChip,
  ScheduleChip,
  statusAccent,
  StatusChip,
  TaskAgentMark,
  WorktreeRemovedChip,
} from "./task-card"
import {
  buildTaskActions,
  type TaskActionHandlers,
  type TaskActionItem,
} from "./task-actions"
import type { WorkTask } from "@/lib/types"

/**
 * The list's column geometry, shared verbatim by the header (TaskList) and
 * every row. EVERY column except the title is fixed-width on purpose: the title
 * is the only flexible one, so it alone absorbs the difference between rows and
 * the remaining columns line up in true vertical rules. Let any of the others
 * size to its content and each row starts its meta at a different x — which is
 * exactly the raggedness a list exists to remove.
 *
 * Columns drop right-to-left as the window narrows: location first, then the
 * diffstat, then the timestamp. The title and the actions are what a row cannot
 * lose.
 */
export const TASK_LIST_CELLS = {
  status: "w-[6.5rem] shrink-0",
  title: "min-w-0 flex-1",
  location: "hidden w-[11rem] shrink-0 overflow-hidden lg:flex",
  changes: "hidden w-[4.5rem] shrink-0 justify-end md:flex",
  updated: "hidden w-[3rem] shrink-0 justify-end sm:flex",
  /** Four 24px buttons with 4px gutters = 108px, the widest action set any
   *  status offers (to-do: start / edit / schedule / session). Icon-only, so
   *  this width is locale-independent — and fixed, so the right edge is a rule
   *  rather than a ragged margin. */
  actions: "w-[7rem] shrink-0 justify-end",
} as const

/** Horizontal rhythm of one list line — header and rows share it. */
export const TASK_LIST_LINE = "flex items-center gap-3 px-3"

interface TaskRowProps extends TaskActionHandlers {
  task: WorkTask
  folderName: string | null
  /** Shared render-tick timestamp for relative times (refreshed by the page). */
  now: number
  /** Place in line when this task is waiting to merge (see `mergeQueueRanks`). */
  mergeQueueRank?: number
  onOpen: () => void
}

/**
 * One list-view row: the same task the board draws as a card, laid out on a
 * single line so many of them can be scanned at once. It carries the same
 * action set the card does (`buildTaskActions`, so the two surfaces cannot
 * drift) — presented differently, because a list has different jobs than a
 * board:
 *
 * - Every action is an icon button, all of them visible at once and all of them
 *   named by a hover tooltip. A list is scanned, not read: at this density the
 *   glyphs are quicker than words, and nothing is one click deeper than
 *   anything else.
 * - They are graded in three steps rather than drawn alike: the primary is
 *   filled ONLY when the task is waiting on the user (review / awaiting input /
 *   failed), outlined otherwise, and the secondaries are ghosts. A column of
 *   identical filled buttons is a wall, not a hierarchy; this way the rows that
 *   need a decision are the ones that catch the eye.
 *
 * A second line appears only when the task has something to say: the error of
 * a failed one, the live progress of a running one, the summary of a reviewed
 * one. Everything else stays in the detail sheet, which the row opens.
 */
export function TaskRow({
  task,
  folderName,
  now,
  mergeQueueRank,
  onOpen,
  ...handlers
}: TaskRowProps) {
  const t = useTranslations("Tasks")
  const archived = task.archived_at != null
  const { primary, secondaries } = buildTaskActions(task, t, handlers)
  // The filled primary is reserved for "this one is waiting on you". An
  // archived task is settled by definition, however it got there.
  const needsUser =
    !archived &&
    (task.status === "review" ||
      task.status === "awaiting_input" ||
      task.status === "failed")

  const showError =
    task.last_error && (task.status === "failed" || task.status === "review")
  const note = showError
    ? task.last_error
    : (liveNote(task, t) ??
      (task.status === "review" ? task.result_summary : null))

  const when = formatRelative(
    task.finished_at ?? task.settled_at ?? task.started_at ?? task.created_at,
    now
  )
  const hasStat = task.files_changed != null && task.files_changed > 0

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        // Only the row's own focus opens the sheet: Enter/Space on a nested
        // action button bubbles up here, and preventing the default would
        // swallow that button's activation and open the sheet instead.
        if (e.target !== e.currentTarget) return
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen()
        }
      }}
      className={cn(
        "group/row relative min-h-[2.875rem] cursor-pointer py-2 text-left transition-colors",
        TASK_LIST_LINE,
        "hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        archived && "opacity-60"
      )}
    >
      {/* Leading accent — the board's column marker, turned on its side. It is
          what lets the eye group a long list by state before reading a word. */}
      <span
        className={cn("absolute inset-y-0 left-0 w-[2px]", statusAccent(task))}
        aria-hidden="true"
      />

      <div className={cn(TASK_LIST_CELLS.status, "flex")}>
        <StatusChip task={task} className="max-w-full" />
      </div>

      {/* The mark sits in a gutter of its own rather than inline with the
          title: a row's second line would otherwise start 20px to the left of
          the first, and one ragged edge inside the cell undoes what the fixed
          columns are for. mt-[0.125rem] centres it on the title line, which is
          where it belongs when a note pushes the block taller. */}
      <div className={cn(TASK_LIST_CELLS.title, "flex items-start gap-1.5")}>
        <TaskAgentMark task={task} className="mt-[0.125rem]" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[0.8125rem] font-medium leading-snug">
              {task.title}
            </span>
            {/* Inline rather than in a slot of its own: a planned start is
                rare, and a dedicated column would cost every row its alignment
                to serve a handful. Renders nothing when there is no plan. */}
            <ScheduleChip task={task} />
            {/* Same reasoning: a queued merge and a deleted worktree are the
                exception, and the row must say so wherever the board card
                would. */}
            <MergeQueuedChip task={task} rank={mergeQueueRank} />
            <WorktreeRemovedChip task={task} />
          </div>
          {note ? (
            <span
              className={cn(
                "flex min-w-0 items-center gap-1 text-[0.6875rem] leading-snug",
                showError ? "text-destructive" : "text-muted-foreground",
                !showError && isLiveStatus(task) && "italic"
              )}
            >
              {showError ? (
                <CircleAlert className="size-3 shrink-0" aria-hidden="true" />
              ) : null}
              <span className="truncate">{note}</span>
            </span>
          ) : null}
        </div>
      </div>

      {/* The three meta columns always render their box, empty or not — that is
          what holds the vertical rules when a task has no branch or no diff. */}
      <div
        className={cn(
          TASK_LIST_CELLS.location,
          "items-center gap-1.5 text-[0.6875rem] text-muted-foreground"
        )}
      >
        {folderName ? <span className="truncate">{folderName}</span> : null}
        {folderName && task.work_branch ? (
          <span className="shrink-0 text-muted-foreground/40">/</span>
        ) : null}
        {task.work_branch ? (
          <span className="truncate font-mono text-[0.625rem]">
            {task.work_branch}
          </span>
        ) : null}
      </div>
      <div
        className={cn(
          TASK_LIST_CELLS.changes,
          "items-center gap-1 font-mono text-[0.625rem] tabular-nums"
        )}
      >
        {hasStat ? (
          <>
            <span className="text-emerald-600 dark:text-emerald-400">
              +{task.additions ?? 0}
            </span>
            <span className="text-destructive">-{task.deletions ?? 0}</span>
          </>
        ) : null}
      </div>
      <div
        className={cn(
          TASK_LIST_CELLS.updated,
          "items-center text-[0.6875rem] tabular-nums text-muted-foreground"
        )}
      >
        {when}
      </div>

      <div className={cn(TASK_LIST_CELLS.actions, "flex items-center gap-1")}>
        {primary ? (
          <RowIconAction
            item={primary}
            variant={needsUser ? "default" : "outline"}
          />
        ) : null}
        {secondaries.map((item) => (
          <RowIconAction key={item.label} item={item} variant="ghost" />
        ))}
      </div>
    </div>
  )
}

/**
 * One action of a row. The label is a tooltip rather than a native `title`
 * (which would double up with it) and an `aria-label` — a Radix tooltip only
 * describes the trigger, so the button still needs a name of its own.
 */
function RowIconAction({
  item,
  variant,
}: {
  item: TaskActionItem
  variant: "default" | "outline" | "ghost"
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant={variant}
          className={cn(
            "rounded-full",
            variant === "ghost" && "text-muted-foreground hover:text-foreground"
          )}
          aria-label={item.label}
          onClick={(e) => {
            // The row itself opens the detail sheet — keep actions local.
            e.stopPropagation()
            item.onClick()
          }}
        >
          <item.icon aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{item.label}</TooltipContent>
    </Tooltip>
  )
}
