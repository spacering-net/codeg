"use client"

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ConflictDialog } from "@/components/layout/conflict-dialog"
import { StashDialog } from "@/components/layout/stash-dialog"
import { useAlertContext } from "@/contexts/alert-context"
import { useGitCredential } from "@/contexts/git-credential-context"
import { useTaskContext } from "@/contexts/task-context"
import {
  gitFetch,
  gitPull,
  gitUpdateBranch,
  openCommitWindow,
  openPushWindow,
  openStashWindow,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import type { GitConflictInfo } from "@/lib/types"

const emitEvent = async (event: string, payload?: unknown) => {
  try {
    const { emit } = await import("@tauri-apps/api/event")
    await emit(event, payload)
  } catch {
    /* not in Tauri */
  }
}

/** The repo a dialog acts on, captured when the dialog is raised. */
interface GitDialogTarget {
  id: number
  path: string
}

export interface GitQuickActions {
  /** A git task is in flight — callers disable their operation rows/buttons. */
  running: boolean
  /**
   * Run a git operation as a tracked task: pushes a TaskContext entry, toasts
   * success/failure, refreshes the folder and broadcasts
   * `folder://git-branch-changed` so every other git view re-reads.
   *
   * `getSuccessDescription` may return `false` to suppress the success toast
   * entirely (used when the result opens a conflict dialog instead).
   * `onError` returning `true` claims the error — no alert/toast is emitted.
   */
  runGitTask: <T>(
    label: string,
    action: () => Promise<T>,
    getSuccessDescription?: (result: T) => string | false | undefined,
    onError?: (errorMessage: string) => boolean
  ) => Promise<void>
  /** Pull the checked-out branch (conflicts open the merge dialog). */
  pull: () => void
  /** `git fetch --all`. */
  fetchAll: () => void
  /** Update a branch without checking it out (see `gitUpdateBranch`). */
  updateBranch: (fullName: string, isRemote: boolean) => void
  /**
   * Hand a conflicting result to the merge dialog. Operations the hook doesn't
   * own (merge / rebase) call this from their own `runGitTask` success handler.
   */
  reportConflict: (conflict: GitConflictInfo) => void
  openCommitWindow: () => void
  /** `branch` preselects the push target; omitted means the checked-out one. */
  openPushWindow: (branch?: string) => void
  /** Open the in-place "stash changes" dialog. */
  openStashDialog: () => void
  /** Open the unstash workspace window. */
  openUnstashWindow: () => void
  /** Conflict + stash dialogs — render this once wherever the hook is used. */
  dialogs: ReactNode
}

interface UseGitQuickActionsOptions {
  folderId: number | null
  folderPath: string | null
  /** Called after a task succeeds (and after a stash), to refresh the caller. */
  onCompleted?: () => void
}

/**
 * The shared git-operation engine behind the branch selector, the "changes"
 * aux tab and the "commits" aux tab.
 *
 * Every network-bound operation goes through `withCredentialRetry`, so a repo
 * whose credentials aren't stored yet prompts once and retries rather than
 * failing with an opaque auth error.
 */
export function useGitQuickActions({
  folderId,
  folderPath,
  onCompleted,
}: UseGitQuickActionsOptions): GitQuickActions {
  const t = useTranslations("Folder.branchDropdown")
  const { addTask, updateTask, removeTask } = useTaskContext()
  const { pushAlert } = useAlertContext()
  const { withCredentialRetry } = useGitCredential()
  const refreshFolder = useAppWorkspaceStore((s) => s.refreshFolder)

  const [running, setRunning] = useState(false)
  // Both dialogs carry the repo they belong to rather than reading the hook's
  // CURRENT folder. The aux-panel git tabs are force-mounted and follow the
  // active folder, so a slow pull started on repo A can resolve after the panel
  // has moved to repo B — binding the dialog to the folder captured when the
  // operation started keeps the merge tool pointed at A's working tree instead
  // of replaying A's upstream commit into B.
  const [stashTarget, setStashTarget] = useState<GitDialogTarget | null>(null)
  const [conflict, setConflict] = useState<{
    target: GitDialogTarget
    info: GitConflictInfo
  } | null>(null)
  const taskSeq = useRef(0)

  // Keep the completion callback in a ref so an inline arrow from the caller
  // doesn't re-identify every handler below on each render.
  // Synced in a layout effect rather than during render; it is only read once
  // a git task or dialog settles, always after the commit.
  const onCompletedRef = useRef(onCompleted)
  useLayoutEffect(() => {
    onCompletedRef.current = onCompleted
  })

  // The folder this render's handlers act on. Every callback below closes over
  // it, so a handler invoked while folder A is active keeps acting on A even
  // after the hook re-renders under folder B.
  const target = useMemo<GitDialogTarget | null>(
    () =>
      folderId != null && folderPath
        ? { id: folderId, path: folderPath }
        : null,
    [folderId, folderPath]
  )

  const refresh = useCallback(() => {
    if (folderId) void refreshFolder(folderId)
    onCompletedRef.current?.()
  }, [folderId, refreshFolder])

  // Refresh a specific repo — used by dialog callbacks, which resolve against
  // the folder the dialog was opened for, not whichever one is active now.
  const refreshTarget = useCallback(
    (dialogTarget: GitDialogTarget) => {
      void refreshFolder(dialogTarget.id)
      onCompletedRef.current?.()
    },
    [refreshFolder]
  )

  const runGitTask = useCallback(
    async <T,>(
      label: string,
      action: () => Promise<T>,
      getSuccessDescription?: (result: T) => string | false | undefined,
      onError?: (errorMessage: string) => boolean
    ) => {
      const taskId = `git-${++taskSeq.current}-${Date.now()}`
      setRunning(true)
      addTask(taskId, label)
      updateTask(taskId, { status: "running" })
      try {
        const result = await action()
        const successDescription = getSuccessDescription?.(result)
        updateTask(taskId, { status: "completed" })
        refresh()
        void emitEvent("folder://git-branch-changed", { folder_id: folderId })
        if (successDescription !== false) {
          toast.success(
            t("toasts.taskCompleted", { label }),
            successDescription ? { description: successDescription } : undefined
          )
        }
      } catch (err) {
        removeTask(taskId)
        const errorMessage = toErrorMessage(err)
        if (onError?.(errorMessage)) return
        const errorTitle = t("toasts.taskFailed", { label })
        pushAlert("error", errorTitle, errorMessage)
        toast.error(errorTitle, { description: errorMessage })
      } finally {
        setRunning(false)
      }
    },
    [addTask, folderId, pushAlert, refresh, removeTask, t, updateTask]
  )

  const reportConflict = useCallback(
    (info: GitConflictInfo) => {
      if (!target) return
      setConflict({ target, info })
    },
    [target]
  )

  // Shared success reporting for pull-shaped results (pull + update branch):
  // a conflict opens the merge dialog instead of toasting.
  const describePullResult = useCallback(
    (result: { updated_files: number; conflict?: GitConflictInfo | null }) => {
      if (result.conflict?.has_conflicts) {
        reportConflict(result.conflict)
        return false as const
      }
      if (result.updated_files === 0) return t("toasts.allFilesUpToDate")
      return t("toasts.updatedFiles", { count: result.updated_files })
    },
    [reportConflict, t]
  )

  const pull = useCallback(() => {
    if (!folderPath) return
    void runGitTask(
      t("tasks.pullCode"),
      () =>
        withCredentialRetry((creds) => gitPull(folderPath, creds), {
          folderPath,
        }),
      describePullResult
    )
  }, [describePullResult, folderPath, runGitTask, t, withCredentialRetry])

  const fetchAll = useCallback(() => {
    if (!folderPath) return
    void runGitTask(t("tasks.fetchInfo"), () =>
      withCredentialRetry((creds) => gitFetch(folderPath, creds), {
        folderPath,
      })
    )
  }, [folderPath, runGitTask, t, withCredentialRetry])

  const updateBranch = useCallback(
    (fullName: string, isRemote: boolean) => {
      if (!folderPath) return
      void runGitTask(
        t("tasks.updateBranch", { branchName: fullName }),
        () =>
          withCredentialRetry(
            (creds) => gitUpdateBranch(folderPath, fullName, isRemote, creds),
            { folderPath }
          ),
        describePullResult
      )
    },
    [describePullResult, folderPath, runGitTask, t, withCredentialRetry]
  )

  // Window openers report their own failure — they don't touch the repo, so
  // they're not worth a task entry.
  const openWindow = useCallback(
    (open: (id: number) => Promise<void>, failureTitle: string) => {
      if (!folderId) return
      open(folderId).catch((err) => {
        const message = toErrorMessage(err)
        pushAlert("error", failureTitle, message)
        toast.error(failureTitle, { description: message })
      })
    },
    [folderId, pushAlert]
  )

  const openCommit = useCallback(() => {
    openWindow(openCommitWindow, t("toasts.openCommitWindowFailed"))
  }, [openWindow, t])

  const openPush = useCallback(
    (branch?: string) => {
      openWindow(
        (id) => openPushWindow(id, branch),
        t("toasts.openPushWindowFailed")
      )
    },
    [openWindow, t]
  )

  const openUnstash = useCallback(() => {
    openWindow(openStashWindow, t("toasts.openStashWindowFailed"))
  }, [openWindow, t])

  const openStashDialog = useCallback(() => {
    if (!target) return
    setStashTarget(target)
  }, [target])

  const dialogs = useMemo(
    () => (
      <>
        <ConflictDialog
          conflictInfo={conflict?.info ?? null}
          folderId={conflict?.target.id ?? 0}
          folderPath={conflict?.target.path ?? ""}
          onClose={() => setConflict(null)}
          onResolved={() => {
            if (conflict) refreshTarget(conflict.target)
          }}
        />
        <StashDialog
          open={stashTarget !== null}
          folderPath={stashTarget?.path ?? ""}
          onClose={() => setStashTarget(null)}
          onStashed={() => {
            if (stashTarget) refreshTarget(stashTarget)
          }}
        />
      </>
    ),
    [conflict, refreshTarget, stashTarget]
  )

  return {
    running,
    runGitTask,
    pull,
    fetchAll,
    updateBranch,
    reportConflict,
    openCommitWindow: openCommit,
    openPushWindow: openPush,
    openStashDialog,
    openUnstashWindow: openUnstash,
    dialogs,
  }
}
