"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { workTaskRequeue, workTaskRetry } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { followUpComposerTarget } from "@/lib/task-follow-up"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  TaskMessageComposer,
  type TaskMessageComposerHandle,
} from "./task-message-composer"
import {
  duplicateActiveSource,
  duplicateActiveSourceLabel,
  type DuplicateActiveSource,
} from "./task-restart-guard"
import type { WorkTask } from "@/lib/types"

export type TaskRestartKind = "retry" | "requeue"

interface TaskRestartDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: WorkTask | null
  /** `retry` for a failed task, `requeue` for a canceled one. */
  kind: TaskRestartKind
}

/**
 * Restart a failed / canceled task from the board, with an optional note for
 * the agent. The drawer can reveal a note box in place; a card has nowhere to
 * unfold one, so the same step happens here.
 *
 * It gets the real composer rather than a textarea for the same reason the
 * drawer's box does: "run pnpm install first" is common, but so is pointing at
 * the file that broke, and `@` references / `/` commands serialize to exactly
 * the string the backend already accepts as the note.
 *
 * Empty is a complete answer — the note is a modifier on the restart, and
 * submitting an untouched box is the plain one-click restart this dialog
 * replaced.
 */
export function TaskRestartDialog({
  open,
  onOpenChange,
  task,
  kind,
}: TaskRestartDialogProps) {
  const t = useTranslations("Tasks")
  // The upload-in-flight toast is the conversation composer's own message.
  const tChat = useTranslations("Folder.chat.messageInput")
  // The whole list: a task's worktree is normally not among the open folders.
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const { shortcuts } = useShortcutSettings()
  const composerRef = useRef<TaskMessageComposerHandle>(null)
  const [text, setText] = useState("")
  const [submitting, setSubmitting] = useState(false)
  /** Synchronous in-flight latch — see `submit`. */
  const submittingRef = useRef(false)
  /** Set when the resurrection guard refused — see `submit`'s catch. */
  const [duplicate, setDuplicate] = useState<DuplicateActiveSource | null>(null)

  // A fresh box per open — a note belongs to one restart, not to the next.
  useEffect(() => {
    if (!open) return
    // Kept as an effect (like the sibling dialogs): the reset also re-arms the
    // submit latch ref, which cannot be written during render.
    /* eslint-disable react-hooks/set-state-in-effect */
    setText("")
    setSubmitting(false)
    setDuplicate(null)
    /* eslint-enable react-hooks/set-state-in-effect */
    submittingRef.current = false
  }, [open, task])

  if (!task) return null

  // No conversation detail on this path (the card never loads one), so the
  // agent resolves from the task's own override → the folder default, the same
  // fallback the drawer runs on before its detail lands.
  const target = followUpComposerTarget({
    task,
    conversationAgentType: null,
    folders: allFolders,
  })

  const submit = async (allowDuplicateSource = false) => {
    // Straight from the editor: reference badges serialize to their inline
    // token here, and this cannot lag a keystroke behind the state.
    const note = (composerRef.current?.getText() ?? text).trim() || null
    // Images / pasted bytes ride beside the note as their own blocks.
    const blocks = composerRef.current?.getAttachmentBlocks() ?? []
    // An unsettled upload has no server-side uri yet, so the block would reach
    // the agent empty. The box keeps its content — this is "wait a moment".
    if (composerRef.current?.hasUploadingImage()) {
      toast.error(tChat("attachUploadInProgress"))
      return
    }
    // A ref, not `submitting`: the send key is read out of a ref inside the
    // editor's own keydown handler, so a second Enter can arrive before React
    // has re-rendered. The backend's CAS would reject the loser anyway — this
    // keeps it from surfacing as an error toast.
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      if (kind === "retry") {
        await workTaskRetry(task.id, note, blocks, allowDuplicateSource)
      } else {
        await workTaskRequeue(task.id, note, blocks, allowDuplicateSource)
      }
      onOpenChange(false)
    } catch (e) {
      // The resurrection guard is the one refusal with a way through, and it
      // refuses EVERY restart of this card while the other task lives — a
      // toast would leave the user with no next move. Everything else stays a
      // toast: there is nothing here to decide.
      const dup = duplicateActiveSource(e)
      if (dup) setDuplicate(dup)
      else toast.error(toErrorMessage(e))
      setSubmitting(false)
    } finally {
      submittingRef.current = false
    }
  }

  const isRetry = kind === "retry"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[32rem]">
        <DialogHeader>
          <DialogTitle>
            {isRetry ? t("restartTitleRetry") : t("restartTitleRequeue")}
          </DialogTitle>
          <DialogDescription>{t("restartDescription")}</DialogDescription>
        </DialogHeader>

        <TaskMessageComposer
          ref={composerRef}
          agentType={target.agentType}
          folderPath={target.folderPath}
          defaultText={text}
          placeholder={
            isRetry
              ? t("followUpPlaceholderRetry")
              : t("followUpPlaceholderRequeue")
          }
          ariaLabel={t("actionAddNote")}
          autoFocus
          submitShortcut={shortcuts.send_message}
          newlineShortcut={shortcuts.newline_in_message}
          onChange={setText}
          onSubmit={() => {
            // Mirrors the footer button exactly: in this dialog the send key
            // IS the primary, and once the warning is on screen the primary
            // reads "restart anyway". Sending without the waiver there would
            // silently re-run into the same refusal and look like a dead key.
            void submit(duplicate != null)
          }}
        />

        {duplicate ? (
          // Announced, not just drawn: the refusal arrives while focus is in
          // the editor, so a screen-reader user would otherwise get silence —
          // the same dead key this whole affordance exists to remove.
          <p role="alert" className="text-xs text-destructive">
            {t("restartDuplicateSource", {
              task: duplicateActiveSourceLabel(
                duplicate,
                t("restartDuplicateSourceAnon")
              ),
            })}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t("cancel")}
          </Button>
          {/* Arrow-wrapped, never `onClick={submit}`: a bare handler hands the
              click event straight to `allowDuplicateSource`, and a MouseEvent
              is truthy — every restart would waive the guard. */}
          <Button
            type="button"
            onClick={() => void submit(duplicate != null)}
            disabled={submitting}
          >
            {duplicate
              ? t("actionRestartAnyway")
              : isRetry
                ? t("actionRetry")
                : t("actionRequeue")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
