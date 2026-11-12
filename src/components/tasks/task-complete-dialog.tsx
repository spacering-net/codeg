"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { workTaskComplete, workTaskSettingsEffective } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { isWorktreeGone } from "./task-acceptance"
import { ThreadCommentSection, useThreadComment } from "./task-thread-comment"
import type { WorkTask } from "@/lib/types"

interface TaskCompleteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: WorkTask | null
}

/**
 * Accept a reviewed task without a merge — because it changed nothing, or
 * because its worktree is gone and no merge could run. There is no commit
 * message to write, so the only decision left is what happens to the (empty)
 * worktree — one checkbox and a confirm; with the worktree gone even that
 * choice disappears (the engine converges the leftovers itself, sparing a
 * branch that still holds work). Unlike the merge dialog this settles
 * synchronously: the command returns once the task is `done`, so a failure
 * belongs in the dialog rather than on the card.
 */
export function TaskCompleteDialog({
  open,
  onOpenChange,
  task,
}: TaskCompleteDialogProps) {
  const t = useTranslations("Tasks")
  const [deleteWorktree, setDeleteWorktree] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const worktreeGone = task != null && isWorktreeGone(task)
  const hasWorktree = task?.worktree_folder_id != null && !worktreeGone
  const comment = useThreadComment(task, open)

  useEffect(() => {
    if (!open || !task) return
    // Same seed as the merge dialog: the folder's worktree-cleanup default.
    /* eslint-disable react-hooks/set-state-in-effect */
    setSubmitting(false)
    let cancelled = false
    workTaskSettingsEffective(task.folder_id)
      .then((s) => {
        if (cancelled) return
        setDeleteWorktree(s.delete_worktree_default)
      })
      .catch(() => {
        if (cancelled) return
        setDeleteWorktree(true)
      })
    return () => {
      cancelled = true
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, task])

  const submit = async () => {
    if (!task) return
    setSubmitting(true)
    try {
      // The comment's answer first: completing is what posts it.
      await comment.persist()
      await workTaskComplete(task.id, hasWorktree && deleteWorktree)
      onOpenChange(false)
    } catch (e) {
      toast.error(toErrorMessage(e))
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={comment.applies ? "sm:max-w-[34rem]" : "sm:max-w-[28rem]"}
      >
        <DialogHeader>
          <DialogTitle>{t("completeTitle")}</DialogTitle>
          <DialogDescription>
            {worktreeGone
              ? t("completeDescriptionNoWorktree")
              : t("completeDescription")}
          </DialogDescription>
        </DialogHeader>

        {hasWorktree ? (
          <Label className="text-sm font-normal">
            <Checkbox
              checked={deleteWorktree}
              onCheckedChange={(v) => setDeleteWorktree(v === true)}
            />
            {t("completeDeleteWorktree")}
          </Label>
        ) : null}

        <ThreadCommentSection comment={comment} disabled={submitting} />

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t("cancel")}
          </Button>
          <Button type="button" onClick={submit} disabled={submitting}>
            {t("completeSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
