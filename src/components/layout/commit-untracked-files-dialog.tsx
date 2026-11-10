"use client"

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

// An unignored dependency or build directory can bring tens of thousands of
// untracked files; the list mounts this many and offers the rest on request.
export const MAX_LISTED_UNTRACKED_FILES = 500

interface CommitUntrackedFilesDialogProps {
  /** The untracked files on offer; `null` while closed. */
  files: string[] | null
  /** Unchecked when the dialog opens: the files left out last time. */
  excluded: ReadonlySet<string>
  /** Whether the commit has tracked changes, so that checking nothing still
   *  leaves something to describe. */
  hasTrackedChanges: boolean
  /** The checked files, in the order they were offered. */
  onConfirm: (included: string[]) => void
  onCancel: () => void
}

/**
 * Asked by the ✨ before it writes a message while there are untracked files:
 * which of them the message describes and the commit takes. Every file starts
 * checked except the ones the user left out last time.
 */
export function CommitUntrackedFilesDialog({
  files,
  excluded,
  hasTrackedChanges,
  onConfirm,
  onCancel,
}: CommitUntrackedFilesDialogProps) {
  const t = useTranslations("CommitMessageGeneration.untracked")
  const tCommon = useTranslations("Folder.common")
  const confirmRef = useRef<HTMLButtonElement>(null)
  // The last offer, kept through the closing animation.
  const [listed, setListed] = useState<string[]>([])
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [showAll, setShowAll] = useState(false)
  const [openedWith, setOpenedWith] = useState<string[] | null>(null)
  if (files !== openedWith) {
    setOpenedWith(files)
    if (files) {
      setListed(files)
      setSelected(new Set(files.filter((file) => !excluded.has(file))))
      setShowAll(false)
    }
  }

  const allSelected = listed.length > 0 && selected.size === listed.length
  const visible =
    showAll || listed.length <= MAX_LISTED_UNTRACKED_FILES
      ? listed
      : listed.slice(0, MAX_LISTED_UNTRACKED_FILES)
  const hiddenCount = listed.length - visible.length
  const canConfirm = hasTrackedChanges || selected.size > 0

  const toggle = (file: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  }

  return (
    <Dialog
      open={files !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent
        className="sm:max-w-2xl"
        // On the confirm button, so Enter takes the files as offered — unless
        // it starts disabled, which leaves focus to the dialog's own default.
        onOpenAutoFocus={(event) => {
          const confirm = confirmRef.current
          if (!confirm || confirm.disabled) return
          event.preventDefault()
          confirm.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">
              {t("selectionCount", {
                selected: selected.size,
                total: listed.length,
              })}
            </span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() =>
                setSelected(allSelected ? new Set() : new Set(listed))
              }
            >
              {allSelected ? t("unselectAll") : t("selectAll")}
            </Button>
          </div>
          <div className="max-h-80 overflow-auto rounded-md border">
            <div className="divide-y">
              {visible.map((file) => {
                const checked = selected.has(file)
                return (
                  <button
                    key={file}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/40"
                    onClick={() => toggle(file)}
                  >
                    <span
                      className={
                        checked
                          ? "flex h-4 w-4 shrink-0 items-center justify-center rounded border border-primary bg-primary text-3xs text-primary-foreground"
                          : "flex h-4 w-4 shrink-0 items-center justify-center rounded border border-input"
                      }
                      aria-hidden
                    >
                      {checked ? "✓" : ""}
                    </span>
                    <span className="flex-1 truncate" title={file}>
                      {file}
                    </span>
                  </button>
                )
              })}
              {hiddenCount > 0 && (
                <button
                  type="button"
                  className="flex w-full items-center px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                  onClick={() => setShowAll(true)}
                >
                  {t("showMore", { count: hiddenCount })}
                </button>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              {tCommon("cancel")}
            </Button>
            <Button
              ref={confirmRef}
              type="button"
              disabled={!canConfirm}
              onClick={() =>
                onConfirm(listed.filter((file) => selected.has(file)))
              }
            >
              {t("confirm")}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
