"use client"

/**
 * The handed-out work a card points at, in a drawer on the right — the way a
 * conversation opens a delegated sub-agent's session — rather than away from
 * the page:
 * - a task: its own session, in the board's session viewer, live while the
 *   task runs; a task that has not started yet says so;
 * - a chat or session dispatch: the conversation it runs in, in the
 *   sub-agent viewer, followed live while the dispatch works.
 * The header keeps a way out of the page: the task on the board (to accept
 * or merge it), the conversation as a tab (where the owner can write in it,
 * which makes it theirs).
 *
 * Nothing else in the window attaches a dispatch's connection, so while the
 * dispatch works the drawer does — forward only while it is open, as the
 * task viewer does: a follow-up's new connection replaces the old one, a
 * dispatch that settled while watched keeps the one it streamed from (the
 * last of its reply still lands), and closing the drawer detaches it.
 */

import { useEffect, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { ArrowUpRight } from "lucide-react"

import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { SubAgentSessionDialog } from "@/components/message/sub-agent-session-dialog"
import { StatusChip } from "@/components/tasks/task-card"
import { TaskTranscriptDialog } from "@/components/tasks/task-transcript-dialog"
import { Button } from "@/components/ui/button"
import { useAcpActions } from "@/contexts/acp-connections-context"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { useTasksView } from "@/contexts/tasks-view-context"
import { useHistoryBackDismiss } from "@/hooks/use-history-back-dismiss"
import { workTaskGet } from "@/lib/api"
import type { DispatchState, WorkTask } from "@/lib/types"
import {
  usePersonalAgentUi,
  type WorkTarget,
} from "@/stores/personal-agent-ui-store"

import { useOpenInWorkbench, workTargetOf } from "./shared"

/** The states a dispatch's conversation runs in. */
const WORKING: ReadonlySet<DispatchState> = new Set([
  "running",
  "waiting_input",
])

/** The header's way out of the page; the drawer closes behind it. */
function WayOut({ target, label }: { target: WorkTarget; label: string }) {
  const openInWorkbench = useOpenInWorkbench()
  const setWorkOpen = usePersonalAgentUi((s) => s.setWorkOpen)
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
      onClick={() => {
        setWorkOpen(false)
        openInWorkbench(target)
      }}
    >
      {label}
      <ArrowUpRight className="size-3.5" aria-hidden />
    </Button>
  )
}

/** In the task viewer's place while there is no session to show. */
function NoTaskSession({
  task,
  title,
  pending,
  wayOut,
}: {
  task: WorkTask | null
  title: string | null
  pending: boolean
  wayOut: ReactNode
}) {
  const t = useTranslations("PersonalAgent.work")
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* As the task viewer's own header: `pr-12` clears the close button. */}
      <div className="flex min-h-12 items-center gap-3 border-b border-border px-4 py-2.5 pr-12">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {task?.title ?? title}
        </span>
        {task ? <StatusChip task={task} /> : null}
        {task ? wayOut : null}
      </div>
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {pending ? (
          <SyncedSpinner small className="size-5" />
        ) : task ? (
          t("taskNotStarted")
        ) : (
          t("taskGone")
        )}
      </div>
    </div>
  )
}

function TaskWork({
  target,
  open,
  onOpenChange,
}: {
  target: WorkTarget
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("PersonalAgent.timeline")
  const { tasks, loading } = useTasksView()
  const id = target.workTaskId
  // The board's list keeps the task as it moves.
  const held = id != null ? (tasks.find((x) => x.id === id) ?? null) : null
  // One the list does not have (yet): read once.
  const [read, setRead] = useState<{
    id: number
    task: WorkTask | null
  } | null>(null)
  useEffect(() => {
    if (!open || id == null || held || loading) return
    let cancelled = false
    workTaskGet(id)
      .then((task) => {
        if (!cancelled) setRead({ id, task })
      })
      .catch(() => {
        if (!cancelled) setRead({ id, task: null })
      })
    return () => {
      cancelled = true
    }
  }, [open, id, held, loading])
  const task = held ?? (read != null && read.id === id ? read.task : null)
  const pending = held == null && id != null && (loading || read?.id !== id)
  // A state toggle, not a route: the back gesture closes it rather than
  // leaving the page (the sub-agent viewer does the same for itself).
  useHistoryBackDismiss(open, () => onOpenChange(false))
  const wayOut = <WayOut target={target} label={t("openTask")} />
  return (
    <TaskTranscriptDialog
      open={open}
      onOpenChange={onOpenChange}
      task={task}
      headerActions={wayOut}
      fallback={
        <NoTaskSession
          task={task}
          title={target.title}
          pending={pending}
          wayOut={wayOut}
        />
      }
    />
  )
}

function ConversationWork({
  target,
  open,
  onOpenChange,
}: {
  target: WorkTarget
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("PersonalAgent.timeline")
  const { dispatchById } = usePersonalAgent()
  const { attachDelegationChild, detachDelegationChild } = useAcpActions()
  const info =
    target.dispatchId != null ? dispatchById.get(target.dispatchId) : undefined
  // The dispatch as it is now when the page has it; what the card knew else.
  const now = info ? workTargetOf(info) : target
  const agentType = now.agentType
  const liveId =
    now.state != null && WORKING.has(now.state) ? now.connectionId : null
  const [attachId, setAttachId] = useState<string | null>(liveId)
  // Open, forward only; closed, whatever runs now — so opening it again
  // never attaches a connection that has gone. During render, so the attach
  // below sees it on this very render.
  if (open ? liveId !== null && liveId !== attachId : liveId !== attachId) {
    setAttachId(liveId)
  }
  const dispatchId = now.dispatchId
  useEffect(() => {
    if (!open || attachId == null || agentType == null) return
    attachDelegationChild({
      connectionId: attachId,
      // No parent tool call: an identity mapping, as the task viewer's.
      parentConnectionId: attachId,
      parentToolUseId: `personal-agent-dispatch-${dispatchId ?? attachId}`,
      agentType,
      // It opens onto a turn already under way.
      hydrate: true,
    })
    return () => detachDelegationChild(attachId)
  }, [
    open,
    attachId,
    agentType,
    dispatchId,
    attachDelegationChild,
    detachDelegationChild,
  ])
  if (now.conversationId == null || agentType == null) return null
  return (
    <SubAgentSessionDialog
      open={open}
      onOpenChange={onOpenChange}
      childConversationId={now.conversationId}
      childConnectionId={attachId}
      identity={{
        agentType,
        assistantId: now.executorId,
        assistantName: now.executorName,
      }}
      kickoffTask={now.prompt}
      headerActions={<WayOut target={now} label={t("openConversation")} />}
    />
  )
}

/** The page's one drawer for handed-out work; any card opens it. */
export function PersonalAgentWorkDrawer() {
  const work = usePersonalAgentUi((s) => s.work)
  const open = usePersonalAgentUi((s) => s.workOpen)
  const setOpen = usePersonalAgentUi((s) => s.setWorkOpen)
  if (!work) return null
  // Another piece of work is another viewer, from scratch.
  const key = `${work.mode}:${work.dispatchId ?? work.workTaskId ?? work.conversationId}`
  return work.mode === "task" ? (
    <TaskWork key={key} target={work} open={open} onOpenChange={setOpen} />
  ) : (
    <ConversationWork
      key={key}
      target={work}
      open={open}
      onOpenChange={setOpen}
    />
  )
}
