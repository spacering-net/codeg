"use client"

import { useCallback, useEffect, useState } from "react"
import { subscribe } from "@/lib/platform"
import { AlertTriangle, Check, FileWarning, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  gitListConflicts,
  gitAbortOperation,
  gitContinueOperation,
  openMergeWindow,
} from "@/lib/api"
import type { GitConflictInfo } from "@/lib/types"

interface ConflictDialogProps {
  conflictInfo: GitConflictInfo | null
  folderId: number
  folderPath: string
  onClose: () => void
  onResolved: () => void
}

export function ConflictDialog({
  conflictInfo,
  folderId,
  folderPath,
  onClose,
  onResolved,
}: ConflictDialogProps) {
  const t = useTranslations("Folder.branchDropdown.conflict")
  const [conflictedFiles, setConflictedFiles] = useState<string[]>([])
  const [resolvedFiles, setResolvedFiles] = useState<Set<string>>(new Set())
  const [aborting, setAborting] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [done, setDone] = useState(false)

  const open = conflictInfo !== null
  const operation = conflictInfo?.operation ?? "merge"

  // Initialize conflict files from conflictInfo. Adjusted during render
  // (React's "reset state on prop change" pattern); `prevConflictInfo` starts
  // null so a dialog mounted already open initializes on its first render.
  const [prevConflictInfo, setPrevConflictInfo] =
    useState<GitConflictInfo | null>(null)
  if (conflictInfo !== prevConflictInfo) {
    setPrevConflictInfo(conflictInfo)
    if (conflictInfo) {
      setConflictedFiles(conflictInfo.conflicted_files)
      setResolvedFiles(new Set())
      setDone(false)
    }
  }

  // Refresh conflict list to detect resolved files
  const refreshConflicts = useCallback(async () => {
    if (!folderPath || !open) return
    try {
      const remaining = await gitListConflicts(folderPath)
      const nowResolved = new Set(
        conflictedFiles.filter((f) => !remaining.includes(f))
      )
      setResolvedFiles(nowResolved)
    } catch {
      // ignore refresh errors
    }
  }, [folderPath, open, conflictedFiles])

  // Listen for merge events from the merge window
  useEffect(() => {
    if (!open) return

    let unlistenResolved: (() => void) | null = null
    let unlistenCompleted: (() => void) | null = null
    let unlistenAborted: (() => void) | null = null

    subscribe<{ folder_id: number; file: string }>(
      "folder://merge-conflict-resolved",
      (payload) => {
        if (payload.folder_id !== folderId) return
        setResolvedFiles((prev) => new Set([...prev, payload.file]))
      }
    )
      .then((fn) => {
        unlistenResolved = fn
      })
      .catch(() => {})

    subscribe<{ folder_id: number }>("folder://merge-completed", (payload) => {
      if (payload.folder_id !== folderId) return
      setDone(true)
      onResolved()
      onClose()
    })
      .then((fn) => {
        unlistenCompleted = fn
      })
      .catch(() => {})

    // Merge was aborted (user clicked abort in merge window, or window closed)
    // Reset resolved state since abort reverts all changes
    subscribe<{ folder_id: number }>("folder://merge-aborted", (payload) => {
      if (payload.folder_id !== folderId) return
      setDone(true)
      setResolvedFiles(new Set())
      onClose()
    })
      .then((fn) => {
        unlistenAborted = fn
      })
      .catch(() => {})

    return () => {
      unlistenResolved?.()
      unlistenCompleted?.()
      unlistenAborted?.()
    }
  }, [open, folderId, onResolved, onClose])

  // Periodically refresh conflict status (skip for pull — merge is aborted
  // until the merge tool re-starts it, so git index has no conflicts yet)
  useEffect(() => {
    if (!open || operation === "pull") return
    const interval = setInterval(refreshConflicts, 3000)
    return () => clearInterval(interval)
  }, [open, operation, refreshConflicts])

  const allResolved =
    conflictedFiles.length > 0 &&
    conflictedFiles.every((f) => resolvedFiles.has(f))

  async function handleOpenMergeTool() {
    try {
      await openMergeWindow(folderId, operation, conflictInfo?.upstream_commit)
    } catch (err) {
      toast.error(String(err))
    }
  }

  async function handleAbort() {
    // For pull operations, the merge was already aborted during conflict
    // detection, so there's nothing to abort — just close the dialog.
    if (operation === "pull") {
      onClose()
      return
    }
    setAborting(true)
    try {
      await gitAbortOperation(folderPath, operation)
      toast.success(t("abortSuccess"))
      onClose()
      onResolved()
    } catch (err) {
      toast.error(String(err))
    } finally {
      setAborting(false)
    }
  }

  async function handleComplete() {
    if (done) return
    setCompleting(true)
    try {
      await gitContinueOperation(folderPath, operation)
      toast.success(t("completeSuccess"))
      onResolved()
      onClose()
    } catch (err) {
      toast.error(String(err))
    } finally {
      setCompleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-60">
          <div className="space-y-1 pr-3">
            {conflictedFiles.map((file) => {
              const isResolved = resolvedFiles.has(file)
              return (
                <div
                  key={file}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
                >
                  {isResolved ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-green-500" />
                  ) : (
                    <FileWarning className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                  )}
                  <span
                    className={
                      isResolved
                        ? "text-muted-foreground line-through"
                        : "text-foreground"
                    }
                  >
                    {file}
                  </span>
                </div>
              )
            })}
          </div>
        </ScrollArea>

        <DialogFooter className="flex-row justify-between sm:justify-between">
          <Button
            variant="destructive"
            size="sm"
            onClick={handleAbort}
            disabled={aborting || completing}
          >
            {aborting && (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            )}
            {t("abort")}
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleOpenMergeTool}
              disabled={aborting || completing}
            >
              {t("openMergeTool")}
            </Button>
            {allResolved && (
              <Button
                size="sm"
                onClick={handleComplete}
                disabled={completing || aborting || done}
              >
                {completing && (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                )}
                {t("completeMerge")}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
