"use client"

import { useTranslations } from "next-intl"
import {
  Bot,
  CalendarClock,
  Check,
  CircleAlert,
  CircleCheck,
  CircleX,
  FolderX,
  GitMerge,
  Loader2,
} from "lucide-react"
import { AgentIcon } from "@/components/agent-icon"
import { BrowserLink } from "@/components/ui/browser-link"
import { Button } from "@/components/ui/button"
import { formatRelative } from "@/components/conversations/sidebar-conversation-grouping"
import { formatScheduleFull, formatScheduleShort } from "@/lib/task-schedule"
import { cn } from "@/lib/utils"
import { isMergeQueued, worktreeWasRemoved } from "./task-acceptance"
import { buildTaskActions, type TaskActionItem } from "./task-actions"
import type { TaskActionHandlers } from "./task-actions"
import type { WorkTask } from "@/lib/types"

type StatusLabelKey =
  | "statusTodo"
  | "statusQueued"
  | "statusPreparing"
  | "statusRunning"
  | "statusAwaitingInput"
  | "statusReview"
  | "statusMerging"
  | "statusDone"
  | "statusFailed"
  | "statusCanceled"

export function statusLabelKey(status: WorkTask["status"]): StatusLabelKey {
  switch (status) {
    case "todo":
      return "statusTodo"
    case "queued":
      return "statusQueued"
    case "preparing":
      return "statusPreparing"
    case "running":
      return "statusRunning"
    case "awaiting_input":
      return "statusAwaitingInput"
    case "review":
      return "statusReview"
    case "merging":
      return "statusMerging"
    case "done":
      return "statusDone"
    case "failed":
      return "statusFailed"
    case "canceled":
      return "statusCanceled"
  }
}

/**
 * Per-status presentation, so the board reads by shape rather than nine
 * same-looking chips: live statuses are primary-colored spinner text,
 * attention statuses an outlined amber pill, `done` a bare green check,
 * `failed` a tinted red pill, the rest a muted pill.
 *
 * The label truncates inside whatever width it is given (with the full text on
 * `title`): the list view puts the chip in a fixed status column, and locales
 * whose "awaiting input" runs to twenty characters must not blow that column
 * out. In the card, where the chip sizes to its content, this never engages.
 */
export function StatusChip({
  task,
  className,
}: {
  task: WorkTask
  className?: string
}) {
  const t = useTranslations("Tasks")
  // An interrupted failure (restart) reads differently from an agent failure.
  const label =
    task.status === "failed" && task.failure_reason === "interrupted"
      ? t("statusInterrupted")
      : t(statusLabelKey(task.status))

  let tone: string
  let icon: React.ReactNode = null
  switch (task.status) {
    case "queued":
    case "preparing":
    case "running":
    case "merging":
      tone = "gap-1 text-[0.6875rem] text-primary"
      icon = (
        <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />
      )
      break
    case "awaiting_input":
    case "review":
      tone =
        "rounded-full border border-amber-500/45 bg-amber-500/5 px-2 py-1 text-[0.625rem] text-amber-600 dark:border-amber-400/40 dark:text-amber-400"
      break
    case "done":
      tone =
        "gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-[0.625rem] text-emerald-600 dark:text-emerald-400"
      icon = (
        <Check
          className="size-2.5 shrink-0"
          strokeWidth={3}
          aria-hidden="true"
        />
      )
      break
    case "failed":
      tone =
        "rounded-full bg-destructive/10 px-2 py-1 text-[0.625rem] text-destructive"
      break
    default:
      tone =
        "rounded-full bg-muted px-2 py-1 text-[0.625rem] text-muted-foreground"
  }

  return (
    <span
      className={cn(
        "inline-flex min-w-0 shrink-0 items-center font-medium leading-none",
        tone,
        className
      )}
      title={label}
    >
      {icon}
      <span className="truncate">{label}</span>
    </span>
  )
}

/**
 * The list row's leading accent bar — the board's column markers turned on
 * their side, so the two views speak one colour language.
 *
 * It refines the mapping where a board column lumps two outcomes together:
 * `failed` reads red rather than the attention column's amber, and `canceled`
 * stays neutral instead of inheriting Done's green (a green bar on a row that
 * says "已取消" is a lie the board gets away with only because its column
 * heading says "Done" once, at the top).
 */
export function statusAccent(task: WorkTask): string {
  if (task.archived_at != null) return "bg-muted-foreground/20"
  switch (task.status) {
    case "todo":
    case "queued":
      return "bg-muted-foreground/35"
    case "preparing":
    case "running":
      return "bg-primary"
    case "awaiting_input":
    case "review":
    case "merging":
      return "bg-amber-500"
    case "failed":
      return "bg-destructive"
    case "done":
      return "bg-emerald-500"
    case "canceled":
      return "bg-muted-foreground/25"
  }
}

