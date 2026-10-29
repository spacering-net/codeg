"use client"

/**
 * Live AIR async tasks, pinned above the transcript in `conversation-shell`.
 *
 * These are the agent's NON-AGENT background jobs — Claude's
 * `Bash(run_in_background)` shells, workflows and monitors (claude-agent-acp
 * 0.73+), codex's background terminals (codex-acp 1.10+), and Grok's background
 * workflows — reported on the adapter's own lifecycle channel. The transcript
 * already draws the tool call that LAUNCHED such a job, but it cannot say
 * whether the job is still alive: the poll-derived card explicitly refuses to
 * claim "running" because a transcript can't tell a live task from one whose
 * CLI died, and codex's launching call simply never settles. This strip is the
 * authoritative answer, and it is the only surface that can offer a stop (Grok
 * has no stop request, so its rows never offer one; nor does a Claude Code
 * monitor's, which claude-agent-acp 0.98.0 publishes as unstoppable).
 *
 * One row is not a job: since claude-agent-acp 0.97.0 a turn Claude Code starts
 * on its own after the prompt ended (to answer a finished background task, or
 * at a scheduled wakeup) arrives as a `turn` task. codeg draws that turn from
 * Claude Code's transcript file, which cannot say whether the turn is still
 * running; this row can, and its stop interrupts the turn.
 *
 * ABOVE the messages rather than docked under the composer: the strip is the
 * status of work happening NOW, and the composer end of the shell is where
 * transient things (a retry line, the last error) come and go while the user is
 * reading the tail of the turn. Anchored to the top it stays put while the
 * transcript scrolls under it, so a task's row doesn't shift out from under the
 * pointer on its way to the stop button.
 *
 * Only non-terminal tasks render (`liveAsyncTasks`). A settled task leaves at
 * once — its outcome belongs to the transcript, and a permanent list of
 * finished jobs would grow all session. Terminal rows stay in the reducer table
 * as the ids later corrections revise; see `lib/async-tasks.ts`.
 *
 * Every row it holds is room the transcript under it loses, so the strip
 * stays small however much runs: past one task it opens on a header — what it
 * lists and how many — that folds the list away to that one line, and the
 * list itself stops a little past three rows and scrolls. One task is a single
 * row, with nothing to fold.
 */

import { useCallback, useId, useMemo, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  Activity,
  Bot,
  ChevronDown,
  FileText,
  Loader2,
  PauseCircle,
  Square,
  TerminalIcon,
  Workflow,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { cn } from "@/lib/utils"
import { useWorkspaceActions } from "@/contexts/workspace-context"
import { formatTokenCount } from "@/lib/token-format"
import {
  AUTONOMOUS_TURN_TASK_TYPE,
  autonomousTurnCause,
  liveAsyncTasks,
} from "@/lib/async-tasks"
import type { AsyncTaskRecord } from "@/lib/types"

/** A line of the strip, its header's too: 2rem tall whether it carries buttons
 *  or not, so the list's height says how many rows it holds and its cap cuts
 *  through a row. */
const ROW_BOX = "flex min-h-8 items-center gap-2 px-4 py-1 text-xs"

/** The adapter's friendly `taskType` vocabulary. An unmapped future type keeps
 *  the generic glyph rather than rendering nothing. */
const TASK_ICONS: Record<string, typeof TerminalIcon> = {
  shell: TerminalIcon,
  workflow: Workflow,
  monitor: Activity,
  [AUTONOMOUS_TURN_TASK_TYPE]: Bot,
}

export function AsyncTaskStrip({
  tasks,
  onStop,
  agentName,
}: {
  tasks: AsyncTaskRecord[]
  /** Resolves to the adapter's verdict: `false` means it declined to stop the
   *  task. Undefined disables every stop button (no live connection to ask). */
  onStop?: (taskId: string) => Promise<boolean>
  /** The agent's display name, for the row of a turn it started on its own.
   *  Without it that row keeps the adapter's own (English) name. */
  agentName?: string
}) {
  const t = useTranslations("Folder.chat.asyncTasks")
  // Kept while the conversation is on screen — the strip stays mounted while
  // its tasks come and go — so a list folded away stays folded as more start.
  const [open, setOpen] = useState(true)
  const listId = useId()
  // The tasks with a stop on its way. Held here, not by their rows: a row
  // unmounts while the list is folded away, and back in view before the
  // adapter has answered it must not offer the stop again.
  const [stopping, setStopping] = useState<ReadonlySet<string>>(NO_TASKS)
  const stop = useCallback(
    async (taskId: string) => {
      if (!onStop) return
      setStopping((prev) => new Set(prev).add(taskId))
      try {
        await onStop(taskId)
      } finally {
        // Deliberately NOT left latched on success. The row disappears when
        // the task's terminal state arrives on the wire, which is the real
        // confirmation; keeping the button disabled on a `false` verdict (the
        // adapter declined) would strand the user with no way to try again.
        setStopping((prev) => {
          const next = new Set(prev)
          next.delete(taskId)
          return next
        })
      }
    },
    [onStop]
  )
  const live = liveAsyncTasks(tasks)
  if (live.length === 0) return null

  // One task is a row of its own, with nothing to fold. The list keeps its
  // place either way, so a row stays the same row as tasks come and go.
  const several = live.length > 1
  return (
    <div className="border-b border-border bg-muted/30">
      {several ? (
        // A row like the rows under it: as tall, the chevron over their
        // icons.
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => setOpen(!open)}
          className={cn(
            ROW_BOX,
            "group/strip w-full min-w-0 cursor-pointer text-start outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50"
          )}
        >
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/strip:text-foreground",
              !open && "-rotate-90 rtl:rotate-90"
            )}
          />
          <span className="min-w-0 truncate font-medium text-muted-foreground group-hover/strip:text-foreground">
            {t("title")}
          </span>
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {live.length}
          </span>
        </button>
      ) : null}
      {open || !several ? (
        // Three rows and half of the next (rows are 2rem) — a row cut
        // through says the list goes on — then it scrolls.
        <ScrollArea className="max-h-28">
          <div id={listId}>
            {live.map((task) => (
              <AsyncTaskRow
                key={task.task_id}
                task={task}
                onStop={onStop ? stop : undefined}
                stopping={stopping.has(task.task_id)}
                agentName={agentName}
              />
            ))}
          </div>
        </ScrollArea>
      ) : null}
    </div>
  )
}

