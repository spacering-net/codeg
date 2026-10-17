"use client"

import { memo, useEffect, useState } from "react"
import { AlertCircle, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { useTranscriptRoot } from "@/components/ai-elements/markdown-local-image"
import { ImagePreviewDialog } from "@/components/ui/image-preview-dialog"
import { readFileBase64 } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  expandHomePath,
  isHomeRelativePath,
  joinRootRel,
} from "@/lib/file-open-target"
import { isAbsoluteFilePath } from "@/lib/file-path-display"
import { ImageActions, useImageActions } from "./image-actions"

function isRelativePath(path: string): boolean {
  return !isHomeRelativePath(path) && !isAbsoluteFilePath(path)
}

/** `~/…` against the home directory, a relative path against `baseDir`. */
async function resolveReadPath(
  path: string,
  baseDir: string | null
): Promise<string | null> {
  if (isHomeRelativePath(path)) return expandHomePath(path)
  if (isAbsoluteFilePath(path)) return path
  return baseDir ? joinRootRel(baseDir, path) : null
}

type LoadResult = {
  key: string
  data: string | null
  error: string | null
}

/**
 * The picture a Read of an image file read, drawn in the Read card's body.
 *
 * An agent that reads an image does not always hand its bytes back: codex-acp
 * reports `view_image` as a `read` whose only content is a resource link to the
 * path, so the card had nothing to show but that path. A Read whose result does
 * carry the bytes (Claude Code's) never gets here; the adapter turns it into an
 * image card instead.
 *
 * The body mounts only once the user expands the card, and the path in its
 * header already opens this file in the file panel, through this same reader.
 * Expanding the card reaches no file the card did not already offer to open.
 * A Markdown image renders unprompted, which is why it stays confined to the
 * transcript's folder (`resolveLocalImage`) and this does not.
 *
 * A relative path resolves against the transcript's working directory, never
 * the globally active folder. Without one there is nothing to show.
 */
export const ReadImagePreview = memo(function ReadImagePreview({
  path,
  mime,
}: {
  path: string
  mime: string
}) {
  const t = useTranslations("Folder.chat.contentParts")
  const tList = useTranslations("Folder.chat.messageList")
  const transcriptRoot = useTranscriptRoot()
  // Only a relative path depends on the root (and reloads when it changes).
  const relative = isRelativePath(path)
  const baseDir = relative ? transcriptRoot : null
  const resolvable = !relative || baseDir !== null
  const key = `${path}\u0000${baseDir ?? ""}`
  const [result, setResult] = useState<LoadResult | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const { canCopy, copy, download } = useImageActions()

  useEffect(() => {
    if (!resolvable) return
    let cancelled = false
    void (async () => {
      const absPath = await resolveReadPath(path, baseDir)
      // `resolvable` already ruled out a relative path with no root.
      if (absPath === null) return null
      // The file panel's own read, and its default size limit.
      return readFileBase64(absPath)
    })().then(
      (data) => {
        if (!cancelled) setResult({ key, data, error: null })
      },
      (error: unknown) => {
        if (!cancelled)
          setResult({ key, data: null, error: toErrorMessage(error) })
      }
    )
    return () => {
      cancelled = true
    }
  }, [resolvable, path, baseDir, key])

  if (!resolvable) return null

  // A path or root change must never paint the previous file's bytes while
  // its replacement loads.
  const current = result?.key === key ? result : null
  if (!current) {
    return (
      <div
        role="status"
        className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground"
      >
        <Loader2
          aria-hidden="true"
          className="size-3.5 shrink-0 animate-spin"
        />
        {t("readImageLoading")}
      </div>
    )
  }
  if (current.data === null) {
    return (
      <div className="flex items-start gap-2 px-3 py-2 text-xs text-muted-foreground">
        <AlertCircle
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-destructive"
        />
        <div className="min-w-0">
          <div className="text-foreground/80">{t("readImageError")}</div>
          {current.error && (
            <div className="break-all font-mono text-2xs">{current.error}</div>
          )}
        </div>
      </div>
    )
  }

  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
  const image = { name, mime_type: mime, data: current.data, uri: null }
  const src = `data:${mime};base64,${current.data}`
  return (
    <div className="px-3 py-2">
      <ImageActions image={image} className="inline-block max-w-full align-top">
        <button
          type="button"
          aria-label={name}
          className="block max-w-full cursor-zoom-in"
          onClick={() => setPreviewOpen(true)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={name}
            className="h-auto max-h-80 max-w-full rounded-sm object-contain"
            // Not an image after all (a misnamed file): say so rather than
            // leave a broken-image icon behind.
            onError={() => setResult({ key, data: null, error: null })}
          />
        </button>
      </ImageActions>
      <ImagePreviewDialog
        src={src}
        alt={name}
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        onDownload={() => void download(image)}
        downloadLabel={tList("downloadImage")}
        onCopy={canCopy ? () => void copy(image) : undefined}
        copyLabel={tList("copyImage")}
        renderImage={(preview) => (
          <ImageActions image={image}>{preview}</ImageActions>
        )}
      />
    </div>
  )
})
