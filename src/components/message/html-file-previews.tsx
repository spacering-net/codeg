"use client"

import { memo, useCallback, useMemo, useState } from "react"
import { Eye, FileCode2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { useTranscriptRoot } from "@/components/ai-elements/markdown-local-image"
import { resolveAbsPath } from "@/lib/html-preview-inline"
import { CodexVisualizeCard } from "./codex-visualize-card"

/**
 * On-demand previews for the local HTML files a reply mentions (see
 * `findHtmlFileMentions`). Any agent that writes an HTML file — a Claude Code
 * report, a Hermes `MEDIA:` attachment, a Codex export — gets a one-line
 * "Preview" row under its reply; clicking it expands the same sandboxed card
 * the explicit visualize references use. Collapsed by default so a transcript
 * that names many files does not turn into a wall of iframes.
 *
 * Relative mentions resolve against the transcript's working directory;
 * without one they are dropped rather than guessed.
 */
export const HtmlFilePreviews = memo(function HtmlFilePreviews({
  paths,
}: {
  paths: string[]
}) {
  const folderPath = useTranscriptRoot()
  const resolved = useMemo(() => {
    const out: string[] = []
    for (const p of paths) {
      const abs =
        p.startsWith("/") || p.startsWith("~/")
          ? p
          : folderPath
            ? resolveAbsPath(folderPath, p)
            : null
      if (abs && !out.includes(abs)) out.push(abs)
    }
    return out
  }, [paths, folderPath])

  if (resolved.length === 0) return null
  return (
    <div className="not-prose flex flex-col gap-1.5">
      {resolved.map((path) => (
        <HtmlFilePreview key={path} path={path} />
      ))}
    </div>
  )
})

function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf("/")
  return i === -1
    ? { name: path, dir: "" }
    : { name: path.slice(i + 1), dir: path.slice(0, i) }
}

const HtmlFilePreview = memo(function HtmlFilePreview({
  path,
}: {
  path: string
}) {
  const t = useTranslations("Folder.chat.contentParts")
  const [open, setOpen] = useState(false)
  const collapse = useCallback(() => setOpen(false), [])
  const { name, dir } = splitPath(path)

  if (open) {
    return (
      <CodexVisualizeCard path={path} mode="normal" onCollapse={collapse} />
    )
  }
  return (
    <div
      data-testid="html-file-preview"
      className="flex h-10 min-w-0 items-center gap-2.5 rounded-lg border border-border bg-card px-3 ws-msg-card"
    >
      <FileCode2 className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-xs font-medium text-foreground/85">
        {name}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-2xs text-muted-foreground"
        title={path}
      >
        {dir}
      </span>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("htmlPreviewOpenAria", { name })}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:bg-primary/8 hover:text-foreground"
      >
        <Eye className="h-3.5 w-3.5" />
        {t("htmlPreviewOpen")}
      </button>
    </div>
  )
})
