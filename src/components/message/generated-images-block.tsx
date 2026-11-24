"use client"

import { memo, useState } from "react"
import Image from "next/image"
import { AlertCircle, Download, ImagePlus } from "lucide-react"
import { useTranslations } from "next-intl"
import type { UserImageDisplay } from "@/lib/adapters/ai-elements-adapter"
import type { ToolCallStatus } from "@/lib/types"
import { ImagePreviewDialog } from "@/components/ui/image-preview-dialog"
import { ImageActions, useImageActions } from "./image-actions"
import { cn } from "@/lib/utils"

interface GeneratedImagesBlockProps {
  /**
   * Card heading. Codex image generation leaves this unset so the
   * translated "Image generation" copy is used. A Read, screenshot, or
   * fetched page passes the tool/page name instead.
   */
  label?: string | null
  /**
   * codex's revised prompt — what the model rewrote the user's request
   * into before passing to the image API. `null` when codex didn't echo
   * one back (e.g. failed generations) or it hasn't streamed in yet.
   */
  revisedPrompt: string | null
  /**
   * `null` while the agent has emitted the ToolCall but the image hasn't
   * arrived. The component renders an image-shaped skeleton placeholder
   * for this case so the user sees acknowledgement of work in progress
   * before the (often multi-second) image bytes land.
   *
   * NB: with codex-rs versions that don't emit `image_generation_begin`
   * events (≤ 0.122.0 at time of writing), there is no in-flight window
   * — `image` arrives populated on the very first tool_call event. The
   * placeholder branch is reached only when codex-rs upgrades to a
   * version that emits begin events.
   */
  image: UserImageDisplay | null
  /**
   * Live tool-call status. When `image` is null and `status === "failed"`,
   * the renderer shows a failure slot instead of a perpetual skeleton.
   * `null` (Rust-emitted JSONL replay blocks) is treated as success — by
   * definition such blocks always carry a present `image`.
   */
  status?: ToolCallStatus | null
  className?: string
}

/**
 * Renders one codex-acp v0.14+ image-generation `ContentBlock` as a
 * labeled, in-position card showing the optional revised prompt and a
 * single generated image.
 *
 * Layout uses a container query (`@container/genimg`):
 *   - wide (≥ 28rem available): prompt on the left, image on the right
 *     (so the prompt fills the empty space next to a square thumbnail)
 *   - narrow: image stacks below the prompt, mirroring the original
 *     vertical layout
 *
 * Download is platform-aware:
 *   - desktop: native "Save As" via Tauri command
 *   - web: blob `<a download>`
 */
export const GeneratedImagesBlock = memo(function GeneratedImagesBlock({
  label,
  revisedPrompt,
  image,
  status,
  className,
}: GeneratedImagesBlockProps) {
  const t = useTranslations("Folder.chat.messageList")
  const [previewOpen, setPreviewOpen] = useState(false)
  // Treat `failed` (and the unusual `completed`-without-image case) as
  // failure so the user gets a clear error indicator instead of a
  // perpetual skeleton when codex reports the call ended without an image.
  const isFailed =
    image === null && (status === "failed" || status === "completed")

  const { canCopy, copy, download } = useImageActions()

  const trimmedPrompt =
    typeof revisedPrompt === "string" ? revisedPrompt.trim() : ""

  // The heading is agent-authored now (a filename, a page slug, or a tool
  // title) instead of one short fixed string, so it is bounded to a single
  // ellipsized line and carries the full text as a tooltip.
  const heading = label?.trim() || t("imageGeneration")

  return (
    <div
      className={cn(
        "@container/genimg rounded-md border border-border/70 bg-muted/20 p-3",
        className
      )}
    >
      <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <ImagePlus className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="min-w-0 truncate" title={heading}>
          {heading}
        </span>
      </div>

      <div className="mt-2.5 flex flex-col gap-3 @[28rem]/genimg:flex-row @[28rem]/genimg:items-start">
        {trimmedPrompt.length > 0 ? (
          <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {trimmedPrompt}
          </div>
        ) : null}

        {image ? (
          <ImageActions
            image={image}
            className="group relative inline-block shrink-0 overflow-hidden rounded-md border border-border/70 bg-muted/30"
          >
            <button
              type="button"
              onClick={() => setPreviewOpen(true)}
              className="block cursor-pointer transition-opacity hover:opacity-80"
            >
              <Image
                src={`data:${image.mime_type};base64,${image.data}`}
                alt={image.name}
                width={256}
                height={256}
                unoptimized
                className="h-auto max-h-64 w-auto max-w-full object-contain"
              />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                void download(image)
              }}
              className="absolute right-1 top-1 rounded-full bg-background/80 p-1 text-foreground/80 opacity-0 shadow-sm transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
              aria-label={t("downloadImage")}
              title={t("downloadImage")}
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          </ImageActions>
        ) : isFailed ? (
          <div
            className="flex h-64 w-64 max-w-full shrink-0 items-center justify-center rounded-md border border-dashed border-destructive/40 bg-destructive/5 text-xs text-destructive"
            role="status"
            aria-live="polite"
          >
            <div className="flex flex-col items-center gap-1.5">
              <AlertCircle className="h-6 w-6 opacity-80" />
              <span>{t("imageGenerationFailed")}</span>
            </div>
          </div>
        ) : (
          <div
            className="flex h-64 w-64 max-w-full shrink-0 animate-pulse items-center justify-center rounded-md border border-dashed border-border/70 bg-muted/40 text-xs text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <div className="flex flex-col items-center gap-1.5">
              <ImagePlus className="h-6 w-6 opacity-60" />
              <span>{t("imageGenerationPending")}</span>
            </div>
          </div>
        )}
      </div>

      <ImagePreviewDialog
        src={image ? `data:${image.mime_type};base64,${image.data}` : ""}
        alt={image?.name ?? ""}
        open={previewOpen && image !== null}
        onOpenChange={(open) => setPreviewOpen(open)}
        onDownload={image ? () => void download(image) : undefined}
        downloadLabel={t("downloadImage")}
        onCopy={image && canCopy ? () => void copy(image) : undefined}
        copyLabel={t("copyImage")}
        renderImage={
          image
            ? (preview) => <ImageActions image={image}>{preview}</ImageActions>
            : undefined
        }
      />
    </div>
  )
})
