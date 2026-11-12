"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FolderSelect } from "@/components/shared/folder-select"
import { moveConversations } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  DbConversationSummary,
  MoveConversationsResult,
  MoveSkipReason,
} from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

/** What the dialog needs to know about each conversation it moves. */
export type MovableConversation = Pick<
  DbConversationSummary,
  "id" | "folder_id" | "kind"
>

interface MoveConversationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** One conversation (the sidebar menu) or several (Manage conversations). */
  conversations: readonly MovableConversation[]
  /** Called once a move ran, with what it did — e.g. to refetch a list. */
  onMoved?: (result: MoveConversationsResult) => void
}

/**
 * "Move to project…": pick an OPEN project folder and move the conversations
 * there. From the next message on the agent works in the target folder; the
 * history stays as it is. The backend judges each conversation on its own
 * (task-owned, busy, …) and the outcome is summarized in a toast. No optimistic
 * update: the moved rows, and the tabs that follow them, arrive as broadcasts.
 */
export function MoveConversationDialog({
  open,
  onOpenChange,
  conversations,
  onMoved,
}: MoveConversationDialogProps) {
  const t = useTranslations("Folder.moveConversation")
  const folders = useAppWorkspaceStore((s) => s.folders)
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const [targetId, setTargetId] = useState<number | null>(null)
  const [pending, setPending] = useState(false)

  const single = conversations.length === 1 ? conversations[0] : null
  // Open projects only (`folders` already leaves the hidden chat folders out);
  // a single conversation's own folder is no destination.
  const options = useMemo(
    () =>
      folders
        .filter((f) => f.kind !== "chat")
        .filter((f) => single == null || f.id !== single.folder_id),
    [folders, single]
  )
  const target = options.find((f) => f.id === targetId) ?? null
  const chats = conversations.filter((c) => c.kind === "chat")
  const chatScratchPath =
    chats.length === 1 && conversations.length === 1
      ? allFolders.find((f) => f.id === chats[0].folder_id)?.path
      : undefined

  const handleOpenChange = (next: boolean) => {
    if (pending) return
    if (!next) setTargetId(null)
    onOpenChange(next)
  }

  const handleMove = async () => {
    if (!target || conversations.length === 0) return
    setPending(true)
    try {
      const result = await moveConversations(
        conversations.map((c) => c.id),
        target.id
      )
      announce(result, target.alias || target.name)
      onMoved?.(result)
      setTargetId(null)
      onOpenChange(false)
    } catch (e) {
      toast.error(t("toastFailed", { message: toErrorMessage(e) }))
    } finally {
      setPending(false)
    }
  }

  const announce = (result: MoveConversationsResult, folder: string) => {
    if (result.moved.length > 0) {
      toast.success(t("toastMoved", { count: result.moved.length, folder }))
    }
    if (result.skipped.length > 0) {
      const reasons = [
        ...new Set(result.skipped.map((s) => s.reason)),
      ] as MoveSkipReason[]
      toast.warning(t("toastSkipped", { count: result.skipped.length }), {
        description: reasons.map((r) => t(`skipReason.${r}`)).join(" · "),
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {single
              ? t("title")
              : t("titleMany", { count: conversations.length })}
          </DialogTitle>
          <DialogDescription>
            {target
              ? t("explain", { path: target.path })
              : t("explainNoTarget")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {options.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noTargets")}</p>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{t("targetLabel")}</span>
              <FolderSelect
                variant="field"
                folders={options}
                value={targetId}
                onChange={setTargetId}
                placeholder={t("targetPlaceholder")}
                disabled={pending}
              />
            </div>
          )}
          {chats.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {chatScratchPath
                ? t("chatFilesNote", { path: chatScratchPath })
                : t("chatFilesNoteMany")}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={pending}
          >
            {t("cancel")}
          </Button>
          <Button onClick={handleMove} disabled={!target || pending}>
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t("move")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
