"use client"

import { useState } from "react"
import Image from "next/image"
import { useTranslations } from "next-intl"
import { Loader2, X } from "lucide-react"

import { ImagePreviewDialog } from "@/components/ui/image-preview-dialog"
import {
  ImageActions,
  useImageActions,
} from "@/components/message/image-actions"
import type { UserImageDisplay } from "@/lib/adapters/ai-elements-adapter"
import type { ImageInputAttachment } from "@/components/chat/message-input-attachments"

/** The staged attachment reshaped for the shared transcript image actions. */
function toDisplay(attachment: ImageInputAttachment): UserImageDisplay {
  return {
    name: attachment.name,
    data: attachment.data,
    mime_type: attachment.mimeType,
    uri: attachment.uri,
  }
}

/**
 * The composer's image attachment strip: one thumbnail per pasted / dropped /
 * picked image, each clickable for a full preview and removable in place.
 *
 * Renders as a bare list of tiles (no wrapper) so each host can place it in its
 * own scroller — the conversation composer hands it to `ConversationContextBar`
 * alongside the context chips, while the to-do task composers put it in a plain
 * row above the editor. The preview dialog is owned here: it's an artifact of
 * clicking a tile, not state any host needs.
 *
 * Tiles and the blown-up preview carry the same right-click Copy / Download
 * menu as transcript images (`ImageActions`); without it a right-click on a
 * staged image fell through to the composer's own text context menu, whose
 * Copy row copies nothing for an image.
 */
export function ComposerImageThumbnails({
  attachments,
  onRemove,
}: {
  attachments: ImageInputAttachment[]
  onRemove: (id: string) => void
}) {
  const t = useTranslations("Folder.chat.messageInput")
  // The shared image actions live in the transcript's namespace; reusing the
  // exact keys keeps the two menus identical in every locale.
  const tImage = useTranslations("Folder.chat.messageList")
  const [previewId, setPreviewId] = useState<string | null>(null)
  const { canCopy, copy, download } = useImageActions()
  const preview = previewId
    ? (attachments.find((a) => a.id === previewId) ?? null)
    : null
  const previewDisplay = preview ? toDisplay(preview) : null

  return (
    <>
      {attachments.map((attachment) => (
        <ImageActions
          key={attachment.id}
          image={toDisplay(attachment)}
          className="relative shrink-0 overflow-hidden rounded-md border border-border/70 bg-muted/30"
        >
          <button
            type="button"
            onClick={() => setPreviewId(attachment.id)}
            className="cursor-pointer transition-opacity hover:opacity-80"
          >
            <Image
              src={`data:${attachment.mimeType};base64,${attachment.data}`}
              alt={attachment.name}
              width={56}
              height={56}
              unoptimized
              className="h-14 w-14 object-cover"
            />
          </button>
          {attachment.uploading ? (
            // Web/remote upload still in flight — sends are gated on this
            // settling (see the host's send handler).
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/50">
              <Loader2 className="h-4 w-4 animate-spin text-foreground/80" />
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            className="absolute right-1 top-1 rounded-sm bg-background/70 p-0.5 hover:bg-background"
            aria-label={t("removeAttachmentAria", { name: attachment.name })}
          >
            <X className="h-3 w-3" />
          </button>
        </ImageActions>
      ))}
      <ImagePreviewDialog
        src={preview ? `data:${preview.mimeType};base64,${preview.data}` : ""}
        alt={preview?.name ?? ""}
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewId(null)
        }}
        onDownload={
          previewDisplay ? () => void download(previewDisplay) : undefined
        }
        downloadLabel={tImage("downloadImage")}
        onCopy={
          previewDisplay && canCopy
            ? () => void copy(previewDisplay)
            : undefined
        }
        copyLabel={tImage("copyImage")}
        renderImage={
          previewDisplay
            ? (image) => (
                <ImageActions image={previewDisplay}>{image}</ImageActions>
              )
            : undefined
        }
      />
    </>
  )
}
