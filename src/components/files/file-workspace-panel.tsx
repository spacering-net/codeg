"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
import { ChevronDown, ChevronRight, FileCode2, FileIcon } from "lucide-react"
import type {
  editor as MonacoEditorNs,
  IDisposable,
  IPosition,
} from "monaco-editor"
import type { Monaco, OnChange, OnMount } from "@monaco-editor/react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabStore } from "@/contexts/tab-context"
import { emitAttachFileToSession } from "@/lib/session-attachment-events"
import { formatFileRangeLabel } from "@/lib/reference-link"
import { findOwningFolder, splitAbsPath } from "@/lib/file-open-target"
import {
  buildMonacoModelPath,
  collectLiveModelPaths,
} from "@/lib/monaco-model-path"
import { parseFileTabId } from "@/lib/file-tab-id"
import {
  useWorkspaceActions,
  useWorkspaceFileTabs,
  type FileWorkspaceTab,
} from "@/contexts/workspace-context"
import { BrowserTabView } from "@/components/browser/browser-tab-view"
import { ImagePreview } from "@/components/files/image-preview"
import { HtmlPreview } from "@/components/files/html-preview"
import { MarkdownDocumentPreview } from "@/components/files/markdown-document-preview"
import { OfficePreview } from "@/components/files/office-preview"
import { isHtmlPreviewable, isOfficePreviewable } from "@/lib/language-detect"
import { DiffViewer } from "@/components/diff/diff-viewer"
import { ImageDiffView } from "@/components/diff/image-diff-view"
import { UnifiedDiffPreview } from "@/components/diff/unified-diff-preview"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  defineMonacoThemes,
  MONACO_UNICODE_HIGHLIGHT_OPTIONS,
  useMonacoWorkspaceTheme,
} from "@/lib/monaco-themes"
import { useZoomLevel, useEditorFont } from "@/hooks/use-appearance"
import { useImeSafeEditorValue } from "@/hooks/use-ime-safe-editor-value"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  getAddToChatPillPlacement,
  type AddToChatPillPlacement,
} from "@/lib/add-to-chat-pill-placement"

import "@/lib/monaco-local"

const AUTO_SAVE_DELAY_MS = 5000

interface AddToChatPill {
  widget: MonacoEditorNs.IContentWidget
  isVisible: () => boolean
  setVisible: (visible: boolean, position: IPosition | null) => void
  /** Re-read the label (e.g. after a locale change) even while already shown. */
  refreshLabel: () => void
  /**
   * Re-read the rendered pill height now that Monaco has un-hidden the node.
   * Returns true when the cached value changed, i.e. when the caller should lay
   * the widget out once more so the corrected placement lands.
   */
  remeasure: () => boolean
}

/**
 * Placement fallback for the very first show, before the pill has ever been
 * measured (Monaco keeps the node at `display: none` until *after* it asks for
 * a position, so `offsetHeight` reads 0 exactly when the placement is decided).
 * Deliberately a slight over-estimate of the real box: over-estimating only
 * demotes ABOVE for one extra line, while under-estimating is what puts the
 * pill back behind the file path bar.
 */
const ADD_TO_CHAT_PILL_FALLBACK_HEIGHT_PX = 28

/**
 * The floating "Add to Chat" pill shown next to a text selection, built as a
 * Monaco content widget. Raw DOM (not React) so it lives in Monaco's own
 * overflow layer; `allowEditorOverflow` keeps it un-clipped at the viewport edge
 * and during horizontal scroll, and `suppressMouseDown` stops a click from
 * collapsing the selection before `addSelectionToChat` reads it. `getPosition`
 * returns null while hidden — Monaco unmounts the widget on a null position, so
 * visibility is driven entirely through {@link AddToChatPill.setVisible} +
 * `layoutContentWidget`.
 *
 * Keep `allowEditorOverflow`: dropping it moves the node inside the editor's own
 * scrollable content, where the vertical scrollbar paints over the pill for any
 * anchor near the right edge (reproduced against monaco 0.55.1 — a hit test on
 * the pill's right-hand corners resolves to the scrollbar, not the button), and
 * the node then shrink-to-fits to min-content and wraps to three lines. The cost
 * of keeping it is that Monaco decides placement from *page* geometry, which
 * {@link getAddToChatPillPlacement} corrects back to viewport geometry.
 */
function createAddToChatPill(
  editor: MonacoEditorNs.IStandaloneCodeEditor,
  monaco: Monaco,
  onActivate: () => void,
  getLabel: () => string
): AddToChatPill {
  const dom = document.createElement("button")
  dom.type = "button"
  // No `display` utility on the button: Monaco's content-widget renderer writes
  // an inline `display: block` onto this node to show it (and `display: none` to
  // hide it — contentWidgets.js wraps `getDomNode()` directly), which beats any
  // `inline-flex` class and stacks the icon above the label. So the flex row
  // lives on an inner <span> Monaco never touches; the button keeps only the
  // pill chrome and shrink-wraps it (Monaco positions the button absolutely).
  dom.className =
    "codeg-add-to-chat-pill rounded-md border border-border bg-popover px-2 py-0.5 text-xs font-medium text-popover-foreground shadow-md cursor-pointer select-none hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
  // Hand-written SVG (lucide "message-square-plus"): raw DOM can't host a React
  // lucide component. `currentColor` + the blue text class echoes the file badge.
  dom.innerHTML =
    '<span class="inline-flex items-center gap-1">' +
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="text-blue-600 dark:text-blue-400"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M9 10h6"/><path d="M12 7v6"/></svg>' +
    '<span class="codeg-add-to-chat-label"></span>' +
    "</span>"
  const labelSpan = dom.querySelector(".codeg-add-to-chat-label")
  if (labelSpan) labelSpan.textContent = getLabel()
  dom.addEventListener("click", (event) => {
    event.preventDefault()
    event.stopPropagation()
    onActivate()
  })

  let visible = false
  let position: IPosition | null = null
  let measuredHeight = 0

  const toMonacoPreference = (placement: AddToChatPillPlacement) =>
    placement === "above"
      ? monaco.editor.ContentWidgetPositionPreference.ABOVE
      : monaco.editor.ContentWidgetPositionPreference.BELOW

  const widget: MonacoEditorNs.IContentWidget = {
    getId: () => "codeg.addToChatPill",
    getDomNode: () => dom,
    getPosition: () => {
      if (!visible || !position) return null

      // Rebuild the two measurements Monaco's `_layoutBoxInViewport` works
      // from. `getTopForPosition` is wrap-aware (it converts to a view position
      // first) and is a layout-model lookup, not a DOM measurement, so this is
      // safe on the scroll path. A negative return means "no model", not a real
      // offset. `getLayoutInfo().height` is exactly Monaco's `viewportHeight`
      // (the value it hands the scrollable), so the two agree to the pixel.
      const anchorTop = editor.getTopForPosition(
        position.lineNumber,
        position.column
      )
      const lineHeightPx = editor.getLineHeightForPosition(position)
      const spaceAbovePx =
        anchorTop < 0 ? null : anchorTop - editor.getScrollTop()
      const preference = getAddToChatPillPlacement({
        spaceAbovePx,
        spaceBelowPx:
          spaceAbovePx === null
            ? 0
            : editor.getLayoutInfo().height - (spaceAbovePx + lineHeightPx),
        lineHeightPx,
        pillHeightPx: measuredHeight || ADD_TO_CHAT_PILL_FALLBACK_HEIGHT_PX,
      }).map(toMonacoPreference)

      // An empty list means "nowhere sensible" — hand Monaco a null position so
      // it unmounts the pill, the same way {@link AddToChatPill.setVisible}
      // hides it. It comes back on the next layout once the anchor is in view.
      return preference.length > 0 ? { position, preference } : null
    },
    allowEditorOverflow: true,
    suppressMouseDown: true,
  }

  return {
    widget,
    isVisible: () => visible,
    setVisible: (next, pos) => {
      visible = next
      position = pos
      if (next && labelSpan) labelSpan.textContent = getLabel()
    },
    refreshLabel: () => {
      if (labelSpan) labelSpan.textContent = getLabel()
    },
    remeasure: () => {
      const next = dom.offsetHeight
      if (next <= 0 || next === measuredHeight) return false
      measuredHeight = next
      return true
    },
  }
}

// True once a tab has *something* to render. Drives the rendering predicate
// so that a refresh on a loaded tab keeps the previous content visible
// (and the loading state is signalled by the subtle top-right badge),
// matching VS Code / IntelliJ "non-destructive refresh" behaviour. Only
// a true cold load (no content yet) falls back to the full-pane placeholder.
function hasTabContent(tab: FileWorkspaceTab): boolean {
  // A browser tab has no text content; its page lives in a native surface.
  if (tab.kind === "browser") return true
  if (tab.kind === "rich-diff") {
    return (
      tab.originalContent !== undefined ||
      tab.modifiedContent !== undefined ||
      // An image diff carries neither: its sides are bytes, not text.
      tab.imageDiff !== undefined
    )
  }
  return tab.content !== ""
}