/**
 * Statuses in which the engine is holding an agent for this task, and the
 * card's italic note line is therefore about work happening right now.
 *
 * `preparing` counts: a round that resumes a session spends it on a real agent
 * turn — the pre-prompt context compaction, minutes of it on a full context
 * window — and that is exactly the stretch the note line exists to explain.
 * Shared by the card and the list row so the two cannot drift.
 */
export function isLiveStatus(task: WorkTask): boolean {
  return (
    task.status === "preparing" ||
    task.status === "running" ||
    task.status === "awaiting_input" ||
    task.status === "merging"
  )
}

/**
 * The italic line under a live card: what this generation is doing.
 *
 * The compaction outranks the agent's own last milestone because it is the
 * more recent truth AND the more surprising one — a card that has sat in
 * 准备中 or 合并中 for minutes has no other explanation on screen. Below it,
 * `latest_progress` is already scoped to this generation by the backend, so
 * there is nothing here to guard against a previous round's leftovers.
 */
export function liveNote(
  task: WorkTask,
  t: (key: "compactingNote") => string
): string | null {
  if (!isLiveStatus(task)) return null
  if (task.compacting) return t("compactingNote")
  return task.latest_progress ?? null
}

interface TaskCardProps extends TaskActionHandlers {
  task: WorkTask
  folderName: string | null
  /** Shared render-tick timestamp for relative times (refreshed by the page). */
  now: number
  /** Place in line when this task is waiting to merge (see `mergeQueueRanks`);
   *  the page computes it, because a card cannot see its siblings. */
  mergeQueueRank?: number
  onOpen: () => void
}

/**
 * "Accepted, waiting for the project's merge slot." Merges into one base branch
 * run one at a time, so a second acceptance takes a place in line instead of
 * failing — and a row that says nothing about that reads as if the click was
 * lost. Amber like the review states it sits among, with the rank spelled out
 * whenever the page knows it (`第 2 位` is the difference between "queued" and
 * "queued behind one other").
 */
export function MergeQueuedChip({
  task,
  rank,
}: {
  task: WorkTask
  rank?: number
}) {
  const t = useTranslations("Tasks")
  if (!isMergeQueued(task)) return null
  const label =
    rank != null && rank > 1
      ? t("badgeMergeQueuedRank", { rank })
      : t("badgeMergeQueued")
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[0.625rem] font-medium leading-none text-amber-600 dark:text-amber-400"
      title={t("badgeMergeQueuedHint")}
    >
      <GitMerge className="size-2.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  )
}

/** The acceptance red/green light for a reviewed card. */
export function PreflightChip({ task }: { task: WorkTask }) {
  const t = useTranslations("Tasks")
  const light = task.preflight
  if (!light || task.status !== "review") return null
  const tone =
    light.status === "passed"
      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : light.status === "failed"
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground"
  return (
    <span
      className={cn(
        // max-w-full: a long command wraps the chip to its own row in the
        // flex-wrap meta line and then truncates instead of overflowing.
        "inline-flex min-w-0 max-w-full items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium leading-none",
        tone
      )}
      title={
        light.status === "passed"
          ? t("preflightPassed", { name: light.command })
          : light.status === "failed"
            ? t("preflightFailed", { name: light.command })
            : t("preflightRunning", { name: light.command })
      }
    >
      {light.status === "running" ? (
        <Loader2 className="size-2.5 animate-spin" aria-hidden="true" />
      ) : light.status === "passed" ? (
        <CircleCheck className="size-2.5" aria-hidden="true" />
      ) : (
        <CircleX className="size-2.5" aria-hidden="true" />
      )}
      <span className="truncate">{light.command}</span>
    </span>
  )
}

/**
 * "The worktree this task ran in has been deleted" — shown in EVERY status
 * (a reviewed task explains its Complete button, a canceled one warns that a
 * requeue starts over, a done one explains why there is no diff). The one
 * exception is built into the predicate: a just-created task that never
 * initialized has nothing removed to report.
 */
export function WorktreeRemovedChip({ task }: { task: WorkTask }) {
  const t = useTranslations("Tasks")
  if (!worktreeWasRemoved(task)) return null
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[0.625rem] font-medium leading-none text-amber-600 dark:text-amber-400"
      title={t("badgeWorktreeRemoved")}
    >
      <FolderX className="size-2.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{t("badgeWorktreeRemoved")}</span>
    </span>
  )
}

