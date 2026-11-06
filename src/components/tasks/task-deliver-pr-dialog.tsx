"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { workTaskDeliverPr, workTaskSettingsEffective } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { useFreshFolderForgeRemote } from "@/lib/forge-provider-cache"
import { sourceItems } from "@/lib/forge-source-items"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  deliversIntoOpenPr,
  isWorktreeGone,
  mustDeliverToPr,
  usesMergeRequests,
} from "./task-acceptance"
import type { WorkTask } from "@/lib/types"

interface TaskDeliverPrDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: WorkTask | null
}

/**
 * Accept a reviewed task by delivering it to a forge. Three shapes, because
 * what "deliver" means depends on where the task stands:
 *
 * - a task with no pull request yet — an ISSUE's, which links and closes the
 *   issue, or an ordinary one, on the repository its project's `origin` names
 *   — publishes its own branch and opens (or adopts) the pull request that
 *   carries it: the title and the draft flag are the decisions it takes;
 * - a PULL REQUEST's task pushes back onto that pull request's own branch;
 * - a task an earlier delivery opened a pull request for, and that stayed in
 *   review after it, pushes its new round into that same pull request.
 *
 * The last two create nothing, so there is nothing to name: the dialog says
 * where the commits are about to go and asks for a confirmation. Everything
 * else — which repository, which account, which base branch, the body with
 * its closing keyword — is derived by the backend, so nothing typed in this
 * dialog can point the push somewhere else.
 *
 * Every shape asks whether the delivery FINISHES the task (it does unless the
 * user says otherwise). One that does not keeps the task in review with the
 * pull request recorded — for another round on the same branch once its
 * review comes back — and keeps its checkout for that round. Only a delivery
 * that finishes the task asks what the other two acceptances ask: what
 * happens to the worktree it ran in. Delivering publishes the commits first,
 * so the worktree — and the local branch that goes with it — is as expendable
 * there as after a merge. It is still a choice rather than a consequence,
 * because the review it just fed is open and a second round on this branch is
 * a normal next step.
 *
 * A task made from several related issues opens ONE pull request for all of
 * them, and its first delivery asks which of them it closes: the agent's reply
 * says, issue by issue, whether each report held up, and an issue the work did
 * not resolve is referenced instead of closed. That answer is fixed from then
 * on (the backend refuses a different one), so once the task has it the list
 * only shows here — every later pull request the task opens closes the same
 * issues.
 *
 * Like the complete dialog and unlike the merge dialog, this settles
 * synchronously: no agent runs, so the command returns once the task has
 * settled, and a failure belongs here rather than on the card.
 */