interface DiffOutlineFile {
  key: string
  path: string
  startLine: number
  endLine: number
  additions: number
  deletions: number
  hunks: DiffOutlineHunk[]
}

interface DiffOutlineHunk {
  key: string
  startLine: number
  endLine: number
  header: string
  additions: number
  deletions: number
}

interface DiffOutline {
  files: DiffOutlineFile[]
  totalAdditions: number
  totalDeletions: number
  totalHunks: number
}

type DiffListContext =
  | { kind: "commit"; commitHash: string; commitMessage: string | null }
  | { kind: "working"; path: string }
  | { kind: "branch"; branch: string; path: string }

function normalizeDiffPath(rawPath: string): string | null {
  const trimmed = rawPath.trim().replace(/^"|"$/g, "")
  if (!trimmed || trimmed === "/dev/null") return null

  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) {
    return trimmed.slice(2).replace(/\\/g, "/")
  }

  return trimmed.replace(/\\/g, "/")
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/")
}

function parsePathFromDiffGitLine(line: string): string | null {
  if (!line.startsWith("diff --git ")) return null
  const match = line.match(/^diff --git\s+(.+?)\s+(.+)$/)
  if (!match) return null

  return normalizeDiffPath(match[2]) ?? normalizeDiffPath(match[1])
}

function parsePathFromFileHeader(
  line: string,
  prefix: "--- " | "+++ "
): string | null {
  if (!line.startsWith(prefix)) return null
  return normalizeDiffPath(line.slice(prefix.length))
}

function parsePathFromApplyPatchLine(line: string): string | null {
  const prefixes = ["*** Update File: ", "*** Add File: ", "*** Delete File: "]

  for (const prefix of prefixes) {
    if (line.startsWith(prefix)) {
      return normalizeDiffPath(line.slice(prefix.length))
    }
  }

  return null
}

function parseMovedPathFromApplyPatchLine(line: string): string | null {
  if (!line.startsWith("*** Move to: ")) return null
  return normalizeDiffPath(line.slice(13))
}

function buildDiffOutline(content: string): DiffOutline | null {
  if (!content.trim()) return null

  const lines = content.split("\n")
  const files: DiffOutlineFile[] = []

  let current: DiffOutlineFile | null = null
  let currentHunk: {
    startLine: number
    header: string
    additions: number
    deletions: number
  } | null = null
  let fileIndex = 1
  let hunkIndex = 1

  const createFile = (
    lineNumber: number,
    path: string | null
  ): DiffOutlineFile => {
    const entry: DiffOutlineFile = {
      key: `${lineNumber}-${fileIndex}`,
      path: path ?? `Diff #${fileIndex}`,
      startLine: lineNumber,
      endLine: lineNumber,
      additions: 0,
      deletions: 0,
      hunks: [],
    }
    fileIndex += 1
    return entry
  }

  const flushHunk = (endLine: number) => {
    if (!current || !currentHunk) return

    const normalizedEnd = Math.max(currentHunk.startLine, endLine)
    current.hunks.push({
      key: `${current.key}:hunk-${hunkIndex}`,
      startLine: currentHunk.startLine,
      endLine: normalizedEnd,
      header: currentHunk.header,
      additions: currentHunk.additions,
      deletions: currentHunk.deletions,
    })
    hunkIndex += 1
    currentHunk = null
  }

  const flushFile = () => {
    if (!current) return

    if (currentHunk) {
      flushHunk(current.endLine)
    }

    if (
      current.hunks.length === 0 &&
      (current.additions > 0 || current.deletions > 0)
    ) {
      current.hunks.push({
        key: `${current.key}:hunk-${hunkIndex}`,
        startLine: current.startLine,
        endLine: current.endLine,
        header: "Change",
        additions: current.additions,
        deletions: current.deletions,
      })
      hunkIndex += 1
    }

    files.push(current)
    current = null
  }

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1

    const diffGitPath = parsePathFromDiffGitLine(line)
    if (diffGitPath) {
      flushFile()
      current = createFile(lineNumber, diffGitPath)
      continue
    }

    const applyPatchPath = parsePathFromApplyPatchLine(line)
    if (applyPatchPath) {
      flushFile()
      current = createFile(lineNumber, applyPatchPath)
      continue
    }

    if (line.startsWith("--- ") && currentHunk) {
      flushHunk(lineNumber - 1)
    }

    const movedPath = parseMovedPathFromApplyPatchLine(line)
    if (movedPath && current) {
      current.path = movedPath
    }

    if (!current) {
      const minusPath = parsePathFromFileHeader(line, "--- ")
      if (minusPath) {
        current = createFile(lineNumber, minusPath)
      } else {
        const plusPath = parsePathFromFileHeader(line, "+++ ")
        if (plusPath) current = createFile(lineNumber, plusPath)
      }
    } else {
      const plusPath = parsePathFromFileHeader(line, "+++ ")
      if (plusPath) current.path = plusPath
    }

    if (!current) continue
    current.endLine = lineNumber

    if (line.startsWith("@@ ")) {
      if (currentHunk) {
        flushHunk(lineNumber - 1)
      }
      currentHunk = {
        startLine: lineNumber,
        header: line,
        additions: 0,
        deletions: 0,
      }
      continue
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.additions += 1
      if (currentHunk) currentHunk.additions += 1
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletions += 1
      if (currentHunk) currentHunk.deletions += 1
    }
  }

  flushFile()

  if (files.length === 0) return null

  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0)
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const totalHunks = files.reduce((sum, file) => sum + file.hunks.length, 0)

  return {
    files,
    totalAdditions,
    totalDeletions,
    totalHunks,
  }
}

function setEditorHiddenAreas(
  editor: MonacoEditorNs.IStandaloneCodeEditor,
  ranges: {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  }[]
) {
  const hiddenAreaEditor = editor as unknown as {
    setHiddenAreas?: (
      hiddenRanges: {
        startLineNumber: number
        startColumn: number
        endLineNumber: number
        endColumn: number
      }[]
    ) => void
  }

  hiddenAreaEditor.setHiddenAreas?.(ranges)
}

const MonacoEditor = dynamic(async () => import("@monaco-editor/react"), {
  ssr: false,
})

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n")
}

function splitDiffLines(text: string): string[] {
  if (!text) return []
  return normalizeLineEndings(text).split("\n")
}

function lowerBound(values: number[], target: number): number {
  let lo = 0
  let hi = values.length

  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (values[mid] < target) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }

  return lo
}

function computeLcsMatches(
  baseLines: string[],
  currentLines: string[]
): Array<{ baseIndex: number; currentIndex: number }> | null {
  const MAX_MATCHES_PER_LINE = 256
  const MAX_TOKENS = 200_000
  const basePositions = new Map<string, number[]>()

  for (const [index, line] of baseLines.entries()) {
    const positions = basePositions.get(line)
    if (positions) {
      positions.push(index)
    } else {
      basePositions.set(line, [index])
    }
  }

  const tokens: Array<{ baseIndex: number; currentIndex: number }> = []
  for (const [currentIndex, line] of currentLines.entries()) {
    const positions = basePositions.get(line)
    if (!positions) continue
    if (positions.length > MAX_MATCHES_PER_LINE) continue
    for (let pos = positions.length - 1; pos >= 0; pos -= 1) {
      tokens.push({ baseIndex: positions[pos], currentIndex })
      if (tokens.length > MAX_TOKENS) return null
    }
  }

  if (tokens.length === 0) return []

  const tails: number[] = []
  const tailsTokenIndex: number[] = []
  const prevTokenIndex = Array<number>(tokens.length).fill(-1)

  for (const [tokenIndex, token] of tokens.entries()) {
    const len = lowerBound(tails, token.baseIndex)
    tails[len] = token.baseIndex
    tailsTokenIndex[len] = tokenIndex
    if (len > 0) {
      prevTokenIndex[tokenIndex] = tailsTokenIndex[len - 1]
    }
  }

  const matches: Array<{ baseIndex: number; currentIndex: number }> = []
  let cursor = tailsTokenIndex[tails.length - 1]
  while (cursor >= 0) {
    const token = tokens[cursor]
    matches.push({
      baseIndex: token.baseIndex,
      currentIndex: token.currentIndex,
    })
    cursor = prevTokenIndex[cursor]
  }

  matches.reverse()
  return matches
}

interface GitGutterLineMarkers {
  added: number[]
  modified: number[]
  deleted: number[]
}

const EMPTY_GIT_GUTTER_LINE_MARKERS: GitGutterLineMarkers = {
  added: [],
  modified: [],
  deleted: [],
}

