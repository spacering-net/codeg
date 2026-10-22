"use client"

import { useCallback, useMemo, useState, type ReactNode } from "react"
import { toast } from "sonner"
import {
  workTaskArchive,
  workTaskCreate,
  workTaskDefer,
  workTaskMergeUnqueue,
  workTaskStart,
  workTaskUpdate,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { CreateTaskFromTextDetail } from "@/lib/task-compose-events"
import type { WorkTask, WorkTaskDraft } from "@/lib/types"
import {
  isAnotherTaskMerging,
  isDeferred,
  isMergeQueued,
} from "./task-acceptance"
import type { TaskActionHandlers } from "./task-actions"
import { TaskCancelDialog } from "./task-cancel-dialog"
import { TaskCompleteDialog } from "./task-complete-dialog"
import { TaskDeliverPrDialog } from "./task-deliver-pr-dialog"
import { TaskDetailSheet } from "./task-detail-sheet"
import { TaskEditorDialog } from "./task-editor-dialog"
import { TaskFollowUpDialog } from "./task-follow-up-dialog"
import { TaskMergeDialog } from "./task-merge-dialog"
import { TaskRestartDialog, type TaskRestartKind } from "./task-restart-dialog"
import { TaskScheduleDialog } from "./task-schedule-dialog"
import { TaskTranscriptDialog } from "./task-transcript-dialog"

interface UseTaskDialogsOptions {
  /** Every task the provider holds — the dialogs read their LIVE rows from it,
   *  so a status flip shows in an open sheet. */
  tasks: WorkTask[]
  refetch: () => Promise<void>
  /** folder id → display name, for the detail sheet's location line. */
  folderNames: Map<number, string>
  /** The project a NEW task starts in, unless a prefill names one — the board's
   *  folder filter, or the aux panel's project. */
  defaultFolderId: number | null
}

export interface TaskDialogs {
  /** Runs a mutation, toasts its failure, and refetches either way. */
  act: (fn: () => Promise<unknown>) => Promise<void>
  /** One handler set, wired the same way for a board card and a list row. */
  handlersFor: (task: WorkTask) => TaskActionHandlers
  /** Opens the detail sheet on a task. */
  openDetail: (taskId: number) => void
  /** Opens the editor on a new task, optionally pre-filled ("task from
   *  message"). */
  openNewTask: (prefill?: CreateTaskFromTextDetail | null) => void
  /** Every dialog and sheet the handlers open — render it once, anywhere. */
  dialogs: ReactNode
}

/**
 * Everything a surface listing work tasks needs to ACT on them: the editor,
 * the detail sheet, and the acceptance / restart / follow-up / schedule /
 * session dialogs its card buttons open, wired to one handler set.
 *
 * Shared by the Tasks page and the aux panel's task tab, so a card does the
 * same thing wherever it is drawn — and a dialog added for one surface cannot
 * be missing from the other. What is page-only stays in the page: the board's
 * drag, its settings dialog, and the "task from message" hand-off (which the
 * page consumes and feeds to `openNewTask`).
 */
export function useTaskDialogs({
  tasks,
  refetch,
  folderNames,
  defaultFolderId,
}: UseTaskDialogsOptions): TaskDialogs {
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorTask, setEditorTask] = useState<WorkTask | null>(null)
  const [editorPrefill, setEditorPrefill] =
    useState<CreateTaskFromTextDetail | null>(null)
  const [detailTaskId, setDetailTaskId] = useState<number | null>(null)
  const [mergeTask, setMergeTask] = useState<WorkTask | null>(null)
  const [mergeOpen, setMergeOpen] = useState(false)
  // The merge dialog's counterpart for a task that changed nothing.
  const [completeTask, setCompleteTask] = useState<WorkTask | null>(null)
  const [completeOpen, setCompleteOpen] = useState(false)
  // The third way to accept: push the branch and open a pull request on the
  // repository the task's issue came from.
  const [deliverTask, setDeliverTask] = useState<WorkTask | null>(null)
  const [deliverOpen, setDeliverOpen] = useState(false)
  // Stopping a task asks why (optional) — from the card and from the drawer.
  const [cancelTask, setCancelTask] = useState<WorkTask | null>(null)
  const [cancelOpen, setCancelOpen] = useState(false)
  // Restarting from a card asks for an optional note; the drawer unfolds its
  // own box in place instead.
  const [restartTask, setRestartTask] = useState<WorkTask | null>(null)
  const [restartKind, setRestartKind] = useState<TaskRestartKind>("retry")
  const [restartOpen, setRestartOpen] = useState(false)
  // "继续处理" from a card (a deferred reviewed task leads with it) — the
  // drawer unfolds its own box instead. The row is captured at the click, like
  // the restart's: the dialog seeds from it once per open.
  const [followUpTask, setFollowUpTask] = useState<WorkTask | null>(null)
  const [followUpOpen, setFollowUpOpen] = useState(false)
  // Planning a to-do task's start — tracked by id so the dialog reads the live
  // row (a task claimed while it is open no longer accepts a plan).
  const [scheduleTaskId, setScheduleTaskId] = useState<number | null>(null)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  // Read-only live session viewer ("查看会话") — tracked by id so the dialog
  // header's status chip follows the live row (like the detail sheet).
  const [sessionTaskId, setSessionTaskId] = useState<number | null>(null)
  const [sessionOpen, setSessionOpen] = useState(false)

  // The LIVE row behind the open merge dialog — read for its queue state only.
  // The dialog itself keeps the captured `mergeTask`: it re-seeds its form
  // whenever that object changes, and the provider hands out a fresh array on
  // every refetch, so passing the live row would wipe a half-typed commit
  // message the moment any task anywhere changed.
  const mergeLiveTask = useMemo(
    () =>
      mergeTask == null
        ? null
        : (tasks.find((task) => task.id === mergeTask.id) ?? null),
    [tasks, mergeTask]
  )
  // The sheet renders the LIVE row from the provider so status flips (e.g.
  // merging → done) update in place while it is open.
  const detailTask = useMemo(
    () => tasks.find((task) => task.id === detailTaskId) ?? null,
    [tasks, detailTaskId]
  )
  const sessionTask = useMemo(
    () => tasks.find((task) => task.id === sessionTaskId) ?? null,
    [tasks, sessionTaskId]
  )
  const scheduleTask = useMemo(
    () => tasks.find((task) => task.id === scheduleTaskId) ?? null,
    [tasks, scheduleTaskId]
  )

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn()
      } catch (e) {
        toast.error(toErrorMessage(e))
      } finally {
        void refetch()
      }
    },
    [refetch]
  )

  const openSession = useCallback((task: WorkTask) => {
    if (task.conversation_id == null) return
    setSessionTaskId(task.id)
    setSessionOpen(true)
  }, [])

  const submitEditor = useCallback(
    async (draft: WorkTaskDraft) => {
      if (editorTask) await workTaskUpdate(editorTask.id, draft)
      else await workTaskCreate(draft)
      setEditorOpen(false)
      setEditorPrefill(null)
      void refetch()
    },
    [editorTask, refetch]
  )

  const openMerge = useCallback((task: WorkTask) => {
    setMergeTask(task)
    setMergeOpen(true)
  }, [])

  const openComplete = useCallback((task: WorkTask) => {
    setCompleteTask(task)
    setCompleteOpen(true)
  }, [])

  const openDeliver = useCallback((task: WorkTask) => {
    setDeliverTask(task)
    setDeliverOpen(true)
  }, [])

  const openCancel = useCallback((task: WorkTask) => {
    setCancelTask(task)
    setCancelOpen(true)
  }, [])

  const openRestart = useCallback((task: WorkTask, kind: TaskRestartKind) => {
    setRestartTask(task)
    setRestartKind(kind)
    setRestartOpen(true)
  }, [])

  const openFollowUp = useCallback((task: WorkTask) => {
    setFollowUpTask(task)
    setFollowUpOpen(true)
  }, [])

  const openSchedule = useCallback((task: WorkTask) => {
    setScheduleTaskId(task.id)
    setScheduleOpen(true)
  }, [])

  const openEdit = useCallback((task: WorkTask) => {
    setEditorTask(task)
    setEditorPrefill(null)
    setEditorOpen(true)
  }, [])

  const openNewTask = useCallback(
    (prefill: CreateTaskFromTextDetail | null = null) => {
      setEditorTask(null)
      setEditorPrefill(prefill)
      setEditorOpen(true)
    },
    []
  )

  const handlersFor = useCallback(
    (task: WorkTask): TaskActionHandlers => ({
      onStart: () => void act(() => workTaskStart(task.id)),
      onCancel: () => openCancel(task),
      onRetry: () => openRestart(task, "retry"),
      onRequeue: () => openRestart(task, "requeue"),
      onViewSession: () => openSession(task),
      onMerge: () => openMerge(task),
      onDeliverPr: () => openDeliver(task),
      onUnqueueMerge: () => void act(() => workTaskMergeUnqueue(task.id)),
      onComplete: () => openComplete(task),
      onArchive: () =>
        void act(() => workTaskArchive(task.id, task.archived_at == null)),
      onDefer: () => void act(() => workTaskDefer(task.id, !isDeferred(task))),
      onFollowUp: () => openFollowUp(task),
      onEdit: () => openEdit(task),
      onSchedule: () => openSchedule(task),
    }),
    [
      act,
      openCancel,
      openComplete,
      openDeliver,
      openEdit,
      openFollowUp,
      openMerge,
      openRestart,
      openSchedule,
      openSession,
    ]
  )

  const dialogs = (
    <>
      <TaskEditorDialog
        open={editorOpen}
        onOpenChange={(o) => {
          setEditorOpen(o)
          if (!o) setEditorPrefill(null)
        }}
        task={editorTask}
        defaultFolderId={editorPrefill?.folderId ?? defaultFolderId}
        prefillText={editorPrefill?.text ?? null}
        onSubmit={submitEditor}
      />
      <TaskDetailSheet
        open={detailTaskId != null}
        onOpenChange={(o) => {
          if (!o) setDetailTaskId(null)
        }}
        task={detailTask}
        folderName={
          detailTask ? (folderNames.get(detailTask.folder_id) ?? null) : null
        }
        onMerge={openMerge}
        onComplete={openComplete}
        onDeliverPr={openDeliver}
        onCancel={openCancel}
        onEdit={openEdit}
        onSchedule={openSchedule}
      />
      {/* The queue state comes from the live row (a merge that starts while
          the dialog is open turns "merge" into "queue"), the form from the
          captured one — see `mergeLiveTask`. */}
      <TaskMergeDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        task={mergeTask}
        anotherMerging={
          mergeTask != null && isAnotherTaskMerging(tasks, mergeTask)
        }
        alreadyQueued={mergeLiveTask != null && isMergeQueued(mergeLiveTask)}
      />
      <TaskCompleteDialog
        open={completeOpen}
        onOpenChange={setCompleteOpen}
        task={completeTask}
      />
      <TaskDeliverPrDialog
        open={deliverOpen}
        onOpenChange={setDeliverOpen}
        task={deliverTask}
      />
      {/* Rendered after the sheet, like the transcript viewer: both portal to
          body and the later mount stacks above, so a cancel / restart asked
          for from inside the drawer lands on top of it. */}
      <TaskCancelDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        task={cancelTask}
      />
      <TaskRestartDialog
        open={restartOpen}
        onOpenChange={setRestartOpen}
        task={restartTask}
        kind={restartKind}
      />
      <TaskFollowUpDialog
        open={followUpOpen}
        onOpenChange={setFollowUpOpen}
        task={followUpTask}
      />
      <TaskScheduleDialog
        open={scheduleOpen && scheduleTask != null}
        onOpenChange={setScheduleOpen}
        task={scheduleTask}
      />
      {/* The BOARD's session viewer — the card's "查看会话", opened with no
          detail sheet in play. The sheet's own copy of this viewer lives
          inside it (see `task-detail-sheet.tsx`), because Base UI stacks a
          drawer only over an ancestor drawer, never over a sibling. */}
      <TaskTranscriptDialog
        open={sessionOpen && sessionTask != null}
        onOpenChange={setSessionOpen}
        task={sessionTask}
      />
    </>
  )

  return {
    act,
    handlersFor,
    openDetail: setDetailTaskId,
    openNewTask,
    dialogs,
  }
}
