"use client"

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { gitCheckout, resolveWorktreeFolder } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { planBranchSwitch } from "@/lib/branch-switch"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabActions } from "@/contexts/tab-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useTaskContext } from "@/contexts/task-context"
import type { FolderDetail, WorktreeResolution } from "@/lib/types"

const emitEvent = async (event: string, payload?: unknown) => {
  try {
    const { emit } = await import("@tauri-apps/api/event")
    await emit(event, payload)
  } catch {
    /* not in Tauri */
  }
}

export interface SwitchToBranchArgs {
  /** The folder the selector belongs to (top bar: active folder; below input:
   * the draft conversation's folder). May itself be a worktree. */
  activeFolder: FolderDetail
  /** Local branch name to switch to (remote prefixes already stripped). */
  branchName: string
  /** Currently-shown branch for `activeFolder`, used as a cheap no-op guard. */
  currentBranch: string | null
  /**
   * Whether the user picked a *remote* branch entry. Remote selections are
   * always checked out (tracked) in the root working tree — never resolved
   * against local worktrees — so a remote ref like `upstream/feature` is not
   * mistaken for a same-short-name local branch that happens to be checked out
   * in a worktree.
   */
  isRemote?: boolean
}

/**
 * Switch the working-directory environment to a branch. Instead of always
 * `git checkout` (which git refuses when the branch is already checked out in a
 * worktree), this resolves where the branch lives and either navigates the
 * workspace to that folder or checks the branch out in the root working tree.
 * See `planBranchSwitch` for the decision and the plan doc for the rationale.
 */
export function useSwitchToBranch(): (
  args: SwitchToBranchArgs
) => Promise<void> {
  const t = useTranslations("Folder.branchDropdown")
  const { openNewConversationTab } = useTabActions()
  const { openConversations } = useWorkbenchRoute()
  const { addTask, updateTask } = useTaskContext()

  return useCallback(
    async ({
      activeFolder,
      branchName,
      currentBranch,
      isRemote,
    }: SwitchToBranchArgs) => {
      // The UI already hides the current branch, but a poll-cached label can
      // momentarily disagree with git — skip the round-trip for the obvious case.
      if (branchName === currentBranch) return

      // A remote branch is checked out (tracked) as a new local branch in the
      // root working tree — never resolve it against local worktrees, so a
      // remote ref isn't mistaken for a same-short-name local branch that
      // happens to live in a worktree. Skip the resolution round-trip entirely.
      let resolution: WorktreeResolution | null = null
      if (!isRemote) {
        try {
          resolution = await resolveWorktreeFolder(
            activeFolder.path,
            branchName
          )
        } catch (err) {
          toast.error(t("toasts.switchFailed"), {
            description: toErrorMessage(err),
          })
          return
        }
      }

      // Workspace state/actions are event-time reads — getState() sees the
      // lists as of *now* (post-await), never a stale render capture.
      const { allFolders, openWorktreeFolder, setBranch, refreshFolder } =
        useAppWorkspaceStore.getState()

      const plan = planBranchSwitch({
        activeFolder,
        resolution,
        allFolders,
        isRemote: isRemote === true,
      })

      // Re-open a closed/registered-only folder before opening a conversation in
      // it, so `resolveAgentForFolder` can see the folder (and apply its saved
      // default agent). `addFolderToWorkspaceById` awaits the backend upsert.
      const ensureOpen = async (folderId: number) => {
        const workspace = useAppWorkspaceStore.getState()
        if (!workspace.folders.some((f) => f.id === folderId)) {
          await workspace.addFolderToWorkspaceById(folderId)
        }
      }

      switch (plan.kind) {
        case "noop":
          return

        case "navigateRegistered": {
          const target = allFolders.find((f) => f.id === plan.folderId)
          if (!target) return
          try {
            await ensureOpen(target.id)
            // Return to the conversation workspace if a route (e.g.
            // Automations) was covering the content region.
            openConversations()
            openNewConversationTab(target.id, target.path, {
              inheritFromActive: true,
              folderDefaultAgent: target.default_agent_type,
              reuseBlankDraft: true,
            })
            toast.success(t("toasts.switchedToFolder", { name: target.name }))
          } catch (err) {
            toast.error(t("toasts.switchFailed"), {
              description: toErrorMessage(err),
            })
          }
          return
        }

        case "navigateExternal": {
          try {
            const detail = await openWorktreeFolder(plan.path, plan.rootId)
            openConversations()
            openNewConversationTab(detail.id, detail.path, {
              inheritFromActive: true,
              folderDefaultAgent: detail.default_agent_type,
              reuseBlankDraft: true,
            })
            toast.success(t("toasts.switchedToFolder", { name: detail.name }))
          } catch (err) {
            toast.error(t("toasts.switchFailed"), {
              description: toErrorMessage(err),
            })
          }
          return
        }

        case "checkoutInRoot": {
          const root = plan.rootFolder
          // Only switch the working directory when root differs from the active
          // folder; already in root → a plain in-place checkout (no new draft).
          if (root.id !== activeFolder.id) {
            try {
              await ensureOpen(root.id)
              openConversations()
              openNewConversationTab(root.id, root.path, {
                inheritFromActive: true,
                folderDefaultAgent: root.default_agent_type,
                reuseBlankDraft: true,
              })
            } catch (err) {
              toast.error(t("toasts.switchFailed"), {
                description: toErrorMessage(err),
              })
              return
            }
          }

          const label = t("tasks.checkoutTo", { branchName })
          const taskId = `branch-switch-${root.id}-${Date.now()}`
          addTask(taskId, label)
          updateTask(taskId, { status: "running" })
          try {
            await gitCheckout(root.path, branchName)
            updateTask(taskId, { status: "completed" })
            setBranch(root.id, branchName)
            await refreshFolder(root.id)
            void emitEvent("folder://git-branch-changed", {
              folder_id: root.id,
            })
            toast.success(t("toasts.taskCompleted", { label }))
          } catch (err) {
            const msg = toErrorMessage(err)
            updateTask(taskId, { status: "failed", error: msg })
            toast.error(t("toasts.taskFailed", { label }), { description: msg })
          }
          return
        }
      }
    },
    [openConversations, openNewConversationTab, addTask, updateTask, t]
  )
}
