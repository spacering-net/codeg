"use client"

import { useState } from "react"
import Image from "next/image"
import { Download } from "lucide-react"
import { useTranslations } from "next-intl"
import type { UserImageDisplay } from "@/lib/adapters/ai-elements-adapter"
import { ImagePreviewDialog } from "@/components/ui/image-preview-dialog"
import { ImageActions, useImageActions } from "./image-actions"

interface UserImageAttachmentsProps {
  images: UserImageDisplay[]
  className?: string
}

export function UserImageAttachments({
  images,
  className,
}: UserImageAttachmentsProps) {
  const t = useTranslations("Folder.chat.messageList")
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const { canCopy, copy, download } = useImageActions()

  if (images.length === 0) return null

  const previewImage =
    previewIndex !== null && previewIndex < images.length
      ? images[previewIndex]
      : null

  return (
    <div className={className}>
      <div className="flex flex-wrap gap-1.5">
        {images.map((image, index) => (
          <ImageActions
            key={`${image.uri ?? image.name}-${index}`}
            image={image}
            className="group relative overflow-hidden rounded-md border border-border/70 bg-muted/30"
          >
            <button
              type="button"
              onClick={() => setPreviewIndex(index)}
              className="block cursor-pointer transition-opacity hover:opacity-80"
            >
              <Image
                src={`data:${image.mime_type};base64,${image.data}`}
                alt={image.name}
                width={56}
                height={56}
                unoptimized
                className="h-14 w-14 object-cover"
              />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                void download(image)
              }}
              className="absolute right-0.5 top-0.5 rounded-full bg-background/80 p-0.5 text-foreground/80 opacity-0 shadow-sm transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
              aria-label={t("downloadImage")}
              title={t("downloadImage")}
            >
              <Download className="h-3 w-3" />
            </button>
          </ImageActions>
        ))}
      </div>
      <ImagePreviewDialog
        src={
          previewImage
            ? `data:${previewImage.mime_type};base64,${previewImage.data}`
            : ""
        }
        alt={previewImage?.name ?? ""}
        open={previewImage !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewIndex(null)
        }}
        onDownload={
          previewImage ? () => void download(previewImage) : undefined
        }
        downloadLabel={t("downloadImage")}
        onCopy={
          previewImage && canCopy ? () => void copy(previewImage) : undefined
        }
        copyLabel={t("copyImage")}
        renderImage={
          previewImage
            ? (image) => (
                <ImageActions image={previewImage}>{image}</ImageActions>
              )
            : undefined
        }
      />
    </div>
  )
}
