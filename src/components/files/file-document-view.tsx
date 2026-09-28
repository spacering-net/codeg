"use client"

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import type { BundledLanguage } from "shiki"

import { CodeBlockContent } from "@/components/ai-elements/code-block"
import { HtmlPreview } from "@/components/files/html-preview"
import { ImagePreview } from "@/components/files/image-preview"
import { MarkdownDocumentPreview } from "@/components/files/markdown-document-preview"
import { OfficePreview } from "@/components/files/office-preview"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import { isHtmlPreviewable } from "@/lib/language-detect"

/**
 * Read-only rendering of one workspace file tab — the shared body behind every
 * surface that shows a file WITHOUT the editing file column: the transcript's
 * file viewer drawer and the canvas's file card.
 *
 * It branches exactly the way the file column does, on the same tab fields, so
 * the surfaces can never disagree about what a tab holds:
 *
 *   language "image"  → ImagePreview      (content is a data: URL)
 *   language "office" → OfficePreview     (an officecli watch, no bytes here)
 *   HTML + preview on → HtmlPreview
 *   markdown + preview on → MarkdownDocumentPreview
 *   everything else   → shiki-highlighted source
 *
 * Deliberately NOT Monaco: these surfaces never edit, and Monaco's models and
 * undo stacks are the file column's business. That choice is what the size
 * ceiling below exists for.
 */

/**
 * Ceilings for the source view.
 *
 * `CodeBlockContent` builds one DOM node per line and hands the whole text to
 * shiki, with no virtualization anywhere — a multi-MB generated file would lock
 * the page up for seconds and keep the tokens cached afterwards. The file
 * column can afford such a file because Monaco virtualizes; these surfaces
 * cannot, so past these bounds they say so and point at the column instead.
 * Markdown and HTML previews are deliberately not capped here: they run the
 * same renderer the file column runs, with the same exposure.
 */
export const SOURCE_VIEW_MAX_BYTES = 512 * 1024
export const SOURCE_VIEW_MAX_LINES = 5_000

/**
 * Monaco language ids (what `languageFromPath` speaks, and therefore what a
 * file tab carries) that shiki does not know under that name. Anything absent
 * is passed through — shiki either knows it or falls back to unhighlighted
 * text on its own, which is the same outcome, just noisier in the console.
 */
const SHIKI_LANGUAGE_ALIASES: Record<string, string> = {
  plaintext: "text",
  restructuredtext: "text",
  "objective-c": "objc",
  bat: "batch",
  shell: "bash",
  mdx: "markdown",
}

function toShikiLanguage(language: string): BundledLanguage {
  return (SHIKI_LANGUAGE_ALIASES[language] ?? language) as BundledLanguage
}

/** Markdown links that resolve to a local file do nothing when the host
 *  surface offers no navigation. Module-level so the render below doesn't mint
 *  a new identity for the preview on every pass. */
function noop() {}

export function CenteredNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
      {children}
    </div>
  )
}