function toSortedUniqueLineNumbers(lineNumbers: number[]): number[] {
  if (lineNumbers.length <= 1) return lineNumbers
  return [...new Set(lineNumbers)].sort((a, b) => a - b)
}

function appendLineRange(
  target: number[],
  startIndexInclusive: number,
  endIndexExclusive: number
) {
  for (let index = startIndexInclusive; index < endIndexExclusive; index += 1) {
    target.push(index + 1)
  }
}

function computeGitGutterLineMarkers(
  baseContent: string,
  currentContent: string
): GitGutterLineMarkers {
  const MAX_TOTAL_LINES = 20_000
  if (baseContent === currentContent) {
    return EMPTY_GIT_GUTTER_LINE_MARKERS
  }

  const baseLines = splitDiffLines(baseContent)
  const currentLines = splitDiffLines(currentContent)
  if (baseLines.length + currentLines.length > MAX_TOTAL_LINES) {
    return EMPTY_GIT_GUTTER_LINE_MARKERS
  }

  if (
    normalizeLineEndings(baseContent) === normalizeLineEndings(currentContent)
  ) {
    return EMPTY_GIT_GUTTER_LINE_MARKERS
  }
  if (baseLines.length === 0) {
    return {
      added: currentLines.map((_, index) => index + 1),
      modified: [],
      deleted: [],
    }
  }
  if (currentLines.length === 0) {
    return {
      added: [],
      modified: [],
      deleted: [1],
    }
  }

  const matches = computeLcsMatches(baseLines, currentLines)
  if (matches === null) {
    return EMPTY_GIT_GUTTER_LINE_MARKERS
  }
  const added: number[] = []
  const modified: number[] = []
  const deleted: number[] = []

  let previousBase = -1
  let previousCurrent = -1
  const sentinels = [
    ...matches,
    { baseIndex: baseLines.length, currentIndex: currentLines.length },
  ]

  for (const match of sentinels) {
    const baseGap = match.baseIndex - previousBase - 1
    const currentGap = match.currentIndex - previousCurrent - 1

    if (baseGap === 0 && currentGap > 0) {
      appendLineRange(added, previousCurrent + 1, match.currentIndex)
    } else if (baseGap > 0 && currentGap === 0) {
      const anchorLine = Math.max(
        1,
        Math.min(currentLines.length, match.currentIndex + 1)
      )
      deleted.push(anchorLine)
    } else if (baseGap > 0 && currentGap > 0) {
      appendLineRange(modified, previousCurrent + 1, match.currentIndex)
    }

    previousBase = match.baseIndex
    previousCurrent = match.currentIndex
  }

  return {
    added: toSortedUniqueLineNumbers(added),
    modified: toSortedUniqueLineNumbers(modified),
    deleted: toSortedUniqueLineNumbers(deleted),
  }
}

