"use client"

import { useCallback } from "react"
import { useOptionalWorkbenchRoute } from "@/contexts/workbench-route-context"
import { workTaskGet } from "@/lib/api"
import type { WorkTask } from "@/lib/types"

/** What opening a task's conversation came to. */
export type OpenTaskConversationResult =
  /** The conversation is open in a tab. */
  | "opened"
  /** The task is starting (queued / preparing): its conversation may still be
   *  replaced, so nothing was opened. */
  | "starting"
  /** The task has no conversation (or the server could not say which). */
  | "none"

/** Whether a task's binding may still change under a click (a resume fallback
 *  binds its replacement only once the run starts). */
export function taskConversationSettling(task: Pick<WorkTask, "status">) {
  return task.status === "queued" || task.status === "preparing"
}

/**
 * Open a to-do task's conversation as a real tab — where its model and
 * options are changed with the conversation's own selectors (codeg#1179); the
 * next retry / return / merge continues that conversation with them.
 *
 * Resolves the CURRENT binding when called (a fresh `workTaskGet`), never one
 * fetched earlier: an inline retry can re-link the task to a new
 * conversation while a sheet stays open.
 */
export function useOpenTaskConversation() {
  const route = useOptionalWorkbenchRoute()
  return useCallback(
    async (taskId: number): Promise<OpenTaskConversationResult> => {
      const fresh = await workTaskGet(taskId)
      if (taskConversationSettling(fresh)) return "starting"
      const sel = fresh.conversation_selection
      if (!sel) return "none"
      // Loaded on use: the tab store pulls in the whole workspace store, which
      // the task dialogs never need until the user navigates.
      const { useTabStore } = await import("@/stores/tab-store")
      route?.openConversations()
      useTabStore
        .getState()
        .openTab(sel.folder_id, sel.conversation_id, sel.agent_type, true)
      return "opened"
    },
    [route]
  )
}
