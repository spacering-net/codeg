"use client"

import { useCallback, useId, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useImeGuard } from "@/hooks/use-ime-guard"
import type { CanvasBoard, CanvasBoardSummary } from "@/lib/types"
import type { CanvasBoardFormValues } from "./canvas-board-actions"
import { ColorPalette } from "./canvas-swatches"

/** Mirrors the backend's `MAX_BOARD_NAME_LEN` / `MAX_BOARD_DESCRIPTION_LEN`,
 *  so the field stops where the write would be refused instead of failing on
 *  submit. */
const NAME_MAX = 200
const DESCRIPTION_MAX = 2000

/** The board's display name: its own, or the localized placeholder title an
 *  unnamed board goes by. */
export function useBoardDisplayName() {
  const t = useTranslations("Canvas")
  return useCallback(
    (board: Pick<CanvasBoard, "name"> | null | undefined) =>
      board?.name?.trim() || t("untitledBoard"),
    [t]
  )
}

/**
 * Create or edit a board: name, description, color. One dialog for both —
 * `board` null is "new". The form is mounted fresh on every open (Radix
 * unmounts closed content), so it always starts from the board as it is now,
 * never from an abandoned earlier edit.
 */
export function CanvasBoardFormDialog({
  open,
  onOpenChange,
  board,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  board: CanvasBoard | null
  /** Resolves to whether the write succeeded; the dialog closes only then. */
  onSubmit: (values: CanvasBoardFormValues) => Promise<boolean>
}) {
  const t = useTranslations("Canvas")
  const nameRef = useRef<HTMLInputElement>(null)
  // Held here rather than in the form: while a write is out the dialog must
  // not be dismissed (Escape, the close button, a click outside), or a write
  // that then fails would take what the user typed with it.
  const pendingRef = useRef(false)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pendingRef.current) return
        onOpenChange(next)
      }}
    >
      <DialogContent
        className="sm:max-w-[28rem]"
        // Not `autoFocus` on the input: that focuses during the commit, before
        // the dialog's focus trap is listening, and the trap then never learns
        // where focus is. Focusing here runs after it is armed.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          nameRef.current?.focus()
          nameRef.current?.select()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {board ? t("editBoardTitle") : t("newBoardTitle")}
          </DialogTitle>
        </DialogHeader>
        <BoardForm
          board={board}
          nameRef={nameRef}
          pendingRef={pendingRef}
          onCancel={() => onOpenChange(false)}
          onSubmit={onSubmit}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

function BoardForm({
  board,
  nameRef,
  pendingRef,
  onCancel,
  onSubmit,
  onDone,
}: {
  board: CanvasBoard | null
  nameRef: React.RefObject<HTMLInputElement | null>
  /** Set while a write is out — a ref as well as the `pending` state, because
   *  Enter and the button can both fire before the re-render that disables
   *  the button, and a board must not be created twice. */
  pendingRef: React.RefObject<boolean>
  onCancel: () => void
  onSubmit: (values: CanvasBoardFormValues) => Promise<boolean>
  /** The write succeeded: close. */
  onDone: () => void
}) {
  const t = useTranslations("Canvas")
  const tCommon = useTranslations("Folder.common")
  const nameId = useId()
  const descriptionId = useId()
  const nameIme = useImeGuard()
  const [name, setName] = useState(board?.name ?? "")
  const [description, setDescription] = useState(board?.description ?? "")
  const [color, setColor] = useState(board?.color ?? "")
  const [pending, setPending] = useState(false)

  const submit = async () => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    const ok = await onSubmit({ name, description, color })
    // Released before closing, so the close is not refused as a dismissal of
    // a write in flight.
    pendingRef.current = false
    setPending(false)
    if (ok) onDone()
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={nameId}>{t("boardName")}</Label>
          <Input
            id={nameId}
            ref={nameRef}
            value={name}
            maxLength={NAME_MAX}
            placeholder={t("untitledBoard")}
            onChange={(e) => setName(e.target.value)}
            {...nameIme.props}
            onKeyDown={(e) => {
              // Never on an IME's confirming Enter: that would create a board
              // named half a word.
              if (nameIme.isComposing(e)) return
              if (e.key === "Enter") {
                e.preventDefault()
                void submit()
              }
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={descriptionId}>{t("boardDescription")}</Label>
          <Textarea
            id={descriptionId}
            value={description}
            rows={3}
            maxLength={DESCRIPTION_MAX}
            placeholder={t("boardDescriptionPlaceholder")}
            className="max-h-40 resize-none"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium leading-none">{t("color")}</span>
          <div className="-ml-1 w-fit">
            <ColorPalette value={color || null} onSelect={setColor} />
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={pending}
        >
          {tCommon("cancel")}
        </Button>
        <Button type="button" onClick={() => void submit()} disabled={pending}>
          {pending && <Loader2 className="size-3.5 animate-spin" />}
          {board ? tCommon("save") : tCommon("create")}
        </Button>
      </DialogFooter>
    </>
  )
}

/**
 * Confirm deleting a board. Always asked — unlike a single card, a board is a
 * whole arrangement, and nothing on it comes back — and it says what goes: how
 * much is on the board, and how many shells stop with it. The conversations,
 * folders and files it shows are only referenced, and the copy says so, since
 * "delete canvas" otherwise reads as "delete everything I see on it".
 */
export function CanvasBoardDeleteDialog({
  summary,
  open,
  onOpenChange,
  onConfirm,
}: {
  /** The board to delete. Kept by the caller after closing, so the copy does
   *  not blank out during the close animation. */
  summary: CanvasBoardSummary | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (boardId: number) => void
}) {
  const t = useTranslations("Canvas")
  const tCommon = useTranslations("Folder.common")
  const displayName = useBoardDisplayName()
  const nodeCount = summary?.node_count ?? 0
  const terminalCount = summary?.terminal_count ?? 0

  return (
    <AlertDialog open={open && summary !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("deleteBoardTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("deleteBoardDescription", {
              name: displayName(summary?.board),
            })}
            {/* Own lines rather than appended sentences: CJK copy puts no space
                after a full stop, and one joiner can't suit every locale. */}
            {nodeCount > 0 && (
              <span className="mt-1.5 block">
                {t("deleteBoardItems", { count: nodeCount })}
              </span>
            )}
            {terminalCount > 0 && (
              <span className="mt-1.5 block">
                {t("deleteBoardTerminals", { count: terminalCount })}
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (summary) onConfirm(summary.board.id)
            }}
          >
            {t("deleteBoardConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
