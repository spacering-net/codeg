"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Folder, Info, Loader2 } from "lucide-react"
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
import { FolderAliasLabel } from "@/components/conversations/folder-alias-label"
import { moveConversations } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { formatConversationTitle } from "@/lib/conversation-title"
import type {
  DbConversationSummary,
  FolderDetail,
  MoveConversationsResult,
  MoveSkipReason,
} from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

/** What the move needs to know about each conversation it moves. */
export type MovableConversation = Pick<
  DbConversationSummary,
  "id" | "folder_id" | "kind" | "title"
>

/**
 * The folders a move may land in: the OPEN regular folders (`folders` already
 * leaves the hidden chat folders out), minus `currentFolderId` — the one the
 * conversations already sit in, when they all share one. Shared by the
 * sidebar's "Move to folder" submenu and Manage conversations' "Move to…".
 */
export function useMoveTargetFolders(
  currentFolderId: number | null
): FolderDetail[] {
  const folders = useAppWorkspaceStore((s) => s.folders)
  return useMemo(
    () => folders.filter((f) => f.kind !== "chat" && f.id !== currentFolderId),
    [folders, currentFolderId]
  )
}

/** The one folder every conversation shares, or `null` when they differ. */
export function sharedFolderId(
  conversations: readonly Pick<MovableConversation, "folder_id">[]
): number | null {
  const first = conversations[0]?.folder_id ?? null
  return conversations.every((c) => c.folder_id === first) ? first : null
}

interface MoveConversationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** One conversation (the sidebar menu) or several (Manage conversations). */
  conversations: readonly MovableConversation[]
  /** The folder picked in the menu that opened this confirmation. */
  targetFolderId: number | null
  /** Called once a move ran, with what it did — e.g. to refetch a list. */
  onMoved?: (result: MoveConversationsResult) => void
}

/**
 * Confirms moving conversations into the folder picked from a menu. From the
 * next message on the agent works in that folder; the history stays as it is.
 * The backend judges each conversation on its own (task-owned, busy, …) and the
 * outcome is summarized in a toast. No optimistic update: the moved rows, and
 * the tabs that follow them, arrive as broadcasts.
 */
export function MoveConversationDialog({
  open,
  onOpenChange,
  conversations,
  targetFolderId,
  onMoved,
}: MoveConversationDialogProps) {
  const t = useTranslations("Folder.moveConversation")
  const folders = useAppWorkspaceStore((s) => s.folders)
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const [pending, setPending] = useState(false)

  // Resolved against the OPEN folders: one closed while the dialog was up is no
  // destination any more, and Move disables rather than send a doomed request.
  const target =
    targetFolderId != null
      ? (folders.find((f) => f.id === targetFolderId && f.kind !== "chat") ??
        null)
      : null
  const single = conversations.length === 1 ? conversations[0] : null
  const chats = conversations.filter((c) => c.kind === "chat")
  const chatScratchPath =
    chats.length === 1 && single
      ? allFolders.find((f) => f.id === chats[0].folder_id)?.path
      : undefined

  const handleOpenChange = (next: boolean) => {
    if (pending) return
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {single
              ? t("title")
              : t("titleMany", { count: conversations.length })}
          </DialogTitle>
          <DialogDescription>
            {single
              ? t("intro", {
                  title:
                    formatConversationTitle(single.title) ||
                    t("untitledConversation"),
                })
              : t("introMany", { count: conversations.length })}
          </DialogDescription>
        </DialogHeader>

        {target ? (
          <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-muted/40 px-3 py-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground">
              <Folder className="size-4" aria-hidden="true" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm font-medium">
                <FolderAliasLabel
                  name={target.name}
                  alias={target.alias ?? null}
                  bracketClassName="text-muted-foreground"
                />
              </span>
              <span
                dir="ltr"
                title={target.path}
                className="truncate text-start font-mono text-xs text-muted-foreground"
              >
                {target.path}
              </span>
            </div>
          </div>
        ) : (
          <p className="rounded-xl border border-dashed px-3 py-2.5 text-sm text-muted-foreground">
            {t("targetUnavailable")}
          </p>
        )}

        <div className="flex flex-col gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <p className="flex gap-1.5">
            <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            <span>{t("explain")}</span>
          </p>
          {chats.length > 0 && (
            <p className="ps-[1.125rem]">
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
