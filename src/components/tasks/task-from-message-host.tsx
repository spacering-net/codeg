"use client"

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { useTasksView } from "@/contexts/tasks-view-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { workTaskCreate } from "@/lib/api"
import {
  closeTaskFromMessage,
  currentTaskFromMessage,
  subscribeTaskFromMessage,
} from "@/lib/task-from-message"
import type { WorkTaskDraft } from "@/lib/types"
import { requestTasksFocus } from "@/lib/workbench-focus"
import { TaskEditorDialog } from "./task-editor-dialog"

/**
 * "Create a task from this message", answered where it was asked: the task
 * editor opens over the conversation, seeded with the message, and the page
 * stays where it was. (It used to switch to the Tasks page and open the editor
 * there, taking the person away from the conversation they were reading to
 * write one task.) Once the task is saved, a toast says so and leads to the
 * board.
 *
 * Any message opens it through `openTaskFromMessage` (task-from-message.ts) —
 * a user message's hover actions or a reply's action row, in a conversation
 * tab, a canvas card or a session drawer — and the workspace mounts this one
 * host, so a long transcript carries no dialog per message.
 */
export function TaskFromMessageHost() {
  const t = useTranslations("Tasks")
  const request = useSyncExternalStore(
    subscribeTaskFromMessage,
    currentTaskFromMessage,
    () => null
  )
  const { refetch } = useTasksView()
  const { routeId, setRoute } = useWorkbenchRoute()
  // Read when the toast is raised and again when its action is clicked, which
  // can be a while later and on another page.
  const routeRef = useRef(routeId)
  useEffect(() => {
    routeRef.current = routeId
  }, [routeId])

  const submit = useCallback(
    async (draft: WorkTaskDraft) => {
      if (!request) return
      const task = await workTaskCreate(draft)
      closeTaskFromMessage(request.id)
      void refetch()
      // Asked from the board itself (a task's session drawer), the card is
      // already on the page behind: nothing to lead to.
      const onBoard = routeRef.current === "tasks"
      toast.success(
        t("createFromMessageDone", { title: task.title }),
        onBoard
          ? undefined
          : {
              action: {
                label: t("createFromMessageView"),
                onClick: () => {
                  // The page reads a focus as it mounts; parked for a board
                  // already on screen, it would only narrow the next visit.
                  if (routeRef.current !== "tasks") {
                    requestTasksFocus({ folderId: task.folder_id })
                  }
                  setRoute("tasks")
                },
              },
            }
      )
    },
    [request, refetch, setRoute, t]
  )

  return (
    <TaskEditorDialog
      open={request != null}
      onOpenChange={(open) => {
        if (!open && request) closeTaskFromMessage(request.id)
      }}
      task={null}
      defaultFolderId={request?.folderId ?? null}
      prefillText={request?.text ?? null}
      onSubmit={submit}
    />
  )
}