function DiffFileList({
  diffOutline,
  badge,
  description,
  onOpenDiff,
  openFilePreview,
}: {
  diffOutline: DiffOutline
  badge?: string | null
  description?: string | null
  onOpenDiff: (path: string) => Promise<void>
  openFilePreview: (path: string) => Promise<unknown>
}) {
  const t = useTranslations("Folder.fileWorkspacePanel")
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="border-b border-border bg-muted/25 px-3 py-2 space-y-1">
        <div className="text-2xs text-muted-foreground flex items-center gap-3">
          {badge && (
            <span className="font-medium text-foreground/80 font-mono">
              {badge}
            </span>
          )}
          <span>{t("fileCount", { count: diffOutline.files.length })}</span>
          <span className="font-mono text-green-600 dark:text-green-400">
            +{diffOutline.totalAdditions}
          </span>
          <span className="font-mono text-red-600 dark:text-red-400">
            -{diffOutline.totalDeletions}
          </span>
        </div>
        {description && (
          <p className="text-xs text-foreground/70 line-clamp-2 leading-snug">
            {description}
          </p>
        )}
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="py-1">
          {diffOutline.files.map((file) => (
            <ContextMenu key={file.key}>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/50 transition-colors group"
                  onClick={() => {
                    void onOpenDiff(file.path)
                  }}
                  title={file.path}
                >
                  <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-xs truncate flex-1 min-w-0 font-mono">
                    {file.path}
                  </span>
                  <span className="shrink-0 flex items-center gap-2 text-3xs font-mono">
                    {file.additions > 0 && (
                      <span className="text-green-600 dark:text-green-400">
                        +{file.additions}
                      </span>
                    )}
                    {file.deletions > 0 && (
                      <span className="text-red-600 dark:text-red-400">
                        -{file.deletions}
                      </span>
                    )}
                  </span>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  onSelect={() => {
                    void onOpenDiff(file.path)
                  }}
                >
                  {t("viewDiff")}
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() => {
                    void openFilePreview(file.path)
                  }}
                >
                  {t("openFile")}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

export function FileWorkspacePanel() {
  const t = useTranslations("Folder.fileWorkspacePanel")
  const { activeFileTab, fileTabs, pendingFileReveal, previewFileTabIds } =
    useWorkspaceFileTabs()
  const {
    consumePendingFileReveal,
    openBranchDiff,
    openCommitDiff,
    openFilePreview,
    openWorkingTreeDiff,
    saveActiveFile,
    setFileTabComposing,
    updateFileTabContent,
  } = useWorkspaceActions()
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  // The ACTIVE TAB's file location. File tabs are identified by their
  // absolute path; the owning registered folder (when the file sits inside
  // one) is derived here ONLY to pick the preview root — reads never need
  // a folder.
  const activeAbsPath =
    activeFileTab?.kind === "file" ? (activeFileTab.path ?? null) : null
  const activeIo = useMemo(
    () => (activeAbsPath ? splitAbsPath(activeAbsPath) : null),
    [activeAbsPath]
  )
  const owningFolder = useMemo(
    () => (activeAbsPath ? findOwningFolder(activeAbsPath, allFolders) : null),
    [activeAbsPath, allFolders]
  )
  // Root for HTML/markdown sub-resource resolution: the owning folder root
  // keeps ../-style and root-relative references working for in-workspace
  // files; files outside every folder are confined to their own directory.
  const previewRoot = owningFolder?.rootPath ?? activeIo?.rootPath ?? null
  const activeScope = activeFileTab?.id ?? "__default__"
  const editorModelPath = buildMonacoModelPath(
    activeFileTab?.path ?? null,
    activeScope
  )
  const editorRef = useRef<MonacoEditorNs.IStandaloneCodeEditor | null>(null)
  const cursorListenerRef = useRef<{ dispose: () => void } | null>(null)
  const gitChangeDecorationsRef = useRef<string[]>([])
  // "Add selection to chat" plumbing. The Monaco action + content widget are
  // registered once at mount (the editor instance persists across file-tab
  // switches), so everything they read at activation time lives in refs to dodge
  // stale closures: the resolved target (folder/file/session), the attachable
  // flag (also mirrored into a Monaco context key that gates the triggers),
  // translations, and the disposables torn down on editor disposal.
  const attachContextRef = useRef<{
    absPath: string | null
    fileName: string
    sessionTabId: string | null
  }>({ absPath: null, fileName: "", sessionTabId: null })
  const attachableRef = useRef(false)
  const attachableKeyRef = useRef<MonacoEditorNs.IContextKey<boolean> | null>(
    null
  )
  const addToChatActionRef = useRef<IDisposable | null>(null)
  const addFileToChatActionRef = useRef<IDisposable | null>(null)
  const addToChatPillRef = useRef<AddToChatPill | null>(null)
  const selectionListenerRef = useRef<IDisposable | null>(null)
  const focusListenerRef = useRef<IDisposable | null>(null)
  const blurListenerRef = useRef<IDisposable | null>(null)
  const scrollListenerRef = useRef<IDisposable | null>(null)
  const layoutListenerRef = useRef<IDisposable | null>(null)
  const tRef = useRef(t)
  const monacoRef = useRef<Monaco | null>(null)
  // The loaded monaco instance, captured at editor mount. Passing it to the
  // theme hook (instead of the hook calling useMonaco()) keeps Monaco lazy: this
  // panel is always mounted, incl. the file-less empty state, so an internal
  // useMonaco() would eagerly load Monaco even with no editor shown.
  const [editorMonaco, setEditorMonaco] = useState<Monaco | null>(null)
  const editorTheme = useMonacoWorkspaceTheme(editorMonaco)
  // @monaco-editor/react creates a model per unseen `path` and never disposes
  // it — not on path change (it setModel()s away) and, on unmount, only the
  // currently attached one. Left alone, every file opened during a session
  // keeps its model (full text + tokenization + undo stack) alive after its
  // tab closes. Reconcile instead: remember each URI this panel has routed
  // through `path`, and dispose the ones whose tab is gone. Only URIs
  // recorded here are ever touched — models owned by others (diff editors'
  // anonymous pairs) are invisible to this cleanup.
  const createdModelUrisRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    createdModelUrisRef.current.add(editorModelPath)
  }, [editorModelPath])
  // Joined into one string so the disposal effect fires only when tab
  // membership changes — fileTabs itself churns per keystroke. URI segments
  // are %-encoded, so "\n" cannot occur inside an entry.
  const liveModelUrisKey = useMemo(
    () => collectLiveModelPaths(fileTabs).join("\n"),
    [fileTabs]
  )
  useEffect(() => {
    const monaco = editorMonaco
    if (!monaco) return
    const keep = new Set(liveModelUrisKey ? liveModelUrisKey.split("\n") : [])
    const tracked = createdModelUrisRef.current
    for (const uri of [...tracked]) {
      if (keep.has(uri)) continue
      const model = monaco.editor.getModel(monaco.Uri.parse(uri))
      if (!model) {
        // Never materialized, or already disposed by the library's unmount
        // path — either way no longer ours to manage.
        tracked.delete(uri)
        continue
      }
      // The editor's own effect runs first and has normally swapped off the
      // model by now; if it is somehow still attached, keep it and retry on
      // the next membership change instead of disposing an in-use model.
      if (model.isAttachedToEditor()) continue
      model.dispose()
      tracked.delete(uri)
    }
  }, [editorMonaco, liveModelUrisKey])
  const { zoomLevel } = useZoomLevel()
  const {
    editorFontStack,
    editorFontSize,
    editorLigatures,
    editorWordWrap,
    setEditorWordWrap,
  } = useEditorFont()
  // The Alt+Z toggle action is registered once at mount, so it reads the live
  // word-wrap preference through a ref to dodge a stale closure (same tactic as
  // tRef / attachContextRef). `setEditorWordWrap` from context is stable.
  const editorWordWrapRef = useRef(editorWordWrap)
  const wordWrapActionRef = useRef<IDisposable | null>(null)
  const [editorMountVersion, setEditorMountVersion] = useState(0)
  const [cursorLine, setCursorLine] = useState(1)
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>(
    {}
  )
  const [collapsedHunks, setCollapsedHunks] = useState<Record<string, boolean>>(
    {}
  )
  const renderedContent = activeFileTab?.content ?? ""
  const handleCompositionChange = useCallback(
    (composing: boolean, tabId: string) => {
      setFileTabComposing(tabId, composing)
    },
    [setFileTabComposing]
  )
  const {
    value: imeSafeEditorValue,
    isComposing,
    bindEditor: bindImeEditor,
  } = useImeSafeEditorValue(
    renderedContent,
    activeScope,
    handleCompositionChange
  )
  const isFileTab = activeFileTab?.kind === "file"
  const fileReadonly = isFileTab ? Boolean(activeFileTab.readonly) : true
  const fileSaveState = isFileTab ? (activeFileTab.saveState ?? "idle") : "idle"
  const fileIsDirty = isFileTab ? Boolean(activeFileTab.isDirty) : false
  const canEdit = isFileTab && !fileReadonly
  const handleEditorChange: OnChange = useCallback(
    (value) => {
      if (!isFileTab) return
      const currentModelUri = editorRef.current?.getModel()?.uri.toString()
      const expectedModelUri =
        monacoRef.current?.Uri.parse(editorModelPath).toString()
      if (!currentModelUri || currentModelUri !== expectedModelUri) {
        return
      }
      updateFileTabContent(activeScope, value ?? "")
    },
    [activeScope, editorModelPath, isFileTab, updateFileTabContent]
  )
  // The conversation a selection attaches to: the active top-bar tab when it is
  // a conversation (mirrors aux-panel-file-tree-tab's "Attach to Current
  // Session"). Null when no conversation is focused.
  const activeSessionTabId = useMemo(() => {
    const activeTab = tabs.find((tab) => tab.id === activeTabId)
    return activeTab && activeTab.kind === "conversation" ? activeTab.id : null
  }, [tabs, activeTabId])
  // Gate every trigger (menu item, ⌘L, pill) on a real file tab with a
  // resolvable absolute path AND a conversation to receive it. The same Monaco
  // instance also renders some diff tabs, so this guard is required.
  const isAttachable =
    isFileTab && Boolean(activeAbsPath) && Boolean(activeSessionTabId)

  // Read the live selection and emit it to the composer as a ranged file badge.
  // Reads only refs so it stays stable for the once-registered Monaco action.
  const addSelectionToChat = useCallback(() => {
    const editor = editorRef.current
    const ctx = attachContextRef.current
    const attachPath = ctx.absPath
    const sessionTabId = ctx.sessionTabId
    if (!editor || !sessionTabId || !attachPath) return
    const selection = editor.getSelection()
    if (!selection) return
    // With nothing selected the caret is an empty selection whose start and end
    // are both the cursor line, so the range below resolves to that single line
    // (`foo.ts:5`) — i.e. "add the current line" instead of the old silent
    // no-op. ⌘L shares this action (its precondition deliberately omits
    // `editorHasSelection` to swallow the built-in expandLineSelection), so ⌘L
    // with no selection now attaches the current line too. The pill is only ever
    // shown for a non-empty selection, so it is unaffected.
    const start = selection.startLineNumber
    let end = selection.endLineNumber
    // A full-line drag ends at column 1 of the line below the last selected
    // line; trim that trailing boundary so selecting lines 10–25 yields 10-25.
    if (end > start && selection.endColumn === 1) end -= 1
    if (end < start) end = start
    const range = { start, end }
    emitAttachFileToSession({
      tabId: sessionTabId,
      path: attachPath,
      range,
    })
    toast(
      tRef.current("addSelectionToChatDone", {
        label: formatFileRangeLabel(ctx.fileName, range),
      })
    )
  }, [])

  // Attach the whole active file (no line range) — the context-menu sibling of
  // "add selection to chat". Reads only refs so it stays stable for the
  // once-registered Monaco action. A missing range makes the composer append it
  // as a plain whole-file resource (same path file-tree / git-changes take).
  const addFileToChat = useCallback(() => {
    const ctx = attachContextRef.current
    const attachPath = ctx.absPath
    const sessionTabId = ctx.sessionTabId
    if (!sessionTabId || !attachPath) return
    emitAttachFileToSession({
      tabId: sessionTabId,
      path: attachPath,
    })
    toast(tRef.current("addFileToChatDone", { label: ctx.fileName }))
  }, [])

  // Register (or re-register) the two context-menu actions (+ ⌘L for the
  // selection one). Re-registerable so the labels can follow an in-app locale
  // change — Monaco caches an action's label at registration time, and the
  // editor instance outlives a tab switch.
  const registerAddToChatActions = useCallback(
    (
      editor: MonacoEditorNs.IStandaloneCodeEditor,
      monaco: Monaco,
      selectionLabel: string,
      fileLabel: string
    ) => {
      addToChatActionRef.current?.dispose()
      addToChatActionRef.current = editor.addAction({
        id: "codeg.addSelectionToChat",
        label: selectionLabel,
        contextMenuGroupId: "navigation",
        contextMenuOrder: 1.5,
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
        // Gate on attachability only — NOT `editorHasSelection`. Monaco's
        // addAction drives the context menu, the F1 palette, AND the keybinding
        // from this one precondition. Claiming ⌘L even without a selection is
        // deliberate: it stops ⌘L from falling through to the built-in
        // `expandLineSelection`, honoring the user's choice of ⌘L as "add to
        // chat". The empty case is handled in `run` — `addSelectionToChat`
        // attaches the current line — so menu / ⌘L always do something useful.
        precondition: "codegSelectionAttachable",
        run: () => addSelectionToChat(),
      })
      addFileToChatActionRef.current?.dispose()
      addFileToChatActionRef.current = editor.addAction({
        id: "codeg.addFileToChat",
        label: fileLabel,
        contextMenuGroupId: "navigation",
        contextMenuOrder: 1.6,
        // Whole-file attach is independent of any selection; share the same
        // attachability gate (real file tab + folder + active conversation).
        precondition: "codegSelectionAttachable",
        run: () => addFileToChat(),
      })
    },
    [addSelectionToChat, addFileToChat]
  )

  // Single teardown for the action, listeners, pill widget, and context key —
  // called from both the editor's onDidDispose and the React unmount effect.
  // `removeContentWidget` guards its view call internally, so it's a safe no-op
  // once disposed; the optional editor arg lets onDidDispose target the exact
  // disposing instance rather than a possibly-reassigned `editorRef`.
  const teardownAddToChat = useCallback(
    (editor?: MonacoEditorNs.IStandaloneCodeEditor | null) => {
      const target = editor ?? editorRef.current
      addToChatActionRef.current?.dispose()
      addToChatActionRef.current = null
      addFileToChatActionRef.current?.dispose()
      addFileToChatActionRef.current = null
      wordWrapActionRef.current?.dispose()
      wordWrapActionRef.current = null
      selectionListenerRef.current?.dispose()
      selectionListenerRef.current = null
      focusListenerRef.current?.dispose()
      focusListenerRef.current = null
      blurListenerRef.current?.dispose()
      blurListenerRef.current = null
      scrollListenerRef.current?.dispose()
      scrollListenerRef.current = null
      layoutListenerRef.current?.dispose()
      layoutListenerRef.current = null
      if (addToChatPillRef.current) {
        target?.removeContentWidget(addToChatPillRef.current.widget)
        addToChatPillRef.current = null
      }
      attachableKeyRef.current = null
    },
    []
  )

  // Register (or re-register) the word-wrap toggle. Re-registerable so the
  // label can follow an in-app locale change — Monaco caches an action's label
  // at registration time, and the editor outlives a tab switch. The handler
  // reads the live preference through a ref, so re-registration only refreshes
  // the label.
  //
  // Exposed BOTH as a right-click context-menu entry AND an Alt+Z keybinding
  // (mirrors how the add-to-chat action pairs a menu item with its shortcut).
  // The menu entry is the dependable path on macOS, where Alt is Option (⌥):
  // ⌥Z only fires while the editor itself is focused and Option-letter combos
  // are delivered unreliably through the webview (⌥Z otherwise inserts "Ω").
  const registerWordWrapAction = useCallback(
    (
      editor: MonacoEditorNs.IStandaloneCodeEditor,
      monaco: Monaco,
      label: string
    ) => {
      wordWrapActionRef.current?.dispose()
      wordWrapActionRef.current = editor.addAction({
        id: "codeg.toggleWordWrap",
        label,
        keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ],
        contextMenuGroupId: "z_view",
        contextMenuOrder: 1,
        run: () => setEditorWordWrap(!editorWordWrapRef.current),
      })
    },
    [setEditorWordWrap]
  )

  // Keep the activation refs + Monaco context key in sync with React state, and
  // hide the pill the moment the tab stops being attachable.
  useEffect(() => {
    tRef.current = t
    attachContextRef.current = {
      absPath: activeAbsPath,
      fileName: activeFileTab?.title ?? "",
      sessionTabId: activeSessionTabId,
    }
    attachableRef.current = isAttachable
    attachableKeyRef.current?.set(isAttachable)
    if (!isAttachable && editorRef.current && addToChatPillRef.current) {
      addToChatPillRef.current.setVisible(false, null)
      editorRef.current.layoutContentWidget(addToChatPillRef.current.widget)
    }
  }, [t, activeAbsPath, activeFileTab?.title, activeSessionTabId, isAttachable])

  // Keep the once-registered Alt+Z toggle action reading the live preference.
  useEffect(() => {
    editorWordWrapRef.current = editorWordWrap
  }, [editorWordWrap])

  // Refresh the cached action label when the locale changes. The initial
  // registration happens in handleEditorMount (the editor isn't mounted yet on
  // first render); this only re-fires once the label string actually changes.
  const addSelectionLabel = t("addSelectionToChat")
  const addFileLabel = t("addFileToChat")
  const toggleWordWrapLabel = t("toggleWordWrap")
  useEffect(() => {
    // The sync effect above runs first, so tRef.current is the fresh locale here
    // — refresh the (registration-cached) action labels and the live pill label.
    if (editorRef.current && monacoRef.current) {
      registerAddToChatActions(
        editorRef.current,
        monacoRef.current,
        addSelectionLabel,
        addFileLabel
      )
      registerWordWrapAction(
        editorRef.current,
        monacoRef.current,
        toggleWordWrapLabel
      )
    }
    addToChatPillRef.current?.refreshLabel()
  }, [
    addSelectionLabel,
    addFileLabel,
    toggleWordWrapLabel,
    registerAddToChatActions,
    registerWordWrapAction,
  ])

  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoSaveGuardRef = useRef({
    canEdit: false,
    fileIsDirty: false,
    fileSaveState: "idle" as "idle" | "saving" | "error",
  })
  const diffListContext = useMemo<DiffListContext | null>(() => {
    if (!activeFileTab) return null
    if (activeFileTab.kind !== "diff") return null

    const parts = parseFileTabId(activeFileTab.id)
    if (!parts) return null

    if (parts.kind === "diff-commit" && parts.path === null) {
      return {
        kind: "commit",
        commitHash: parts.commit,
        commitMessage: activeFileTab.description,
      }
    }

    if (parts.kind === "diff-working-overview") {
      return { kind: "working", path: parts.path }
    }

    if (parts.kind === "diff-branch-overview") {
      return {
        kind: "branch",
        branch: parts.branch,
        path: parts.path ?? "all",
      }
    }

    return null
  }, [activeFileTab])
  const diffOutline = useMemo(() => {
    if (!activeFileTab || activeFileTab.kind !== "diff") return null
    return buildDiffOutline(activeFileTab.content)
  }, [activeFileTab])
  const allHunks = useMemo(
    () =>
      diffListContext
        ? []
        : (diffOutline?.files.flatMap((file) => file.hunks) ?? []),
    [diffListContext, diffOutline]
  )
  const activeHunkIndex = useMemo(() => {
    if (allHunks.length === 0) return -1

    const containingIndex = allHunks.findIndex(
      (hunk) => cursorLine >= hunk.startLine && cursorLine <= hunk.endLine
    )
    if (containingIndex >= 0) return containingIndex

    const firstAfterIndex = allHunks.findIndex(
      (hunk) => hunk.startLine > cursorLine
    )
    if (firstAfterIndex < 0) return allHunks.length - 1
    return firstAfterIndex - 1
  }, [allHunks, cursorLine])

  const lineNumbersMinChars = useMemo(() => {
    const lineCount = renderedContent.split("\n").length
    const digits = String(Math.max(1, lineCount)).length

    // Keep a one-character buffer so numbers don't visually hug the gutter edge.
    return Math.max(3, digits + 1)
  }, [renderedContent])

  const hasGitBaseSnapshot =
    isFileTab && activeFileTab?.gitBaseContent !== undefined
  const gitBaseContent = hasGitBaseSnapshot
    ? (activeFileTab?.gitBaseContent ?? "")
    : ""
  const gitGutterLineMarkers = useMemo(() => {
    if (!hasGitBaseSnapshot) return EMPTY_GIT_GUTTER_LINE_MARKERS
    return computeGitGutterLineMarkers(gitBaseContent, renderedContent)
  }, [gitBaseContent, hasGitBaseSnapshot, renderedContent])

  const applyGitChangeDecorations = useCallback(() => {
    const editorInstance = editorRef.current
    if (!editorInstance) return

    const { added, modified, deleted } = gitGutterLineMarkers

    if (
      !isFileTab ||
      (added.length === 0 && modified.length === 0 && deleted.length === 0)
    ) {
      gitChangeDecorationsRef.current = editorInstance.deltaDecorations(
        gitChangeDecorationsRef.current,
        []
      )
      return
    }

    const model = editorInstance.getModel()
    if (!model) return

    const maxLine = model.getLineCount()
    const toRange = (lineNumber: number) => ({
      startLineNumber: lineNumber,
      startColumn: 1,
      endLineNumber: lineNumber,
      endColumn: 1,
    })
    const addedDecorations = added
      .filter((lineNumber) => lineNumber >= 1 && lineNumber <= maxLine)
      .map((lineNumber) => ({
        range: toRange(lineNumber),
        options: {
          isWholeLine: true,
          linesDecorationsClassName:
            "codeg-dirty-diff-glyph codeg-dirty-diff-added",
        },
      }))
    const modifiedDecorations = modified
      .filter((lineNumber) => lineNumber >= 1 && lineNumber <= maxLine)
      .map((lineNumber) => ({
        range: toRange(lineNumber),
        options: {
          isWholeLine: true,
          linesDecorationsClassName:
            "codeg-dirty-diff-glyph codeg-dirty-diff-modified",
        },
      }))
    const deletedDecorations = deleted
      .filter((lineNumber) => lineNumber >= 1 && lineNumber <= maxLine)
      .map((lineNumber) => ({
        range: {
          startLineNumber: lineNumber,
          startColumn: Number.MAX_VALUE,
          endLineNumber: lineNumber,
          endColumn: Number.MAX_VALUE,
        },
        options: {
          isWholeLine: false,
          linesDecorationsClassName:
            "codeg-dirty-diff-glyph codeg-dirty-diff-deleted",
        },
      }))
    const decorations = [
      ...addedDecorations,
      ...modifiedDecorations,
      ...deletedDecorations,
    ]

    gitChangeDecorationsRef.current = editorInstance.deltaDecorations(
      gitChangeDecorationsRef.current,
      decorations
    )
  }, [gitGutterLineMarkers, isFileTab])

  const applyHiddenAreas = useCallback(() => {
    const editorInstance = editorRef.current
    if (!editorInstance) return

    if (!diffOutline || diffListContext) {
      setEditorHiddenAreas(editorInstance, [])
      return
    }

    const model = editorInstance.getModel()
    if (!model) return

    const maxLine = model.getLineCount()
    const ranges: {
      startLineNumber: number
      startColumn: number
      endLineNumber: number
      endColumn: number
    }[] = []

    const addRange = (startLine: number, endLine: number) => {
      const safeStart = Math.max(1, startLine)
      const safeEnd = Math.min(maxLine, endLine)
      if (safeStart > safeEnd) return

      ranges.push({
        startLineNumber: safeStart,
        startColumn: 1,
        endLineNumber: safeEnd,
        endColumn: 1,
      })
    }

    for (const file of diffOutline.files) {
      const fileCollapsed = Boolean(
        collapsedFiles[`${activeScope}:${file.key}`]
      )
      if (fileCollapsed) {
        addRange(file.startLine + 1, file.endLine)
        continue
      }

      for (const hunk of file.hunks) {
        if (!collapsedHunks[`${activeScope}:${hunk.key}`]) continue
        addRange(hunk.startLine + 1, hunk.endLine)
      }
    }

    setEditorHiddenAreas(editorInstance, ranges)
  }, [
    activeScope,
    collapsedFiles,
    collapsedHunks,
    diffListContext,
    diffOutline,
  ])

  const handleEditorMount: OnMount = useCallback(
    (editorInstance, monaco) => {
      editorRef.current = editorInstance
      setEditorMonaco(monaco)
      bindImeEditor(editorInstance)
      cursorListenerRef.current?.dispose()
      cursorListenerRef.current = editorInstance.onDidChangeCursorPosition(
        (event) => {
          setCursorLine(event.position.lineNumber)
        }
      )
      setEditorMountVersion((prev) => prev + 1)
      setCursorLine(editorInstance.getPosition()?.lineNumber ?? 1)
      applyHiddenAreas()
      applyGitChangeDecorations()

      // --- "Add selection to chat": context-menu action, ⌘L shortcut, and the
      // floating pill. All three are gated by the `codegSelectionAttachable`
      // context key so they only appear for a real file tab with an active
      // conversation to attach to.
      const attachableKey = editorInstance.createContextKey<boolean>(
        "codegSelectionAttachable",
        false
      )
      attachableKeyRef.current = attachableKey
      attachableKey.set(attachableRef.current)

      monacoRef.current = monaco
      registerAddToChatActions(
        editorInstance,
        monaco,
        tRef.current("addSelectionToChat"),
        tRef.current("addFileToChat")
      )

      // Alt+Z toggles the (global, persisted) word-wrap preference — mirrors VS
      // Code's "View: Toggle Word Wrap". `wordWrap` is a controlled option, so
      // flipping the preference re-renders and applies the change.
      registerWordWrapAction(
        editorInstance,
        monaco,
        tRef.current("toggleWordWrap")
      )

      const pill = createAddToChatPill(
        editorInstance,
        monaco,
        () => addSelectionToChat(),
        () => tRef.current("addToChat")
      )
      addToChatPillRef.current = pill
      editorInstance.addContentWidget(pill.widget)

      // The single way to lay the pill out. Monaco reads `getPosition()` — and
      // so decides the placement — while the node is still `display: none`, and
      // only flips it to `block` inside this same call, so this is the first
      // moment the pill can be measured. Whenever that lands a height we did
      // not have (the first-ever show, or a zoom that resized the pill), redo
      // the layout in the same frame with the real box.
      const layoutPill = () => {
        editorInstance.layoutContentWidget(pill.widget)
        if (pill.remeasure()) editorInstance.layoutContentWidget(pill.widget)
      }

      const refreshPill = () => {
        const selection = editorInstance.getSelection()
        const show =
          attachableRef.current &&
          editorInstance.hasTextFocus() &&
          Boolean(selection) &&
          !selection?.isEmpty()
        pill.setVisible(
          show,
          show && selection ? selection.getStartPosition() : null
        )
        layoutPill()
      }
      selectionListenerRef.current?.dispose()
      selectionListenerRef.current =
        editorInstance.onDidChangeCursorSelection(refreshPill)
      focusListenerRef.current?.dispose()
      focusListenerRef.current =
        editorInstance.onDidFocusEditorText(refreshPill)
      blurListenerRef.current?.dispose()
      blurListenerRef.current = editorInstance.onDidBlurEditorText(() => {
        pill.setVisible(false, null)
        layoutPill()
      })
      // Monaco latches a widget's placement preference when the widget is laid
      // out and re-uses it for every later render, so a visible pill keeps a
      // stale above/below choice until something lays it out again. Every input
      // to that choice can change while the pill sits on screen: the room above
      // the anchor (vertical scroll), the viewport height (the user dragging
      // the terminal splitter up), and the pill's own height (zoom, which
      // scales the rem-based pill and the editor font together). Refresh on
      // each — a layout change covers zoom, because the panel feeds the zoomed
      // font size to Monaco as an option. Nothing in the decision depends on
      // the horizontal offset, so `scrollLeft`-only ticks are skipped.
      const relayoutPill = () => {
        if (pill.isVisible()) layoutPill()
      }
      scrollListenerRef.current?.dispose()
      scrollListenerRef.current = editorInstance.onDidScrollChange((event) => {
        if (event.scrollTopChanged) relayoutPill()
      })
      layoutListenerRef.current?.dispose()
      layoutListenerRef.current = editorInstance.onDidLayoutChange(relayoutPill)

      editorInstance.onDidDispose(() => teardownAddToChat(editorInstance))

      // Set CSS custom properties so hover tooltips can use position:fixed
      // to escape overflow:hidden clipping on ancestor elements.
      const dom = editorInstance.getContainerDomNode()
      if (dom) {
        const syncOffset = () => {
          const r = dom.getBoundingClientRect()
          dom.style.setProperty("--cv-offset-x", `${r.left}px`)
          dom.style.setProperty("--cv-offset-y", `${r.top}px`)
        }
        syncOffset()
        const ro = new ResizeObserver(syncOffset)
        ro.observe(dom)
        editorInstance.onDidDispose(() => ro.disconnect())
      }
    },
    [
      addSelectionToChat,
      registerAddToChatActions,
      registerWordWrapAction,
      teardownAddToChat,
      applyGitChangeDecorations,
      applyHiddenAreas,
      bindImeEditor,
    ]
  )

  const jumpToLine = useCallback((lineNumber: number) => {
    const editorInstance = editorRef.current
    if (!editorInstance) return false

    const model = editorInstance.getModel()
    if (!model) return false
    const maxLine = model.getLineCount()
    const targetLine = Math.min(Math.max(1, lineNumber), maxLine)

    editorInstance.revealLineInCenter(targetLine)
    editorInstance.setPosition({ lineNumber: targetLine, column: 1 })
    editorInstance.focus()
    return true
  }, [])

  const jumpToHunk = useCallback(
    (hunkIndex: number) => {
      const hunk = allHunks[hunkIndex]
      if (!hunk) return
      jumpToLine(hunk.startLine)
    },
    [allHunks, jumpToLine]
  )

  const handlePrevHunk = useCallback(() => {
    if (allHunks.length === 0) return
    if (activeHunkIndex <= 0) return
    jumpToHunk(activeHunkIndex - 1)
  }, [activeHunkIndex, allHunks.length, jumpToHunk])

  const handleNextHunk = useCallback(() => {
    if (allHunks.length === 0) return
    if (activeHunkIndex >= allHunks.length - 1) return
    jumpToHunk(activeHunkIndex + 1)
  }, [activeHunkIndex, allHunks.length, jumpToHunk])

  const toggleFileCollapsed = useCallback(
    (fileKey: string) => {
      setCollapsedFiles((prev) => {
        const scopedKey = `${activeScope}:${fileKey}`
        return {
          ...prev,
          [scopedKey]: !prev[scopedKey],
        }
      })
    },
    [activeScope]
  )

  const toggleHunkCollapsed = useCallback(
    (hunkKey: string) => {
      setCollapsedHunks((prev) => {
        const scopedKey = `${activeScope}:${hunkKey}`
        return {
          ...prev,
          [scopedKey]: !prev[scopedKey],
        }
      })
    },
    [activeScope]
  )

  useEffect(() => {
    applyHiddenAreas()
  }, [applyHiddenAreas])

  useEffect(() => {
    applyGitChangeDecorations()
  }, [activeFileTab?.id, applyGitChangeDecorations])

  useEffect(() => {
    if (!pendingFileReveal) return
    if (!isFileTab || !activeFileTab || activeFileTab.loading) return
    if (!activeFileTab.path) return
    // The absolute path IS the tab identity — only reveal in the tab the
    // request actually targeted.
    if (
      normalizeWorkspacePath(activeFileTab.path) !==
      normalizeWorkspacePath(pendingFileReveal.path)
    ) {
      return
    }

    const jumped = jumpToLine(pendingFileReveal.line)
    if (!jumped) return

    consumePendingFileReveal(pendingFileReveal.requestId)
  }, [
    activeFileTab,
    consumePendingFileReveal,
    editorMountVersion,
    isFileTab,
    jumpToLine,
    pendingFileReveal,
  ])

  useEffect(() => {
    autoSaveGuardRef.current = {
      canEdit,
      fileIsDirty,
      fileSaveState,
    }
  }, [canEdit, fileIsDirty, fileSaveState])

  useEffect(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
    }

    if (!canEdit || !fileIsDirty || fileSaveState !== "idle" || isComposing) {
      return
    }

    autoSaveTimerRef.current = setTimeout(() => {
      const guard = autoSaveGuardRef.current
      if (
        !guard.canEdit ||
        !guard.fileIsDirty ||
        guard.fileSaveState !== "idle"
      ) {
        return
      }
      void saveActiveFile()
    }, AUTO_SAVE_DELAY_MS)

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
        autoSaveTimerRef.current = null
      }
    }
  }, [
    canEdit,
    fileIsDirty,
    fileSaveState,
    isComposing,
    saveActiveFile,
    renderedContent,
  ])

  useEffect(() => {
    if (!isFileTab) return

    const saveOnDeactivation = () => {
      const guard = autoSaveGuardRef.current
      if (
        !guard.canEdit ||
        !guard.fileIsDirty ||
        guard.fileSaveState === "saving"
      ) {
        return
      }
      void saveActiveFile()
    }

    const onWindowBlur = () => {
      saveOnDeactivation()
    }

    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") return
      saveOnDeactivation()
    }

    window.addEventListener("blur", onWindowBlur)
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      window.removeEventListener("blur", onWindowBlur)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [isFileTab, saveActiveFile])

  useEffect(() => {
    if (!isFileTab) return

    const onKeyDown = (event: KeyboardEvent) => {
      const isSaveShortcut =
        (event.metaKey || event.ctrlKey) && event.key === "s"
      if (!isSaveShortcut) return
      event.preventDefault()
      if (!canEdit) return
      void saveActiveFile()
    }

    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [canEdit, isFileTab, saveActiveFile])

  useEffect(
    () => () => {
      if (editorRef.current) {
        editorRef.current.deltaDecorations(gitChangeDecorationsRef.current, [])
      }
      gitChangeDecorationsRef.current = []
      cursorListenerRef.current?.dispose()
      cursorListenerRef.current = null
      // Full add-to-chat teardown (action, listeners, pill widget, context key)
      // in case React unmounts the panel before the editor's own onDidDispose.
      teardownAddToChat()
    },
    [teardownAddToChat]
  )

  if (!activeFileTab) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6">
        <FileCode2 className="h-8 w-8 text-muted-foreground/60 mb-3" />
        <p className="text-sm text-muted-foreground">{t("openFileOrDiff")}</p>
      </div>
    )
  }

  if (activeFileTab.kind === "browser") {
    // Keyed by tab so switching between two browser tabs remounts the surface
    // host (which hides the old webview and shows the new one).
    return <BrowserTabView key={activeFileTab.id} tab={activeFileTab} />
  }

  if (activeFileTab.kind === "rich-diff") {
    const richDiffParts = parseFileTabId(activeFileTab.id)
    const isCommitDiff = richDiffParts?.kind === "diff-commit"
    const isExternalConflictDiff =
      richDiffParts?.kind === "diff-external-conflict"
    const commitHash =
      richDiffParts?.kind === "diff-commit"
        ? richDiffParts.commit.slice(0, 7)
        : ""
    // A branch comparison's before side is that branch, not HEAD — naming it
    // "HEAD" put someone else's bytes under this branch's name.
    const compareBranch =
      richDiffParts?.kind === "diff-branch" ? richDiffParts.branch : null
    const origLabel = isCommitDiff
      ? `${commitHash}~1`
      : isExternalConflictDiff
        ? t("disk")
        : (compareBranch ?? t("head"))
    const modLabel = isCommitDiff
      ? commitHash
      : isExternalConflictDiff
        ? t("unsaved")
        : t("workingTree")

    const richDiffColdLoad =
      activeFileTab.loading && !hasTabContent(activeFileTab)
    return (
      <div className="h-full relative">
        {activeFileTab.loading && (
          <div className="absolute top-2 right-3 z-10 rounded-md bg-background/70 px-2 py-1 text-2xs text-muted-foreground backdrop-blur-sm">
            {t("loading")}
          </div>
        )}
        {richDiffColdLoad ? (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
            {t("loading")}
          </div>
        ) : activeFileTab.language === "image" ? (
          // Binary image: the loader put bytes on the tab, not text.
          activeFileTab.imageDiff ? (
            <ImageDiffView
              key={activeFileTab.id}
              original={activeFileTab.imageDiff.original}
              modified={activeFileTab.imageDiff.modified}
              originalLabel={origLabel}
              modifiedLabel={modLabel}
              loading={activeFileTab.loading}
              className="h-full"
            />
          ) : (
            // A settled image tab with no sides is a load that failed (a
            // timeout, say) — `rejectTab` left the reason in `content`. Showing
            // two empty panes instead would dress the failure up as a file
            // that simply has nothing on either side.
            <div className="h-full flex items-center justify-center px-6 text-center text-xs text-muted-foreground">
              {activeFileTab.content || t("loading")}
            </div>
          )
        ) : (
          <DiffViewer
            key={activeFileTab.id}
            original={activeFileTab.originalContent ?? ""}
            modified={activeFileTab.modifiedContent ?? ""}
            originalLabel={origLabel}
            modifiedLabel={modLabel}
            language={activeFileTab.language}
            className="h-full"
          />
        )}
      </div>
    )
  }

  if (
    activeFileTab.kind === "diff" &&
    activeFileTab.id.startsWith("diff:session:")
  ) {
    const sessionDiffColdLoad =
      activeFileTab.loading && !hasTabContent(activeFileTab)
    return (
      <div className="h-full relative">
        {activeFileTab.loading && (
          <div className="absolute top-2 right-3 z-10 rounded-md bg-background/70 px-2 py-1 text-2xs text-muted-foreground backdrop-blur-sm">
            {t("loading")}
          </div>
        )}
        {sessionDiffColdLoad ? (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
            {t("loading")}
          </div>
        ) : (
          <UnifiedDiffPreview
            diffText={activeFileTab.content}
            className="h-full p-3"
          />
        )}
      </div>
    )
  }

  // Preview mode for markdown files
  const isPreviewMode =
    isFileTab &&
    activeFileTab &&
    previewFileTabIds.has(activeFileTab.id) &&
    activeFileTab.language === "markdown"

  // Diff overview list view (commit / directory)
  if (diffListContext && diffOutline) {
    const badge =
      diffListContext.kind === "commit"
        ? diffListContext.commitHash.slice(0, 7)
        : diffListContext.kind === "branch"
          ? diffListContext.branch
          : t("workingTree")

    const description =
      diffListContext.kind === "commit"
        ? diffListContext.commitMessage
        : diffListContext.kind === "branch"
          ? t("compareWithBranch", {
              path: diffListContext.path,
              branch: diffListContext.branch,
            })
          : (activeFileTab.description ?? diffListContext.path)

    // Per-file diffs opened from an overview belong to the overview tab's
    // folder — pass it explicitly so a background-folder overview never
    // routes its rows through the active folder. (Diff tabs always carry a
    // numeric folderId; the ?? undefined only satisfies the option type.)
    const overviewFolderId = activeFileTab.folderId ?? undefined
    const handleOpenDiff = async (path: string) => {
      if (diffListContext.kind === "commit") {
        await openCommitDiff(diffListContext.commitHash, path, undefined, {
          folderId: overviewFolderId,
        })
        return
      }

      if (diffListContext.kind === "branch") {
        await openBranchDiff(diffListContext.branch, path, {
          folderId: overviewFolderId,
        })
        return
      }

      await openWorkingTreeDiff(path, { folderId: overviewFolderId })
    }

    const diffListColdLoad =
      activeFileTab.loading && !hasTabContent(activeFileTab)
    return (
      <div className="h-full relative">
        {activeFileTab.loading && (
          <div className="absolute top-2 right-3 z-10 rounded-md bg-background/70 px-2 py-1 text-2xs text-muted-foreground backdrop-blur-sm">
            {t("loading")}
          </div>
        )}
        {diffListColdLoad ? (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
            {t("loading")}
          </div>
        ) : (
          <DiffFileList
            diffOutline={diffOutline}
            badge={badge}
            description={description}
            onOpenDiff={handleOpenDiff}
            openFilePreview={(path) =>
              // Rows belong to the overview tab's folder — never the
              // active workspace folder.
              openFilePreview(path, { folderId: overviewFolderId })
            }
          />
        )}
      </div>
    )
  }

  // Image preview
  if (isFileTab && activeFileTab && activeFileTab.language === "image") {
    return <ImagePreview key={activeFileTab.id} tab={activeFileTab} />
  }

  // Office preview (.docx/.xlsx/.pptx → OfficeCLI HTML → sandboxed iframe).
  // Preview-only: these are binary OpenXML files with no text editor view, so
  // it renders unconditionally (not gated on the editor/preview toggle).
  if (isFileTab && activeFileTab && isOfficePreviewable(activeFileTab.path)) {
    return (
      <OfficePreview
        key={activeFileTab.id}
        rootPath={activeIo?.rootPath ?? null}
        relPath={activeIo?.ioPath ?? null}
      />
    )
  }

  // HTML preview (sandboxed iframe)
  if (
    isFileTab &&
    activeFileTab &&
    previewFileTabIds.has(activeFileTab.id) &&
    isHtmlPreviewable(activeFileTab.path)
  ) {
    return (
      <HtmlPreview
        key={activeFileTab.id}
        tab={activeFileTab}
        rootPath={previewRoot}
        // The file column already has a header of its own (FileWorkspaceHeader,
        // directly above this panel): the preview's controls go there rather
        // than into a second strip under it.
        chrome="hoisted"
      />
    )
  }

  if (isPreviewMode && activeFileTab) {
    const markdownColdLoad =
      activeFileTab.loading && !hasTabContent(activeFileTab)
    return (
      <div className="h-full relative">
        {activeFileTab.loading && (
          <div className="absolute top-2 right-3 z-10 rounded-md bg-background/70 px-2 py-1 text-2xs text-muted-foreground backdrop-blur-sm">
            {t("loading")}
          </div>
        )}
        {markdownColdLoad ? (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
            {t("loading")}
          </div>
        ) : (
          <MarkdownDocumentPreview
            content={renderedContent}
            // The tab path is absolute, so the document directory is too —
            // every local reference resolves to an absolute filesystem path.
            fileDir={activeIo?.rootPath ?? null}
            previewRoot={previewRoot}
            openFilePreview={openFilePreview}
          />
        )}
      </div>
    )
  }

  return (
    <div className="h-full relative">
      {activeFileTab.loading && (
        <div className="absolute top-2 right-3 z-10 rounded-md bg-background/70 px-2 py-1 text-2xs text-muted-foreground backdrop-blur-sm">
          {t("loading")}
        </div>
      )}
      <div className="h-full flex flex-col min-h-0">
        {diffOutline && (
          <div className="border-b border-border bg-muted/25">
            <div className="px-3 py-1.5 text-2xs text-muted-foreground flex items-center gap-3">
              <span>{t("fileCount", { count: diffOutline.files.length })}</span>
              <span className="font-mono text-green-600 dark:text-green-400">
                +{diffOutline.totalAdditions}
              </span>
              <span className="font-mono text-red-600 dark:text-red-400">
                -{diffOutline.totalDeletions}
              </span>
              {diffOutline.totalHunks > 0 && (
                <span>{t("hunkCount", { count: diffOutline.totalHunks })}</span>
              )}
              {allHunks.length > 0 && (
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={handlePrevHunk}
                    disabled={activeHunkIndex <= 0}
                    className="rounded border border-border bg-background px-2 py-0.5 text-3xs disabled:opacity-40 hover:bg-muted transition-colors inline-flex items-center gap-1"
                  >
                    <ChevronRight className="h-3 w-3 rotate-180" />
                    {t("prev")}
                  </button>
                  <button
                    type="button"
                    onClick={handleNextHunk}
                    disabled={
                      activeHunkIndex < 0 ||
                      activeHunkIndex >= allHunks.length - 1
                    }
                    className="rounded border border-border bg-background px-2 py-0.5 text-3xs disabled:opacity-40 hover:bg-muted transition-colors inline-flex items-center gap-1"
                  >
                    {t("next")}
                    <ChevronRight className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>
            <div className="px-2 pb-2 space-y-1 max-h-52 overflow-y-auto">
              {diffOutline.files.map((file) => {
                const fileCollapsed = Boolean(
                  collapsedFiles[`${activeScope}:${file.key}`]
                )
                return (
                  <div
                    key={file.key}
                    className="rounded-md border border-border/80 bg-background/80"
                  >
                    <button
                      type="button"
                      onClick={() => toggleFileCollapsed(file.key)}
                      className="w-full px-2 py-1.5 text-2xs flex items-center gap-1 hover:bg-muted/60 transition-colors"
                    >
                      <ChevronRight
                        className={`h-3 w-3 shrink-0 transition-transform ${
                          fileCollapsed ? "" : "rotate-90"
                        }`}
                      />
                      <span
                        className="font-mono text-left truncate"
                        title={file.path}
                        onClick={(event) => {
                          event.stopPropagation()
                          jumpToLine(file.startLine)
                        }}
                      >
                        {file.path}
                      </span>
                      <span className="ml-auto shrink-0 flex items-center gap-2 text-3xs">
                        <span className="font-mono text-green-600 dark:text-green-400">
                          +{file.additions}
                        </span>
                        <span className="font-mono text-red-600 dark:text-red-400">
                          -{file.deletions}
                        </span>
                        <span>{file.hunks.length}h</span>
                      </span>
                    </button>
                    {!fileCollapsed && file.hunks.length > 0 && (
                      <div className="px-2 pb-2 space-y-1">
                        {file.hunks.map((hunk) => {
                          const hunkCollapsed = Boolean(
                            collapsedHunks[`${activeScope}:${hunk.key}`]
                          )
                          const isActive =
                            activeHunkIndex >= 0 &&
                            allHunks[activeHunkIndex]?.key === hunk.key

                          return (
                            <div
                              key={hunk.key}
                              className={`flex items-center gap-1 rounded border px-1.5 py-1 text-3xs ${
                                isActive
                                  ? "border-primary/50 bg-primary/10"
                                  : "border-border/70 bg-muted/30"
                              }`}
                            >
                              <button
                                type="button"
                                onClick={() => toggleHunkCollapsed(hunk.key)}
                                className="inline-flex items-center gap-1 min-w-0 flex-1 text-left hover:opacity-80"
                                title={hunk.header}
                              >
                                <ChevronDown
                                  className={`h-3 w-3 shrink-0 transition-transform ${
                                    hunkCollapsed ? "-rotate-90" : ""
                                  }`}
                                />
                                <span className="font-mono truncate">
                                  {hunk.header}
                                </span>
                              </button>
                              <button
                                type="button"
                                onClick={() => jumpToLine(hunk.startLine)}
                                className="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 hover:bg-muted transition-colors"
                                title={t("jumpToLine", {
                                  line: hunk.startLine,
                                })}
                              >
                                L{hunk.startLine}
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
              {diffOutline.files.length === 0 && (
                <div className="text-2xs text-muted-foreground px-1 py-0.5">
                  {t("noParsedDiffSections")}
                </div>
              )}
            </div>
          </div>
        )}
        <div className="flex-1 min-h-0">
          {hasTabContent(activeFileTab) || !activeFileTab.loading ? (
            <MonacoEditor
              beforeMount={defineMonacoThemes}
              onMount={handleEditorMount}
              path={editorModelPath}
              defaultValue={renderedContent}
              value={isFileTab ? imeSafeEditorValue : renderedContent}
              onChange={handleEditorChange}
              language={activeFileTab.language}
              theme={editorTheme}
              loading={
                <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                  {t("loadingEditor")}
                </div>
              }
              options={{
                // Lock the editor while a refresh is in flight. Otherwise
                // keystrokes that arrive during the refresh window survive
                // in Monaco's internal model but get clobbered by the
                // value-prop sync when the fetch resolves, silently
                // dropping user input.
                readOnly: !canEdit || activeFileTab.loading,
                minimap: { enabled: false },
                automaticLayout: true,
                fontSize: (editorFontSize * zoomLevel) / 100,
                fontFamily: editorFontStack,
                fontLigatures: editorLigatures,
                lineNumbersMinChars,
                lineDecorationsWidth: 10,
                wordWrap: editorWordWrap ? "on" : "off",
                scrollBeyondLastLine: false,
                scrollBeyondLastColumn: 8,
                renderLineHighlight: "line",
                unicodeHighlight: MONACO_UNICODE_HIGHLIGHT_OPTIONS,
                scrollbar: {
                  horizontal: "auto",
                },
              }}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
              {t("loadingEditor")}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
