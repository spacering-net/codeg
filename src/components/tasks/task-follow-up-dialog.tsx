"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CircleAlert } from "lucide-react"
import { workTaskReturn } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  canSubmitFollowUp,
  DEFAULT_FOLLOW_UP_INTENT,
  followUpComposerTarget,
  followUpScenario,
  FOLLOW_UP_SCENARIOS,
  type FollowUpIntent,
} from "@/lib/task-follow-up"
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  TaskMessageComposer,
  type TaskMessageComposerHandle,
} from "./task-message-composer"
import type { WorkTask } from "@/lib/types"

interface TaskFollowUpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The row captured when the action was clicked — not the live one, whose
   *  identity changes on every board refetch (see the seeding effect). */
  task: WorkTask | null
}

/**
 * "继续处理" from the board: the drawer's follow-up box, for a card that has
 * nowhere to unfold one. It is what a task put aside to handle later leads
 * with — the agent picks the task back up in its own session and the card goes
 * from Done straight back to running (`workTaskReturn`, the same call the
 * drawer makes, so the two cannot drift).
 *
 * Same scenarios as the drawer, and the same rule on what may be sent: text, an
 * attachment, or a scenario that is complete on its own (`canSubmitFollowUp`).
 * Like the restart dialog, the text is read from the EDITOR when the send
 * fires, and a synchronous latch keeps a doubled send key to one request.
 * Errors stay in the dialog, beside the box they are about.
 */
export function TaskFollowUpDialog({
  open,
  onOpenChange,
  task,
}: TaskFollowUpDialogProps) {
  const t = useTranslations("Tasks")
  // The upload-in-flight toast is the conversation composer's own message.
  const tChat = useTranslations("Folder.chat.messageInput")
  // The whole list: a task's worktree is normally not among the open folders.
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const { shortcuts } = useShortcutSettings()
  const composerRef = useRef<TaskMessageComposerHandle>(null)
  const [text, setText] = useState("")
  // Mirrors the composer's attachment count, so an image-only follow-up still
  // enables the send — the text alone would read as empty.
  const [attachments, setAttachments] = useState(0)
  const [intent, setIntent] = useState<FollowUpIntent>(DEFAULT_FOLLOW_UP_INTENT)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Synchronous in-flight latch — see `submit`. */
  const submittingRef = useRef(false)

  // A fresh box per open — a follow-up belongs to one round. Keyed by the
  // task's id, never by the object: the board hands out a new row on every
  // refetch, and re-seeding on that would wipe what the user is typing.
  const taskId = task?.id ?? null
  useEffect(() => {
    if (!open) return
    setText("")
    setAttachments(0)
    setIntent(DEFAULT_FOLLOW_UP_INTENT)
    setSubmitting(false)
    setError(null)
    submittingRef.current = false
  }, [open, taskId])

  if (!task) return null

  // No conversation detail on this path (the card never loads one), so the
  // agent resolves from the task's own override → the folder default, the same
  // fallback the drawer runs on before its detail lands.
  const target = followUpComposerTarget({
    task,
    conversationAgentType: null,
    folders: allFolders,
  })
  const scenario = followUpScenario(intent)

  const submit = async () => {
    // Straight from the editor: reference badges serialize to their inline
    // token here, and this cannot lag a keystroke behind the state.
    const feedback = (composerRef.current?.getText() ?? text).trim()
    // Images / pasted bytes ride beside the text as their own blocks.
    const blocks = composerRef.current?.getAttachmentBlocks() ?? []
    if (!canSubmitFollowUp(intent, feedback, blocks.length > 0)) return
    // An unsettled upload has no server-side uri yet, so its block would reach
    // the agent empty. The box keeps its content — this is "wait a moment".
    if (composerRef.current?.hasUploadingImage()) {
      toast.error(tChat("attachUploadInProgress"))
      return
    }
    // A ref, not `submitting`: the send key is read out of a ref inside the
    // editor's own keydown handler, so a second Enter can arrive before React
    // has re-rendered. The backend's CAS would reject the loser anyway — this
    // keeps it from surfacing as an error for a keypress the user may repeat.
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      await workTaskReturn(task.id, feedback, intent, blocks)
      onOpenChange(false)
    } catch (e) {
      setError(toErrorMessage(e))
      setSubmitting(false)
    } finally {
      submittingRef.current = false
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[32rem]">
        <DialogHeader>
          <DialogTitle>{t("actionFollowUp")}</DialogTitle>
          <DialogDescription>
            {t("followUpDialogDescription")}
          </DialogDescription>
        </DialogHeader>

        <TaskMessageComposer
          ref={composerRef}
          agentType={target.agentType}
          folderPath={target.folderPath}
          defaultText={text}
          placeholder={t(scenario.placeholderKey)}
          ariaLabel={t("actionFollowUp")}
          autoFocus
          submitShortcut={shortcuts.send_message}
          newlineShortcut={shortcuts.newline_in_message}
          onChange={setText}
          onAttachmentsChange={setAttachments}
          onSubmit={() => void submit()}
        />

        {error ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg bg-destructive/10 px-2.5 py-2 text-[0.8125rem] leading-snug text-destructive"
          >
            <CircleAlert
              className="mt-px size-3.5 shrink-0"
              aria-hidden="true"
            />
            <span className="min-w-0 break-words">{error}</span>
          </p>
        ) : null}

        <DialogFooter className="sm:items-center">
          {/* The scenario picker leads the footer, as in the drawer's box: the
              glyph rides inside SelectItem, so the trigger mirrors icon and
              label together. */}
          <Select
            value={intent}
            onValueChange={(v) => setIntent(v as FollowUpIntent)}
          >
            <SelectTrigger
              size="sm"
              className="w-auto min-w-0 max-w-[14rem] text-xs sm:me-auto"
              aria-label={t("actionFollowUp")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FOLLOW_UP_SCENARIOS.map((option) => (
                <SelectItem key={option.intent} value={option.intent}>
                  <option.icon
                    className="size-3.5 text-muted-foreground"
                    aria-hidden="true"
                  />
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
            onClick={() => void submit()}
            disabled={
              submitting || !canSubmitFollowUp(intent, text, attachments > 0)
            }
          >
            {t("followUpSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
