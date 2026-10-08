"use client"

import { useRef, useState } from "react"
import Image from "next/image"
import { useTranslations } from "next-intl"
import {
  RichComposer,
  type RichComposerHandle,
} from "@/components/chat/composer/rich-composer"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toErrorMessage } from "@/lib/app-error"
import type { MessageTurn, PromptDraft } from "@/lib/types"

export interface EditUserMessageDialogProps {
  turn: MessageTurn
  busy?: boolean
  onSubmit: (draft: PromptDraft) => Promise<void>
  onCancel: () => void
}

/** The parent keys this dialog by turn so an in-progress draft is never reseeded. */
export function EditUserMessageDialog({
  turn,
  busy = false,
  onSubmit,
  onCancel,
}: EditUserMessageDialogProps) {
  const t = useTranslations("Folder.chat.messageList")
  const composerRef = useRef<RichComposerHandle>(null)
  const submittingRef = useRef(false)
  const [original] = useState(() => ({
    role: turn.role,
    promptText: turn.prompt_text,
    blocks: turn.blocks.map((block) => ({ ...block })),
  }))
  const originalText =
    original.promptText ??
    original.blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
  const images = original.blocks.filter((block) => block.type === "image")
  const unsupported =
    original.role !== "user" ||
    original.blocks.some(
      (block) => block.type !== "text" && block.type !== "image"
    )
  const attachmentsUnavailable = images.some(
    (image) => !image.data?.trim() || !image.mime_type?.startsWith("image/")
  )
  const [text, setText] = useState(originalText)
  const [ready, setReady] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const invalid = unsupported || attachmentsUnavailable
  const empty = !text.trim() && images.length === 0

  const cancel = () => {
    if (!submittingRef.current) onCancel()
  }

  const submit = async () => {
    if (busy || submittingRef.current || invalid) return
    if (!ready || !composerRef.current?.getEditor()) {
      setError(t("editNotReady"))
      return
    }
    const draftText = composerRef.current.getText()
    if (!draftText.trim() && images.length === 0) return
    // State alone cannot guard two submit intents arriving in the same tick.
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit({
        displayText: draftText,
        blocks: [
          ...(draftText ? [{ type: "text" as const, text: draftText }] : []),
          ...images.map((image) => ({ ...image })),
        ],
      })
    } catch (cause) {
      setError(t("editFailed", { message: toErrorMessage(cause) }))
      submittingRef.current = false
      setSubmitting(false)
      return
    }
    onCancel()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && cancel()}>
      <DialogContent
        className="sm:max-w-xl"
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          if (submittingRef.current) event.preventDefault()
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("editMessage")}</DialogTitle>
          <DialogDescription>{t("editDescription")}</DialogDescription>
        </DialogHeader>
        <RichComposer
          ref={composerRef}
          defaultText={originalText}
          ariaLabel={t("editMessage")}
          autoFocus
          disabled={submitting || invalid}
          className="min-h-28 max-h-72 rounded-md border p-3"
          onReady={() => setReady(true)}
          onChange={setText}
          onSubmit={() => void submit()}
        />
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map((image, index) =>
              image.data?.trim() && image.mime_type?.startsWith("image/") ? (
                <Image
                  key={index}
                  src={`data:${image.mime_type};base64,${image.data}`}
                  alt={t("editImage", { number: index + 1 })}
                  width={64}
                  height={64}
                  unoptimized
                  className="h-16 w-16 rounded-md border object-cover"
                />
              ) : null
            )}
          </div>
        )}
        {(invalid || error) && (
          <p role="alert" className="text-sm text-destructive">
            {unsupported
              ? t("editUnsupported")
              : attachmentsUnavailable
                ? t("editAttachmentsUnavailable")
                : error}
          </p>
        )}
        {(busy || submitting) && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("editBusy")}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={cancel}
            disabled={submitting}
          >
            {t("editCancel")}
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={busy || submitting || !ready || invalid || empty}
            aria-busy={submitting}
          >
            {t("editAndResend")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
