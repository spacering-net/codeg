"use client"

/**
 * One live AIR async task, as the composer's running list draws it (the
 * "Background tasks" group of `LiveRunsPopover`).
 *
 * These are the agent's NON-AGENT background jobs — Claude's
 * `Bash(run_in_background)` shells, workflows and monitors (claude-agent-acp
 * 0.73+), codex's background terminals (codex-acp 1.10+), and Grok's background
 * workflows — reported on the adapter's own lifecycle channel. The transcript
 * already draws the tool call that LAUNCHED such a job, but it cannot say
 * whether the job is still alive: the poll-derived card explicitly refuses to
 * claim "running" because a transcript can't tell a live task from one whose
 * CLI died, and codex's launching call simply never settles. This row is the
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
 * Only non-terminal tasks get a row (`liveAsyncTasks`). A settled task leaves
 * at once — its outcome belongs to the transcript. Terminal rows stay in the
 * reducer table as the ids later corrections revise; see `lib/async-tasks.ts`.
 */

import { useCallback, useMemo } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  Activity,
  Bot,
  FileText,
  Loader2,
  PauseCircle,
  Square,
  TerminalIcon,
  Workflow,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { cn } from "@/lib/utils"
import { useWorkspaceActions } from "@/contexts/workspace-context"
import { formatTokenCount } from "@/lib/token-format"
import {
  AUTONOMOUS_TURN_TASK_TYPE,
  autonomousTurnCause,
} from "@/lib/async-tasks"
import type { AsyncTaskRecord } from "@/lib/types"

/** A line of the running list: 2rem tall whether it carries buttons or not. */
export const RUN_ROW_BOX = "flex min-h-8 items-center gap-2 px-3 py-1 text-xs"

/** The adapter's friendly `taskType` vocabulary. An unmapped future type keeps
 *  the generic glyph rather than rendering nothing. */
const TASK_ICONS: Record<string, typeof TerminalIcon> = {
  shell: TerminalIcon,
  workflow: Workflow,
  monitor: Activity,
  [AUTONOMOUS_TURN_TASK_TYPE]: Bot,
}

export function AsyncTaskRow({
  task,
  onStop,
  stopping,
  agentName,
}: {
  task: AsyncTaskRecord
  /** Undefined hides the stop (no live connection to ask). */
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
    <div className={RUN_ROW_BOX}>
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
        <span className="min-w-0 flex-1 basis-0 truncate text-muted-foreground/70 tabular-nums">
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