/**
 * The mark of the agent on this task, drawn beside the title in BOTH views —
 * which agent is on a task belongs to the task, so the board and the list must
 * answer it identically. The backend resolves it the way the engine does at
 * launch (see `agent_type`), so a task that simply inherits its folder's
 * settings still shows the mark it will actually run under; `config.agent_type`
 * covers a payload that reached the client without that stamp.
 *
 * Sized to the title's line rather than framed like the detail sheet's glyph: a
 * row or card carries one, and at this density a bare mark reads as part of the
 * title instead of as another chip. Left to name itself through the mark's own
 * `<title>`, as every other AgentIcon in the app is — the words for it are in
 * the detail sheet, beside a glyph big enough to deserve them.
 *
 * The box is drawn even when no agent is configured anywhere (the one state the
 * engine refuses to launch): both views align their titles on it, and a
 * placeholder is worth more than a column that shifts row to row.
 */
export function TaskAgentMark({
  task,
  className,
}: {
  task: WorkTask
  className?: string
}) {
  const agentType = task.agent_type ?? task.config?.agent_type ?? null
  if (!agentType) {
    return (
      <Bot
        className={cn("size-3.5 shrink-0 text-muted-foreground/40", className)}
        aria-hidden="true"
      />
    )
  }
  return (
    <AgentIcon agentType={agentType} className={cn("size-3.5", className)} />
  )
}

/**
 * The planned start of a to-do task. Primary-tinted rather than muted: it is
 * the one thing on a pending card that says something WILL happen, and it is
 * how a card that looks idle explains itself.
 */
export function ScheduleChip({ task }: { task: WorkTask }) {
  const t = useTranslations("Tasks")
  if (task.status !== "todo" || !task.scheduled_at) return null
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[0.625rem] font-medium leading-none text-primary"
      title={t("scheduleBadge", {
        time: formatScheduleFull(task.scheduled_at),
      })}
    >
      <CalendarClock className="size-2.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{formatScheduleShort(task.scheduled_at)}</span>
    </span>
  )
}

/**
 * One board card. The whole card opens the detail sheet; the footer carries
 * the shared action set (see `buildTaskActions`): one filled primary on the
 * left, round icon buttons for the secondaries on the right.
 */
