"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { workTaskCancel } from "@/lib/api"
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
import { Textarea } from "@/components/ui/textarea"
import { isWorktreeGone } from "./task-acceptance"
import type { WorkTask } from "@/lib/types"

interface TaskCancelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: WorkTask | null
}

/**
 * Stop a task, on the record. A cancel almost always has a reason the board
 * cannot infer — wrong approach, changed requirements, started by mistake —
 * and that is exactly what the person requeuing it weeks later wants to read.
 * The reason rides the `canceled` entry of the progress timeline; it is a note
 * for humans and never reaches a later run's prompt (a requeue carries its own
 * note for that).
 *
 * Optional on purpose: an unexplained stop is still a legitimate stop, so the
 * confirm never waits on the textarea. Reached from the board card's cancel
 * button, and from the drawer's cancel / abandon — one backend transition, one
 * dialog.
 *
 * The second decision is what happens to the worktree the run was living in,
 * offered here so a stop that is really an abandon can reclaim its disk in one
 * gesture instead of two. Unlike the acceptances this one starts UNCHECKED and
 * is not seeded from the folder's `delete_worktree_default`: that default is
 * about landing finished work, whereas a cancel leaves a task that can be
 * requeued, and the removal deletes the work branch along with the directory —
 * everything the run produced. Opting in is the user's to make each time.
 */
export function TaskCancelDialog({
  open,
  onOpenChange,
  task,
}: TaskCancelDialogProps) {
  const t = useTranslations("Tasks")
  const [reason, setReason] = useState("")
  const [deleteWorktree, setDeleteWorktree] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // Recorded AND still on disk. One already gone has nothing to remove, and the
  // backend's cleanup would only converge leftovers the card reports itself.
  const hasWorktree = task != null && !isWorktreeGone(task)

  useEffect(() => {
    if (!open) return
    // A fresh box per open — a reason belongs to one cancel, not to the next,
    // and neither does a checkbox that destroys a branch.
    /* eslint-disable react-hooks/set-state-in-effect */
    setReason("")
    setDeleteWorktree(false)
    setSubmitting(false)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, task])

  const submit = async () => {
    if (!task) return
    setSubmitting(true)
    try {
      await workTaskCancel(
        task.id,
        reason.trim() || null,
        hasWorktree && deleteWorktree
      )
      onOpenChange(false)
    } catch (e) {
      toast.error(toErrorMessage(e))
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[28rem]">
        <DialogHeader>
          <DialogTitle>{t("cancelTitle")}</DialogTitle>
          <DialogDescription>{t("cancelDescription")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="task-cancel-reason">{t("cancelReasonLabel")}</Label>
          <Textarea
            id="task-cancel-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("cancelReasonPlaceholder")}
            rows={3}
            autoFocus
          />
        </div>

        {hasWorktree ? (
          <Label className="text-sm font-normal">
            <Checkbox
              checked={deleteWorktree}
              onCheckedChange={(v) => setDeleteWorktree(v === true)}
            />
            {t("cancelDeleteWorktree")}
          </Label>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t("cancelKeep")}
          </Button>
          <Button type="button" onClick={submit} disabled={submitting}>
            {t("cancelSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