const NO_TASKS: ReadonlySet<string> = new Set()

function AsyncTaskRow({
  task,
  onStop,
  stopping,
  agentName,
}: {
  task: AsyncTaskRecord
  onStop?: (taskId: string) => void
  /** A stop for this task is on its way. */
  stopping: boolean
  agentName?: string
}) {
  const t = useTranslations("Folder.chat.asyncTasks")
  const locale = useLocale()
  const { openFilePreview } = useWorkspaceActions()
  const paused = task.state === "paused"
  const Icon = TASK_ICONS[task.task_type] ?? Activity
  // A turn the agent runs with no prompt open (see AUTONOMOUS_TURN_TASK_TYPE):
  // the row says who is working and why, in the user's language, and its stop
  // interrupts that turn.
  const isTurn = task.task_type === AUTONOMOUS_TURN_TASK_TYPE
  const timeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }),
    [locale]
  )
  const turnCause = useMemo(() => {
    if (!isTurn) return null
    const cause = autonomousTurnCause(task.description)
    switch (cause.kind) {
      case "unknown":
        return null
      case "scheduledWakeup":
        return cause.at
          ? t("scheduledWakeupAt", { time: timeFormatter.format(cause.at) })
          : t("scheduledWakeup")
      case "scheduledTask":
        return t("scheduledTask")
      case "text":
        return cause.text
    }
  }, [isTurn, task.description, t, timeFormatter])
  const name =
    isTurn && agentName ? t("agentWorking", { agent: agentName }) : task.name

  // Read it in a file tab, the same way a file named in the transcript opens
  // (`reply-artifacts`). NOT the OS opener: that path is validated against the
  // `opener:allow-open-path` scope, which grants `$HOME` — and Claude writes
  // task logs under the OS temp root, so every one of them was refused at the
  // door. Widening the scope to cover a temp tree the adapter chose is the
  // wrong trade for reading a log file, and it would still hand a `.output`
  // extension to whatever the OS guesses. `openFilePreview` takes an absolute
  // path anywhere, reads through codeg's own backend, and works in web too —
  // so this button no longer needs `isLocalDesktop()` gating either.
  const handleOpenOutput = useCallback(() => {
    if (!task.output_file_path) return
    void openFilePreview(task.output_file_path)
  }, [openFilePreview, task.output_file_path])

  const handleStop = useCallback(() => {
    if (!onStop || stopping) return
    onStop(task.task_id)
  }, [onStop, stopping, task.task_id])

  // The meta line is the "is this making progress" evidence: where a
  // multi-step task is (a workflow's phase, then the agent it is running), the
  // tool it last ran, then its cost. All absent until the adapter reports them.
  // A turn's is what started it.
  const meta = (
    isTurn
      ? [turnCause]
      : [
          task.phase,
          task.current_agent,
          task.last_tool_name,
          task.usage
            ? t("tokens", { count: formatTokenCount(task.usage.total_tokens) })
            : null,
        ]
  ).filter(Boolean) as string[]

  return (
    <div className={ROW_BOX}>
      {paused ? (
        <PauseCircle
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      ) : (
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
      )}
      <span
        className="min-w-0 truncate font-medium text-foreground"
        title={isTurn ? (turnCause ?? name) : task.description || task.name}
      >
        {paused ? (
          name
        ) : (
          <Shimmer as="span" duration={1.4} shineColor="var(--primary)">
            {name}
          </Shimmer>
        )}
      </span>
      {meta.length > 0 && (
        <span className="min-w-0 truncate text-muted-foreground/70 tabular-nums">
          {meta.join(" · ")}
        </span>
      )}
      <span className="ms-auto flex shrink-0 items-center gap-1">
        {task.output_file_path && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            onClick={handleOpenOutput}
          >
            <FileText aria-hidden="true" className="size-3" />
            {t("openOutput")}
          </Button>
        )}
        {task.can_stop && onStop && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={stopping}
            className={cn(
              "h-6 gap-1 px-2 text-xs",
              "text-muted-foreground hover:text-destructive"
            )}
            onClick={handleStop}
          >
            {stopping ? (
              <Loader2 aria-hidden="true" className="size-3 animate-spin" />
            ) : (
              <Square aria-hidden="true" className="size-3" />
            )}
            {t("stop")}
          </Button>
        )}
      </span>
    </div>
  )
}