export function TaskCard({
  task,
  folderName,
  now,
  mergeQueueRank,
  onOpen,
  ...handlers
}: TaskCardProps) {
  const t = useTranslations("Tasks")
  const archived = task.archived_at != null
  const note = liveNote(task, t)

  const stat =
    task.files_changed != null && task.files_changed > 0 ? (
      <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[0.625rem]">
        <span className="text-emerald-600 dark:text-emerald-400">
          +{task.additions ?? 0}
        </span>
        <span className="text-destructive">-{task.deletions ?? 0}</span>
      </span>
    ) : null
  const when = formatRelative(
    task.finished_at ?? task.settled_at ?? task.started_at ?? task.created_at,
    now
  )

  // Hoisted so the click handler closes over a plain string: narrowing on
  // `task.source_meta?.url` does not survive into the callback.
  const source = task.source_meta
  const sourceUrl = source?.url ?? null

  const { primary, secondaries } = buildTaskActions(task, t, handlers)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        // Only the card's own focus opens the sheet: Enter/Space on one of the
        // footer buttons bubbles up here, and preventing the default would
        // swallow that button's activation and open the sheet instead.
        if (e.target !== e.currentTarget) return
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen()
        }
      }}
      className={cn(
        // ws-msg-card: with a workspace background image on, the card goes
        // translucent like message-stream cards (e.g. the file-edit card).
        // border-foreground/15, not border-border: a card is white-on-white
        // here, and the token border all but vanishes on that canvas (the
        // empty column's dashed outline had to be derived the same way).
        "group/card flex cursor-pointer flex-col rounded-xl border border-foreground/15 bg-card ws-msg-card p-3 text-left",
        // Hover is a border colour change only — no lift, no shadow.
        "transition-colors hover:border-primary",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        archived && "opacity-60"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        {/* mt-[0.125rem] rides the mark on the FIRST line of a title that
            wraps — items-start would otherwise hang it off the block's top
            edge, half a line above the text it belongs to. */}
        <TaskAgentMark task={task} className="mt-[0.125rem]" />
        <span className="min-w-0 flex-1 break-words text-[0.8125rem] font-medium leading-snug">
          {task.title}
        </span>
        <StatusChip task={task} />
      </div>

      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.6875rem] text-muted-foreground">
        {folderName ? (
          <span className="max-w-40 truncate">{folderName}</span>
        ) : null}
        {folderName && task.work_branch ? (
          <span className="text-muted-foreground/40">/</span>
        ) : null}
        {task.work_branch ? (
          <span className="truncate font-mono text-[0.625rem]">
            {task.work_branch}
          </span>
        ) : null}
        {(folderName || task.work_branch) && (stat || when) ? (
          <span className="text-muted-foreground/40">·</span>
        ) : null}
        {stat}
        {stat && when ? (
          <span className="text-muted-foreground/40">·</span>
        ) : null}
        {when ? <span className="shrink-0">{when}</span> : null}
        <ScheduleChip task={task} />
        <MergeQueuedChip task={task} rank={mergeQueueRank} />
        <PreflightChip task={task} />
        <WorktreeRemovedChip task={task} />
        {task.cleanup_state === "failed" ? (
          <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[0.625rem] text-amber-600 dark:text-amber-400">
            {t("badgeCleanupFailed")}
          </span>
        ) : null}
        {/* "Kept" claims the worktree is still there — stay silent when its
            directory is actually gone (the removed chip above speaks then). */}
        {task.status === "canceled" &&
        task.worktree_folder_id != null &&
        task.worktree_missing !== true ? (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.625rem]">
            {t("badgeWorktreeKept")}
          </span>
        ) : null}
      </div>

      {/* Forge provenance — `#123 · owner/repo`, straight to the issue. On its
          own row rather than in the meta line above: `owner/repo` is long
          enough that beside a folder and a `task/7` branch it either crowds
          them or truncates itself into uselessness. mt-1 (tighter than the
          meta line's own mt-1.5) keeps it reading as part of that block.
          inline-block, not block, so the hit area hugs the text — a
          full-width anchor would swallow clicks meant for the card. */}
      {sourceUrl && source ? (
        <div className="mt-1 min-w-0">
          <BrowserLink
            href={sourceUrl}
            // The card itself opens the detail sheet — keep the click local.
            onClick={(e) => e.stopPropagation()}
            className="inline-block max-w-full truncate align-bottom font-mono text-[0.625rem] text-primary/80 hover:underline"
            title={sourceUrl}
          >
            #{source.number} · {source.owner_repo}
          </BrowserLink>
        </div>
      ) : null}

      {task.last_error &&
      (task.status === "failed" || task.status === "review") ? (
        <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-destructive/10 px-2 py-1.5 text-[0.6875rem] text-destructive">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{task.last_error}</span>
          <button
            type="button"
            className="shrink-0 font-medium hover:underline"
            onClick={(e) => {
              e.stopPropagation()
              onOpen()
            }}
          >
            {t("errorView")}
          </button>
        </div>
      ) : null}
      {task.status === "review" && task.result_summary ? (
        <p className="mt-1.5 line-clamp-2 text-[0.6875rem] leading-snug text-muted-foreground">
          {task.result_summary}
        </p>
      ) : null}
      {note ? (
        <p className="mt-1.5 line-clamp-2 text-[0.6875rem] leading-snug text-muted-foreground italic">
          {note}
        </p>
      ) : null}

      {/* mt-3 / pt-3 = the card's own p-3: the divider clears the content above
          it by the same 12px the buttons clear the card's left, right and
          bottom edges, so the footer sits on one even inset. */}
      {primary || secondaries.length > 0 ? (
        <div className="mt-3 flex items-center gap-1.5 border-t border-border/60 pt-3">
          {primary ? (
            <Button
              type="button"
              size="xs"
              onClick={(e) => {
                // The card itself opens the detail sheet — keep actions local.
                e.stopPropagation()
                primary.onClick()
              }}
            >
              <primary.icon className="size-3" aria-hidden="true" />
              {primary.label}
            </Button>
          ) : null}
          <div className="flex-1" />
          {/* Secondaries are icon-only and round: they are one-per-status at
              most, so a "…" menu just hid them behind an extra click. The
              session viewer always sorts last, anchoring the corner. They
              fade in on hover (opacity only — the row keeps its height, so
              nothing reflows) and on keyboard focus. */}
          {secondaries.map((item) => (
            <CardIconAction key={item.label} item={item} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function CardIconAction({ item }: { item: TaskActionItem }) {
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="outline"
      className="rounded-full opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within/card:opacity-100 group-hover/card:opacity-100"
      title={item.label}
      aria-label={item.label}
      onClick={(e) => {
        // The card itself opens the detail sheet — keep actions local.
        e.stopPropagation()
        item.onClick()
      }}
    >
      <item.icon aria-hidden="true" />
    </Button>
  )
}
