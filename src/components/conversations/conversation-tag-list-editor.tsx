"use client"

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react"
import { GripVertical, Loader2, Pencil, Plus, Trash2 } from "lucide-react"
import { Reorder, useDragControls } from "motion/react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  toLocalizedErrorMessage,
  type AppErrorTranslator,
} from "@/lib/app-error"
import { pickNextTagColor } from "@/lib/conversation-tags"
import type { ConversationTagDetail } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useConversationTagsStore } from "@/stores/conversation-tags-store"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { ConversationTagChip } from "./conversation-tag-chip"
import {
  ConversationTagFormDialog,
  type TagFormValues,
} from "./conversation-tag-form-dialog"

function TagRow({
  tag,
  dragDisabled,
  onEdit,
  onDelete,
  onDragEnd,
}: {
  tag: ConversationTagDetail
  dragDisabled: boolean
  onEdit: (tag: ConversationTagDetail) => void
  onDelete: (tag: ConversationTagDetail) => void
  onDragEnd: () => void
}) {
  const t = useTranslations("ConversationTags.editor")
  const dragControls = useDragControls()
  const startDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      event.preventDefault()
      dragControls.start(event)
    },
    [dragControls]
  )
  return (
    <Reorder.Item
      as="li"
      value={tag}
      drag={dragDisabled ? false : "y"}
      dragListener={false}
      dragControls={dragControls}
      dragMomentum={false}
      layout="position"
      onDragEnd={onDragEnd}
      data-tag-id={tag.id}
      className="group flex items-center gap-2 rounded-lg border bg-card px-2 py-1.5"
    >
      <button
        type="button"
        onPointerDown={startDrag}
        disabled={dragDisabled}
        title={t("dragToReorder", { name: tag.name })}
        aria-label={t("dragToReorder", { name: tag.name })}
        className="cursor-grab rounded p-0.5 text-muted-foreground hover:bg-muted active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
      >
        <GripVertical className="size-3.5" />
      </button>
      <span className="min-w-0 flex-1">
        <ConversationTagChip tag={tag} className="max-w-full" />
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground"
        onClick={() => onEdit(tag)}
        title={t("edit", { name: tag.name })}
        aria-label={t("edit", { name: tag.name })}
      >
        <Pencil className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
        onClick={() => onDelete(tag)}
        title={t("delete", { name: tag.name })}
        aria-label={t("delete", { name: tag.name })}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </Reorder.Item>
  )
}

/**
 * Create, edit, reorder and delete the tags of ONE scope: the global list
 * (`scopeFolderId === null`) or one root folder's own. The tag manager shows
 * one for each, fed only by the tag store.
 */