export function TaskDeliverPrDialog({
  open,
  onOpenChange,
  task,
}: TaskDeliverPrDialogProps) {
  const t = useTranslations("Tasks")
  const [title, setTitle] = useState("")
  const [draft, setDraft] = useState(false)
  // Finishing the task is what a delivery has always done, so it stays the
  // answer until the user changes it.
  const [markDone, setMarkDone] = useState(true)
  // Off until the folder's default has been read: the seed below is one await
  // away, and a submit that beats it must not delete a worktree on the
  // strength of a value nobody chose — including the value the LAST task
  // opened in this dialog resolved to.
  const [deleteWorktree, setDeleteWorktree] = useState(false)
  // Whether the box has been touched since this open. The seed is async, so
  // without this a user who clears the box inside that window has the folder
  // default land on top of the choice they just made — on the one control
  // here that destroys something.
  const worktreeChoiceMade = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  // A task of several issues: which ones the pull request closes.
  const items =
    task?.source_kind === "forge_issue" && task.source_meta != null
      ? sourceItems(task.source_meta)
      : []
  const several = items.length > 1
  const fixedCloses = several ? (task?.source_meta?.pr_closes ?? null) : null
  const [closes, setCloses] = useState<ReadonlySet<number>>(() => new Set())
  // The board only offers delivery while the worktree is there, so this is
  // normally true — it guards the stale card, keeping the request honest
  // rather than asking the backend to remove something already gone.
  const hasWorktree = task != null && !isWorktreeGone(task)
  // An ordinary task not delivered yet goes to its project's `origin`, which
  // the backend reads when the delivery runs — so this dialog reads it fresh
  // too, names what it read, and sends nothing until it has an answer that is
  // a forge codeg can deliver to. A remembered answer could name one
  // repository while the push went to another.
  const firstLocal =
    task != null && task.source_kind == null && task.delivery == null
  const fresh = useFreshFolderForgeRemote(
    open && firstLocal ? task.folder_id : null
  )
  const freshRemote = fresh.status === "ready" ? fresh.remote : null
  const remoteBlocked = firstLocal && freshRemote?.supported !== true

  useEffect(() => {
    if (!open || !task) return
    /* eslint-disable react-hooks/set-state-in-effect */
    setSubmitting(false)
    setDraft(false)
    setMarkDone(true)
    setTitle(task.title)
    setDeleteWorktree(false)
    // The fixed list when there is one, otherwise every issue ticked.
    setCloses(
      new Set(
        task.source_meta?.pr_closes ??
          (task.source_meta ? sourceItems(task.source_meta) : []).map(
            (item) => item.number
          )
      )
    )
    worktreeChoiceMade.current = false
    // Same seed as the merge and complete dialogs: the folder's
    // worktree-cleanup default, and `true` when it cannot be read (which is
    // what those two fall back to as well). It lands only on a box the user
    // has not answered yet — a default arriving late is still a default.
    let cancelled = false
    const seed = (value: boolean) => {
      if (cancelled || worktreeChoiceMade.current) return
      setDeleteWorktree(value)
    }
    workTaskSettingsEffective(task.folder_id)
      .then((s) => seed(s.delete_worktree_default))
      .catch(() => seed(true))
    return () => {
      cancelled = true
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, task])

  const pushBack = task != null && mustDeliverToPr(task)
  // Into the pull request an earlier delivery opened: nothing to name either.
  const intoOpen = task != null && deliversIntoOpenPr(task)
  const opensOne = !pushBack && !intoOpen
  // GitLab's word for the same thing. Only the wording differs — every step
  // below is the same push and the same lookup.
  const mr = usesMergeRequests(task, freshRemote?.provider)
  // The worktree goes only with a delivery that finishes the task: one kept
  // in review runs its next round right there.
  const cleanup = hasWorktree && markDone && deleteWorktree
  // Chosen here only before the task's first delivery fixed it, and only by a
  // delivery that opens the pull request.
  const closesEditable = several && fixedCloses == null && opensOne

  const submit = async () => {
    if (!task || remoteBlocked) return
    setSubmitting(true)
    try {
      // A push into an existing pull request creates nothing, so it carries
      // neither title nor draft.
      // The closing list only travels when this delivery is the one that
      // fixes it — every other call is exactly what it always was.
      const picked = items
        .map((item) => item.number)
        .filter((n) => closes.has(n))
      const url = !opensOne
        ? await workTaskDeliverPr(task.id, null, false, cleanup, markDone)
        : closesEditable
          ? await workTaskDeliverPr(
              task.id,
              title.trim() || null,
              draft,
              cleanup,
              markDone,
              picked
            )
          : await workTaskDeliverPr(
              task.id,
              title.trim() || null,
              draft,
              cleanup,
              markDone
            )
      onOpenChange(false)
      const done = pushBack
        ? mr
          ? t("deliverPrBackDoneMr")
          : t("deliverPrBackDone")
        : intoOpen
          ? mr
            ? t("deliverPrUpdateDoneMr")
            : t("deliverPrUpdateDone")
          : mr
            ? t("deliverPrDoneMr")
            : t("deliverPrDone")
      toast.success(done, {
        action: {
          label: t("deliverPrOpen"),
          onClick: () => window.open(url, "_blank", "noopener,noreferrer"),
        },
      })
    } catch (e) {
      toast.error(toErrorMessage(e))
      setSubmitting(false)
    }
  }

  const repo =
    task?.source_meta?.owner_repo ??
    task?.delivery?.owner_repo ??
    freshRemote?.owner_repo ??
    ""
  const base = task?.base_branch ?? ""
  // As a string: a message placeholder would otherwise be number-formatted,
  // and "#1,234" is not a pull request number anyone recognizes.
  const number = String(task?.source_meta?.number ?? "")
  const branch = task?.source_meta?.head_ref ?? ""
  const workBranch = task?.work_branch ?? ""
  const fromIssue = task?.source_kind === "forge_issue"

  const heading = pushBack
    ? mr
      ? t("deliverPrBackTitleMr")
      : t("deliverPrBackTitle")
    : intoOpen
      ? mr
        ? t("deliverPrUpdateTitleMr")
        : t("deliverPrUpdateTitle")
      : mr
        ? t("deliverPrTitleMr")
        : t("deliverPrTitle")
  const description = pushBack
    ? mr
      ? t("deliverPrBackDescriptionMr", { repo, number, branch })
      : t("deliverPrBackDescription", { repo, number, branch })
    : intoOpen
      ? mr
        ? t("deliverPrUpdateDescriptionMr", { repo, branch: workBranch })
        : t("deliverPrUpdateDescription", { repo, branch: workBranch })
      : fromIssue && several
        ? mr
          ? t("deliverPrDescriptionIssuesMr", { repo, base })
          : t("deliverPrDescriptionIssues", { repo, base })
        : fromIssue
          ? mr
            ? t("deliverPrDescriptionMr", { repo, base })
            : t("deliverPrDescription", { repo, base })
          : remoteBlocked
            ? fresh.status === "failed"
              ? t("deliverPrRemoteFailed")
              : fresh.status === "ready"
                ? t("deliverPrRemoteUnsupported")
                : t("deliverPrRemoteLoading")
            : mr
              ? t("deliverPrDescriptionLocalMr", { repo, base })
              : t("deliverPrDescriptionLocal", { repo, base })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[30rem]">
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {opensOne ? (
            <>
              <Label className="flex flex-col items-start gap-1.5 text-sm font-normal">
                {t(mr ? "deliverPrTitleLabelMr" : "deliverPrTitleLabel")}
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={submitting}
                />
              </Label>
              <Label className="text-sm font-normal">
                <Checkbox
                  checked={draft}
                  onCheckedChange={(v) => setDraft(v === true)}
                  disabled={submitting}
                />
                {t("deliverPrDraft")}
              </Label>
            </>
          ) : null}
          {several ? (
            <fieldset className="flex min-w-0 flex-col gap-1.5">
              <legend className="mb-1.5 text-sm">
                {t("deliverPrClosesLabel")}
              </legend>
              <div className="flex max-h-40 flex-col gap-1.5 overflow-y-auto">
                {items.map((item) => (
                  <Label
                    key={item.number}
                    className="min-w-0 text-sm font-normal"
                  >
                    <Checkbox
                      checked={closes.has(item.number)}
                      onCheckedChange={(v) =>
                        setCloses((held) => {
                          const next = new Set(held)
                          if (v === true) next.add(item.number)
                          else next.delete(item.number)
                          return next
                        })
                      }
                      disabled={submitting || !closesEditable}
                    />
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      #{item.number}
                    </span>
                    <span className="min-w-0 truncate" title={item.title}>
                      {item.title}
                    </span>
                  </Label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {closesEditable
                  ? t("deliverPrClosesHint")
                  : t(mr ? "deliverPrClosesFixedMr" : "deliverPrClosesFixed")}
              </p>
            </fieldset>
          ) : null}
          <div className="flex flex-col gap-2">
            <Label className="text-sm font-normal">
              <Checkbox
                checked={markDone}
                onCheckedChange={(v) => setMarkDone(v === true)}
                disabled={submitting}
              />
              {t(pushBack ? "deliverPrBackMarkDone" : "deliverPrMarkDone")}
            </Label>
            {/* Depends on the box above, and reads that way: indented under
                it, and greyed out with it — a task kept in review keeps the
                checkout its next round runs in. Unticking above remembers the
                answer here for when it is ticked again. */}
            {hasWorktree ? (
              <div
                className="group pl-6"
                data-disabled={markDone ? undefined : "true"}
              >
                <Label className="text-sm font-normal">
                  <Checkbox
                    checked={markDone && deleteWorktree}
                    onCheckedChange={(v) => {
                      worktreeChoiceMade.current = true
                      setDeleteWorktree(v === true)
                    }}
                    disabled={submitting || !markDone}
                  />
                  {t(
                    pushBack
                      ? "deliverPrBackDeleteWorktree"
                      : "deliverPrDeleteWorktree"
                  )}
                </Label>
              </div>
            ) : null}
            {markDone ? null : (
              <p className="text-xs text-muted-foreground">
                {t(mr ? "deliverPrKeepOpenHintMr" : "deliverPrKeepOpenHint")}
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={submitting || remoteBlocked}
          >
            {submitting
              ? t("deliverPrSubmitting")
              : pushBack
                ? t("deliverPrBackSubmit")
                : intoOpen
                  ? t("deliverPrUpdateSubmit")
                  : t("deliverPrSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