export function FileDocumentView({
  tab,
  io,
  previewRoot,
  isPreview,
  line = null,
  onOpenMarkdownLink,
}: {
  /** The tab to render. Null while the file is still being resolved. */
  tab: FileWorkspaceTab | null
  /** Backend read pair for the file: `(directory, name)`. Office previews need
   *  it, and it is the fallback markdown/HTML sub-resource root. */
  io: { rootPath: string; ioPath: string } | null
  /** Sub-resource resolution root for markdown/HTML: the owning registered
   *  folder when the file sits in one, else its own directory. */
  previewRoot: string | null
  /** Whether the rendered (rather than source) view is showing. Only markdown
   *  and previewable HTML honour it. */
  isPreview: boolean
  /** Scroll this 1-based line into view once the tokens land. */
  line?: number | null
  /** Follow a link inside a rendered markdown document. Absent = links that
   *  resolve to local files do nothing. */
  onOpenMarkdownLink?: (path: string) => void
}) {
  const t = useTranslations("Folder.fileViewer")

  // Cold load — no bytes yet. A refresh of an already-loaded tab keeps the
  // previous content on screen (the file column's "non-destructive refresh").
  if (!tab || (tab.loading && tab.content === "")) {
    return <CenteredNotice>{t("loading")}</CenteredNotice>
  }
  // Deliberately NO `saveState === "error"` branch. A LOAD failure and a SAVE
  // failure share that one flag, and nothing on the tab tells them apart:
  // `rejectTab` puts the localized "unable to load <message>" sentence in
  // `content` on a clean tab, while a failed save leaves `content` as the
  // user's buffer — and that buffer is clean too whenever they happened to
  // revert it while the save was in flight (`updateFileTabContent` recomputes
  // `isDirty` against `savedContent`). Guessing wrong prints the whole document
  // as an error notice. So these surfaces do what the file column does: render
  // whatever the tab holds. A load failure surfaces as its own message in the
  // document body, which is exactly where the column shows it.
  //
  // The synthetic "image" / "office" languages are stamped onto the tab by
  // whoever seeded it — branch on those, exactly as the file column does.
  if (tab.language === "image") {
    return <ImagePreview key={tab.id} tab={tab} />
  }
  if (tab.language === "office") {
    return (
      <OfficePreview
        key={tab.id}
        rootPath={io?.rootPath ?? null}
        relPath={io?.ioPath ?? null}
      />
    )
  }
  if (isPreview && isHtmlPreviewable(tab.path)) {
    return <HtmlPreview key={tab.id} tab={tab} rootPath={previewRoot} />
  }
  if (isPreview && tab.language === "markdown") {
    return (
      <MarkdownDocumentPreview
        content={tab.content}
        fileDir={io?.rootPath ?? null}
        previewRoot={previewRoot}
        openFilePreview={onOpenMarkdownLink ?? noop}
      />
    )
  }

  return (
    <SourceView
      // A different file (or a re-open at a different line) must re-run the
      // scroll effect, and the DOM it measures belongs to this file's render.
      key={`${tab.id}:${line ?? ""}`}
      code={tab.content}
      language={tab.language}
      line={line}
    />
  )
}

/**
 * Read-only source view. Shiki-highlighted like every other code block in a
 * transcript rather than a second Monaco.
 */
function SourceView({
  code,
  language,
  line,
}: {
  code: string
  language: string
  line: number | null
}) {
  const t = useTranslations("Folder.fileViewer")
  const containerRef = useRef<HTMLDivElement | null>(null)
  const tooLarge =
    code.length > SOURCE_VIEW_MAX_BYTES ||
    countLines(code) > SOURCE_VIEW_MAX_LINES

  // Reveal the requested line once the tokens have rendered. `CodeBlockBody`
  // emits exactly one element per source line, so the line number indexes
  // straight into `<code>`'s children. Re-run on `code` because the first
  // paint uses raw tokens and shiki swaps in highlighted ones a tick later.
  useEffect(() => {
    if (!line || tooLarge) return
    const target = containerRef.current
      ?.querySelector("code")
      ?.children.item(line - 1)
    target?.scrollIntoView({ block: "center" })
  }, [code, line, tooLarge])

  if (tooLarge) {
    return <CenteredNotice>{t("tooLargeToPreview")}</CenteredNotice>
  }

  return (
    <div ref={containerRef} className="h-full overflow-auto">
      <CodeBlockContent
        code={code}
        language={toShikiLanguage(language)}
        showLineNumbers
      />
    </div>
  )
}

/** Line count without allocating an array of every line. */
function countLines(text: string): number {
  let lines = 1
  for (
    let index = text.indexOf("\n");
    index >= 0;
    index = text.indexOf("\n", index + 1)
  ) {
    lines += 1
    if (lines > SOURCE_VIEW_MAX_LINES) return lines
  }
  return lines
}