export function ConversationTagListEditor({
  scopeFolderId,
  className,
}: {
  scopeFolderId: number | null
  className?: string
}) {
  const t = useTranslations("ConversationTags")
  const allTags = useConversationTagsStore((s) => s.tags)
  const hydrated = useConversationTagsStore((s) => s.hydrated)
  const loadError = useConversationTagsStore((s) => s.loadError)
  const scopeTags = useMemo(
    () => allTags.filter((tag) => tag.folder_id === scopeFolderId),
    [allTags, scopeFolderId]
  )

  // The order WHILE a drag is in flight; null = the store's. Kept local so a
  // drag animates freely, then persisted once on release.
  const [dragOrder, setDragOrder] = useState<ConversationTagDetail[] | null>(
    null
  )
  const dragOrderRef = useRef<ConversationTagDetail[] | null>(null)
  const [reordering, setReordering] = useState(false)
  const [form, setForm] = useState<
    | { mode: "create"; initial: TagFormValues }
    | { mode: "edit"; tag: ConversationTagDetail; initial: TagFormValues }
    | null
  >(null)
  const [deleteTarget, setDeleteTarget] =
    useState<ConversationTagDetail | null>(null)
  const [deleting, setDeleting] = useState(false)

  const reportError = useCallback(
    (title: "toasts.deleteFailed" | "toasts.reorderFailed", err: unknown) => {
      toast.error(t(title), {
        description: toLocalizedErrorMessage(
          err,
          t as unknown as AppErrorTranslator
        ),
      })
    },
    [t]
  )

  const shown = dragOrder ?? scopeTags

  const handleReorder = useCallback((next: ConversationTagDetail[]) => {
    dragOrderRef.current = next
    setDragOrder(next)
  }, [])

  const handleDragEnd = useCallback(() => {
    const order = dragOrderRef.current
    dragOrderRef.current = null
    setDragOrder(null)
    if (!order) return
    const ids = order.map((tag) => tag.id)
    const unchanged =
      ids.length === scopeTags.length &&
      ids.every((id, idx) => id === scopeTags[idx].id)
    if (unchanged) return
    setReordering(true)
    useConversationTagsStore
      .getState()
      .reorderScope(ids)
      .catch((err) => reportError("toasts.reorderFailed", err))
      .finally(() => setReordering(false))
  }, [scopeTags, reportError])

  const openCreate = () => {
    setForm({
      mode: "create",
      initial: {
        name: "",
        // A folder's tags are always seen next to the global ones, so a new
        // one starts on a colour neither list uses yet.
        color: pickNextTagColor(
          allTags.filter(
            (tag) => tag.folder_id === null || tag.folder_id === scopeFolderId
          )
        ),
        folderId: scopeFolderId,
      },
    })
  }

  const submitForm = async (values: TagFormValues) => {
    if (!form) return
    const store = useConversationTagsStore.getState()
    if (form.mode === "create") {
      await store.createTag({
        folderId: scopeFolderId,
        name: values.name,
        color: values.color,
      })
    } else {
      const patch: { name?: string; color?: string } = {}
      if (values.name !== form.tag.name) patch.name = values.name
      if (values.color !== form.tag.color) patch.color = values.color
      if (patch.name !== undefined || patch.color !== undefined) {
        await store.updateTag(form.tag.id, patch)
      }
    }
    setForm(null)
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await useConversationTagsStore.getState().deleteTag(deleteTarget.id)
      setDeleteTarget(null)
    } catch (err) {
      reportError("toasts.deleteFailed", err)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className={cn("grid gap-2", className)}>
      {!hydrated ? (
        loadError ? (
          // Never "no tags here" for a list that failed to load.
          <p role="alert" className="py-2 text-xs text-destructive">
            {t("editor.loadFailed")}
          </p>
        ) : (
          <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
          </div>
        )
      ) : shown.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">
          {t("editor.empty")}
        </p>
      ) : (
        <Reorder.Group
          as="ul"
          axis="y"
          values={shown}
          onReorder={handleReorder}
          className="grid gap-1.5"
        >
          {shown.map((tag) => (
            <TagRow
              key={tag.id}
              tag={tag}
              dragDisabled={reordering}
              onEdit={(target) =>
                setForm({
                  mode: "edit",
                  tag: target,
                  initial: {
                    name: target.name,
                    color: target.color,
                    folderId: target.folder_id,
                  },
                })
              }
              onDelete={setDeleteTarget}
              onDragEnd={handleDragEnd}
            />
          ))}
        </Reorder.Group>
      )}
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={openCreate}
          disabled={!hydrated}
        >
          <Plus className="size-3.5" />
          {t("editor.add")}
        </Button>
      </div>

      <ConversationTagFormDialog
        open={form != null}
        onOpenChange={(open) => {
          if (!open) setForm(null)
        }}
        mode={form?.mode ?? "create"}
        initial={
          form?.initial ?? { name: "", color: "", folderId: scopeFolderId }
        }
        onSubmit={submitForm}
      />

      <AlertDialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("editor.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("editor.deleteDescription", {
                name: deleteTarget?.name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t("editor.deleteCancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={(event) => {
                // Stay open until the delete settles, so a failure is shown
                // against the dialog that caused it.
                event.preventDefault()
                void confirmDelete()
              }}
            >
              {deleting ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t("editor.deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
