"use client"

import type { ReactNode } from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { Copy, Download, X } from "lucide-react"
import { cn } from "@/lib/utils"

interface ImagePreviewDialogProps {
  src: string
  alt: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * When provided, render a download icon button next to the close button.
   * The handler is invoked on click; the dialog stays open so the caller
   * can show its own progress/toast feedback.
   */
  onDownload?: () => void
  downloadLabel?: string
  onCopy?: () => void
  copyLabel?: string
  /**
   * Wrap the image element — used to hang a right-click menu off it, so the
   * blown-up picture offers the same actions as its thumbnail did. A render
   * prop keeps this ui/ component free of message-specific imports.
   */
  renderImage?: (image: ReactNode) => ReactNode
}

function ImagePreviewDialog({
  src,
  alt,
  open,
  onOpenChange,
  onDownload,
  downloadLabel,
  onCopy,
  copyLabel,
  renderImage,
}: ImagePreviewDialogProps) {
  const image = src ? (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={src}
      alt={alt}
      onClick={(e) => e.stopPropagation()}
      className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
    />
  ) : null
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0",
            "fixed inset-0 z-50 bg-black/80 duration-100 supports-backdrop-filter:backdrop-blur-xs"
          )}
        />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex items-center justify-center outline-none"
          aria-describedby={undefined}
          onClick={() => onOpenChange(false)}
        >
          <DialogPrimitive.Title className="sr-only">
            {alt}
          </DialogPrimitive.Title>
          <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
            {onCopy && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onCopy()
                }}
                className="rounded-full bg-background/60 p-1.5 text-foreground/80 hover:bg-background/80 hover:text-foreground"
                aria-label={copyLabel ?? "Copy image"}
                title={copyLabel ?? "Copy image"}
              >
                <Copy className="h-5 w-5" />
              </button>
            )}
            {onDownload && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onDownload()
                }}
                className="rounded-full bg-background/60 p-1.5 text-foreground/80 hover:bg-background/80 hover:text-foreground"
                aria-label={downloadLabel ?? "Download"}
                title={downloadLabel ?? "Download"}
              >
                <Download className="h-5 w-5" />
              </button>
            )}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-full bg-background/60 p-1.5 text-foreground/80 hover:bg-background/80 hover:text-foreground"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          {image && (renderImage ? renderImage(image) : image)}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export { ImagePreviewDialog }
