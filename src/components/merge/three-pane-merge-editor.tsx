"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import dynamic from "next/dynamic"
import { useMonaco } from "@monaco-editor/react"
import type { OnMount } from "@monaco-editor/react"
import type { editor as MonacoEditorNs, IRange } from "monaco-editor"
import { ArrowLeft, ArrowRight, CheckCheck } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  defineMonacoThemes,
  MONACO_UNICODE_HIGHLIGHT_OPTIONS,
  useMonacoWorkspaceTheme,
} from "@/lib/monaco-themes"
import { useZoomLevel, useEditorFont } from "@/hooks/use-appearance"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import {
  computeLineDiff,
  computeMergeHunks,
  buildResult,
  type DiffHunk,
  type MergeHunk,
} from "./merge-diff"
import { useSyncScroll } from "./use-sync-scroll"

import "@/lib/monaco-local"

const MonacoEditor = dynamic(
  async () => {
    const mod = await import("@monaco-editor/react")
    return { default: mod.default }
  },
  { ssr: false }
)

interface ThreePaneMergeEditorProps {
  base: string
  ours: string
  theirs: string
  merged: string
  language?: string
  className?: string
  onContentChange?: (content: string) => void
  onConflictStatusChange?: (hasUnresolved: boolean) => void
}

export function ThreePaneMergeEditor({
  base,
  ours,
  theirs,
  language = "plaintext",
  className,
  onContentChange,
  onConflictStatusChange,
}: ThreePaneMergeEditorProps) {
  const t = useTranslations("MergePage")
  // Conditionally mounted (only when a merge is shown), so useMonaco() here is
  // already lazy — Monaco is loading for these editors anyway.
  const monaco = useMonaco()
  const editorTheme = useMonacoWorkspaceTheme(monaco)
  const { zoomLevel } = useZoomLevel()
  const { editorFontStack, editorFontSize, editorLigatures, editorWordWrap } =
    useEditorFont()
  const { registerEditor } = useSyncScroll()

  const leftEditorRef = useRef<MonacoEditorNs.IStandaloneCodeEditor | null>(
    null
  )
  const centerEditorRef = useRef<MonacoEditorNs.IStandaloneCodeEditor | null>(
    null
  )
  const rightEditorRef = useRef<MonacoEditorNs.IStandaloneCodeEditor | null>(
    null
  )

  // Decorations collections
  const leftDecorationsRef =
    useRef<MonacoEditorNs.IEditorDecorationsCollection | null>(null)
  const centerDecorationsRef =
    useRef<MonacoEditorNs.IEditorDecorationsCollection | null>(null)
  const rightDecorationsRef =
    useRef<MonacoEditorNs.IEditorDecorationsCollection | null>(null)

  // Scroll tick counter — incremented on every scroll to trigger gutter re-render
  const [scrollTick, setScrollTick] = useState(0)

  // Merge state
  const mergeHunks = useMemo(
    () => computeMergeHunks(base, ours, theirs),
    [base, ours, theirs]
  )

  // Track which hunks have been applied and which side was chosen
  const [appliedHunks, setAppliedHunks] = useState<
    Map<string, "left" | "right">
  >(new Map())

  // Track ignored hunks
  const [ignoredHunks, setIgnoredHunks] = useState<Set<string>>(new Set())

  const onContentChangeRef = useRef(onContentChange)
  const onConflictStatusChangeRef = useRef(onConflictStatusChange)

  useEffect(() => {
    onContentChangeRef.current = onContentChange
  }, [onContentChange])

  useEffect(() => {
    onConflictStatusChangeRef.current = onConflictStatusChange
  }, [onConflictStatusChange])

  // Compute diffs for left/right pane decorations
  const baseLines = useMemo(() => base.split("\n"), [base])
  const leftDiffs = useMemo(
    () => computeLineDiff(baseLines, ours.split("\n")),
    [baseLines, ours]
  )
  const rightDiffs = useMemo(
    () => computeLineDiff(baseLines, theirs.split("\n")),
    [baseLines, theirs]
  )

  // Build the result content from base + applied hunks
  const resultContent = useMemo(
    () => buildResult(base, mergeHunks, appliedHunks),
    [base, mergeHunks, appliedHunks]
  )

  // Notify parent of content changes
  useEffect(() => {
    onContentChangeRef.current?.(resultContent)
  }, [resultContent])

  // Notify parent of conflict status
  useEffect(() => {
    const hasUnresolved = mergeHunks.some(
      (h) =>
        h.type === "conflict" &&
        !appliedHunks.has(h.id) &&
        !ignoredHunks.has(h.id)
    )
    onConflictStatusChangeRef.current?.(hasUnresolved)
  }, [mergeHunks, appliedHunks, ignoredHunks])

  // Apply hunk handler
  const applyHunk = useCallback((id: string, side: "left" | "right") => {
    setAppliedHunks((prev) => {
      const next = new Map(prev)
      next.set(id, side)
      return next
    })
    setIgnoredHunks((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  // Sync center editor content when result changes
  useEffect(() => {
    const editor = centerEditorRef.current
    if (!editor) return
    const currentValue = editor.getValue()
    if (currentValue !== resultContent) {
      const pos = editor.getPosition()
      editor.setValue(resultContent)
      if (pos) editor.setPosition(pos)
    }
  }, [resultContent])

  // ---------------------------------------------------------------------------
  // Decorations for left (ours) pane
  // ---------------------------------------------------------------------------
  const applyLeftDecorations = useCallback(
    (editor: MonacoEditorNs.IStandaloneCodeEditor) => {
      const decorations: MonacoEditorNs.IModelDeltaDecoration[] = []
      const oursLines = ours.split("\n")

      for (const hunk of leftDiffs) {
        const range = hunkToEditorRange(hunk, leftDiffs, oursLines.length)
        if (!range) continue

        const cssClass =
          hunk.baseCount === 0
            ? "merge-hunk-added-bg"
            : hunk.newLines.length === 0
              ? "merge-hunk-removed-bg"
              : "merge-hunk-modified-bg"

        decorations.push({
          range,
          options: { isWholeLine: true, className: cssClass },
        })
      }

      if (leftDecorationsRef.current) {
        leftDecorationsRef.current.set(decorations)
      } else {
        leftDecorationsRef.current =
          editor.createDecorationsCollection(decorations)
      }
    },
    [leftDiffs, ours]
  )

  // ---------------------------------------------------------------------------
  // Decorations for right (theirs) pane
  // ---------------------------------------------------------------------------
  const applyRightDecorations = useCallback(
    (editor: MonacoEditorNs.IStandaloneCodeEditor) => {
      const decorations: MonacoEditorNs.IModelDeltaDecoration[] = []
      const theirsLines = theirs.split("\n")

      for (const hunk of rightDiffs) {
        const range = hunkToEditorRange(hunk, rightDiffs, theirsLines.length)
        if (!range) continue

        const cssClass =
          hunk.baseCount === 0
            ? "merge-hunk-added-bg"
            : hunk.newLines.length === 0
              ? "merge-hunk-removed-bg"
              : "merge-hunk-modified-bg"

        decorations.push({
          range,
          options: { isWholeLine: true, className: cssClass },
        })
      }

      if (rightDecorationsRef.current) {
        rightDecorationsRef.current.set(decorations)
      } else {
        rightDecorationsRef.current =
          editor.createDecorationsCollection(decorations)
      }
    },
    [rightDiffs, theirs]
  )

  // ---------------------------------------------------------------------------
  // Decorations for center (result) pane
  // ---------------------------------------------------------------------------
  const applyCenterDecorations = useCallback(
    (editor: MonacoEditorNs.IStandaloneCodeEditor) => {
      const decorations: MonacoEditorNs.IModelDeltaDecoration[] = []
      const currentLines = resultContent.split("\n")

      let resultOffset = 0
      const sortedHunks = [...mergeHunks].sort(
        (a, b) => a.baseStart - b.baseStart
      )
      let lastBaseEnd = 0

      for (const hunk of sortedHunks) {
        resultOffset += hunk.baseStart - lastBaseEnd

        const isApplied = appliedHunks.has(hunk.id)
        const isIgnored = ignoredHunks.has(hunk.id)

        let lineCount: number
        if (isApplied) {
          const side = appliedHunks.get(hunk.id)!
          const diffHunk = side === "left" ? hunk.leftHunk : hunk.rightHunk
          lineCount = diffHunk ? diffHunk.newLines.length : 0
        } else {
          lineCount = hunk.baseCount
        }

        if (lineCount > 0) {
          const startLine = resultOffset + 1
          const endLine = resultOffset + lineCount

          let cssClass: string
          if (isApplied) {
            cssClass = "merge-hunk-applied-bg"
          } else if (isIgnored) {
            cssClass = ""
          } else if (hunk.type === "conflict") {
            cssClass = "merge-hunk-conflict-bg"
          } else {
            cssClass = "merge-hunk-pending-bg"
          }

          if (cssClass) {
            decorations.push({
              range: {
                startLineNumber: startLine,
                startColumn: 1,
                endLineNumber: Math.min(endLine, currentLines.length),
                endColumn: 1,
              },
              options: { isWholeLine: true, className: cssClass },
            })
          }
        }

        resultOffset += lineCount
        lastBaseEnd = hunk.baseStart + hunk.baseCount
      }

      if (centerDecorationsRef.current) {
        centerDecorationsRef.current.set(decorations)
      } else {
        centerDecorationsRef.current =
          editor.createDecorationsCollection(decorations)
      }
    },
    [mergeHunks, appliedHunks, ignoredHunks, resultContent]
  )

  // ---------------------------------------------------------------------------
  // Apply decorations when state changes
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (leftEditorRef.current) {
      applyLeftDecorations(leftEditorRef.current)
    }
  }, [applyLeftDecorations])

  useEffect(() => {
    if (centerEditorRef.current) {
      applyCenterDecorations(centerEditorRef.current)
    }
  }, [applyCenterDecorations])

  useEffect(() => {
    if (rightEditorRef.current) {
      applyRightDecorations(rightEditorRef.current)
    }
  }, [applyRightDecorations])

  // ---------------------------------------------------------------------------
  // Editor mount handlers
  // ---------------------------------------------------------------------------
  const handleLeftMount: OnMount = useCallback(
    (editor) => {
      leftEditorRef.current = editor
      registerEditor(editor, 0)
      applyLeftDecorations(editor)

      // Also listen to left editor scroll to update gutter
      editor.onDidScrollChange(() => {
        setScrollTick((n) => n + 1)
      })

      // Trigger initial gutter render after editor is ready
      requestAnimationFrame(() => {
        setScrollTick((n) => n + 1)
      })
    },
    [registerEditor, applyLeftDecorations]
  )

  const handleCenterMount: OnMount = useCallback(
    (editor) => {
      centerEditorRef.current = editor
      registerEditor(editor, 1)
      applyCenterDecorations(editor)

      editor.onDidChangeModelContent(() => {
        const value = editor.getValue()
        onContentChangeRef.current?.(value)
      })
    },
    [registerEditor, applyCenterDecorations]
  )

  const handleRightMount: OnMount = useCallback(
    (editor) => {
      rightEditorRef.current = editor
      registerEditor(editor, 2)
      applyRightDecorations(editor)

      // Also listen to right editor scroll to update gutter
      editor.onDidScrollChange(() => {
        setScrollTick((n) => n + 1)
      })

      // Trigger initial gutter render after editor is ready
      requestAnimationFrame(() => {
        setScrollTick((n) => n + 1)
      })
    },
    [registerEditor, applyRightDecorations]
  )

  // ---------------------------------------------------------------------------
  // Compute gutter arrow items (line numbers only, positions computed at render)
  // ---------------------------------------------------------------------------
  const leftGutterItems = useMemo(() => {
    const oursLines = ours.split("\n")
    const items: Array<{
      hunk: MergeHunk
      lineNumber: number
    }> = []

    for (const hunk of mergeHunks) {
      if (!hunk.leftHunk) continue
      if (appliedHunks.has(hunk.id) || ignoredHunks.has(hunk.id)) continue

      const range = hunkToEditorRange(
        hunk.leftHunk,
        leftDiffs,
        oursLines.length
      )
      if (!range) continue

      items.push({ hunk, lineNumber: range.startLineNumber })
    }
    return items
  }, [mergeHunks, appliedHunks, ignoredHunks, leftDiffs, ours])

  const rightGutterItems = useMemo(() => {
    const theirsLines = theirs.split("\n")
    const items: Array<{
      hunk: MergeHunk
      lineNumber: number
    }> = []

    for (const hunk of mergeHunks) {
      if (!hunk.rightHunk) continue
      if (appliedHunks.has(hunk.id) || ignoredHunks.has(hunk.id)) continue

      const range = hunkToEditorRange(
        hunk.rightHunk,
        rightDiffs,
        theirsLines.length
      )
      if (!range) continue

      items.push({ hunk, lineNumber: range.startLineNumber })
    }
    return items
  }, [mergeHunks, appliedHunks, ignoredHunks, rightDiffs, theirs])

  // ---------------------------------------------------------------------------
  // Toolbar actions
  // ---------------------------------------------------------------------------
  const handleApplyAllNonConflicting = useCallback(() => {
    setAppliedHunks((prev) => {
      const next = new Map(prev)
      for (const hunk of mergeHunks) {
        if (hunk.type === "left-only" && hunk.leftHunk && !next.has(hunk.id)) {
          next.set(hunk.id, "left")
        } else if (
          hunk.type === "right-only" &&
          hunk.rightHunk &&
          !next.has(hunk.id)
        ) {
          next.set(hunk.id, "right")
        }
      }
      return next
    })
  }, [mergeHunks])

  const handleApplyLeftNonConflicting = useCallback(() => {
    setAppliedHunks((prev) => {
      const next = new Map(prev)
      for (const hunk of mergeHunks) {
        if (hunk.type === "left-only" && hunk.leftHunk && !next.has(hunk.id)) {
          next.set(hunk.id, "left")
        }
      }
      return next
    })
  }, [mergeHunks])

  const handleApplyRightNonConflicting = useCallback(() => {
    setAppliedHunks((prev) => {
      const next = new Map(prev)
      for (const hunk of mergeHunks) {
        if (
          hunk.type === "right-only" &&
          hunk.rightHunk &&
          !next.has(hunk.id)
        ) {
          next.set(hunk.id, "right")
        }
      }
      return next
    })
  }, [mergeHunks])

  // ---------------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------------
  const unresolvedConflicts = mergeHunks.filter(
    (h) =>
      h.type === "conflict" &&
      !appliedHunks.has(h.id) &&
      !ignoredHunks.has(h.id)
  ).length
  const pendingNonConflicts = mergeHunks.filter(
    (h) =>
      h.type !== "conflict" &&
      !appliedHunks.has(h.id) &&
      !ignoredHunks.has(h.id)
  ).length
  const totalChanges = mergeHunks.length

  // ---------------------------------------------------------------------------
  // Editor options
  // ---------------------------------------------------------------------------
  const editorOptions =
    useMemo<MonacoEditorNs.IStandaloneEditorConstructionOptions>(
      () => ({
        fontSize: (editorFontSize * zoomLevel) / 100,
        fontFamily: editorFontStack,
        fontLigatures: editorLigatures,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        lineNumbers: "on",
        glyphMargin: true,
        folding: false,
        wordWrap: editorWordWrap ? "on" : "off",
        overviewRulerLanes: 0,
        unicodeHighlight: MONACO_UNICODE_HIGHLIGHT_OPTIONS,
      }),
      [
        zoomLevel,
        editorFontStack,
        editorFontSize,
        editorLigatures,
        editorWordWrap,
      ]
    )

  const readonlyOptions = useMemo(
    () => ({
      ...editorOptions,
      readOnly: true,
      domReadOnly: true,
    }),
    [editorOptions]
  )

  const loadingEl = (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
      Loading editor...
    </div>
  )

  return (
    <div className={cn("flex h-full flex-col", className)}>
      {/* Header */}
      <div className="flex items-center border-b bg-muted/50 px-3 py-1.5">
        <div className="text-xs font-medium text-muted-foreground">
          {t("localVersion")}
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
          <div className="flex items-center gap-2 text-xs font-medium text-foreground">
            {t("result")}
            {unresolvedConflicts > 0 && (
              <span className="text-red-500">
                ({unresolvedConflicts}{" "}
                {unresolvedConflicts === 1 ? "conflict" : "conflicts"})
              </span>
            )}
            {pendingNonConflicts > 0 && (
              <span className="text-amber-500">
                ({pendingNonConflicts} pending)
              </span>
            )}
            {totalChanges > 0 &&
              unresolvedConflicts === 0 &&
              pendingNonConflicts === 0 && (
                <span className="text-green-500">
                  <CheckCheck className="inline h-3 w-3" />
                </span>
              )}
          </div>
          {pendingNonConflicts > 0 && (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                className="h-5 px-1.5 text-3xs"
                onClick={handleApplyLeftNonConflicting}
              >
                <ArrowRight className="mr-0.5 h-2.5 w-2.5" />
                {t("applyLeftNonConflicting")}
              </Button>
              <Button
                size="sm"
                className="h-5 px-1.5 text-3xs"
                onClick={handleApplyAllNonConflicting}
              >
                {t("applyAllNonConflicting")}
              </Button>
              <Button
                size="sm"
                className="h-5 px-1.5 text-3xs"
                onClick={handleApplyRightNonConflicting}
              >
                {t("applyRightNonConflicting")}
                <ArrowLeft className="ml-0.5 h-2.5 w-2.5" />
              </Button>
            </div>
          )}
        </div>
        <div className="text-xs font-medium text-muted-foreground">
          {t("remoteVersion")}
        </div>
      </div>

      {/* Three-panel layout: [left editor + gutter] | center editor | [gutter + right editor] */}
      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
        {/* Left: Ours (local) + arrow gutter */}
        <ResizablePanel defaultSize={34} minSize={15}>
          <div className="flex h-full">
            <div className="min-w-0 flex-1">
              <MonacoEditor
                value={ours}
                language={language}
                theme={editorTheme}
                beforeMount={defineMonacoThemes}
                onMount={handleLeftMount}
                loading={loadingEl}
                options={readonlyOptions}
              />
            </div>
            <ArrowGutter
              items={leftGutterItems}
              direction="right"
              editorRef={leftEditorRef}
              scrollTick={scrollTick}
              onApply={(id) => applyHunk(id, "left")}
              title={t("acceptLocal")}
            />
          </div>
        </ResizablePanel>

        <ResizableHandle />

        {/* Center: Result (editable) */}
        <ResizablePanel defaultSize={32} minSize={15}>
          <MonacoEditor
            defaultValue={base}
            language={language}
            theme={editorTheme}
            beforeMount={defineMonacoThemes}
            onMount={handleCenterMount}
            loading={loadingEl}
            options={editorOptions}
          />
        </ResizablePanel>

        <ResizableHandle />

        {/* Right: arrow gutter + Theirs (remote) */}
        <ResizablePanel defaultSize={34} minSize={15}>
          <div className="flex h-full">
            <ArrowGutter
              items={rightGutterItems}
              direction="left"
              editorRef={rightEditorRef}
              scrollTick={scrollTick}
              onApply={(id) => applyHunk(id, "right")}
              title={t("acceptRemote")}
            />
            <div className="min-w-0 flex-1">
              <MonacoEditor
                value={theirs}
                language={language}
                theme={editorTheme}
                beforeMount={defineMonacoThemes}
                onMount={handleRightMount}
                loading={loadingEl}
                options={readonlyOptions}
              />
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Arrow Gutter Component
// ---------------------------------------------------------------------------

interface ArrowGutterProps {
  items: Array<{ hunk: MergeHunk; lineNumber: number }>
  direction: "left" | "right"
  editorRef: React.RefObject<MonacoEditorNs.IStandaloneCodeEditor | null>
  scrollTick: number // triggers re-render on scroll
  onApply: (hunkId: string) => void
  title: string
}

function ArrowGutter({
  items,
  direction,
  editorRef,
  scrollTick,
  onApply,
  title,
}: ArrowGutterProps) {
  const editor = editorRef.current

  // Arrow positions come from the imperative Monaco editor's current scroll
  // state, read during render on purpose: the parent bumps `scrollTick` after
  // mount and on every scroll, which re-renders this gutter so the read is
  // never stale for more than the frame that caused it.
  /* eslint-disable react-hooks/refs -- positions are read from the editor instance; `scrollTick` drives re-renders */
  const positioned = useMemo(() => {
    if (!editor) return []
    return items
      .map(({ hunk, lineNumber }) => {
        const pos = editor.getScrolledVisiblePosition({
          lineNumber,
          column: 1,
        })
        return pos ? { hunk, top: pos.top } : null
      })
      .filter((item): item is { hunk: MergeHunk; top: number } => item !== null)
    // scrollTick is included to recompute on scroll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, items, scrollTick])
  /* eslint-enable react-hooks/refs */

  return (
    <div className="merge-gutter-column">
      {positioned.map(({ hunk, top }) => (
        <button
          key={hunk.id}
          type="button"
          className={cn(
            "merge-gutter-arrow-btn",
            hunk.type === "conflict"
              ? "merge-gutter-arrow-conflict"
              : "merge-gutter-arrow-accept"
          )}
          style={{ top: `${top}px` }}
          onClick={() => onApply(hunk.id)}
          title={title}
        >
          {direction === "right" ? "\u00BB" : "\u00AB"}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a DiffHunk to an editor range in the modified file,
 * accounting for offset from previous hunks.
 */
function hunkToEditorRange(
  hunk: DiffHunk,
  allHunks: DiffHunk[],
  totalLines: number
): IRange | null {
  let offset = 0
  for (const h of allHunks) {
    if (h.baseStart >= hunk.baseStart) break
    offset += h.newLines.length - h.baseCount
  }

  if (hunk.newLines.length > 0) {
    const start = hunk.baseStart + offset + 1
    const end = start + hunk.newLines.length - 1
    return {
      startLineNumber: start,
      startColumn: 1,
      endLineNumber: Math.min(end, totalLines),
      endColumn: 1,
    }
  } else if (hunk.baseCount > 0) {
    const line = Math.min(hunk.baseStart + offset + 1, totalLines)
    return {
      startLineNumber: line,
      startColumn: 1,
      endLineNumber: line,
      endColumn: 1,
    }
  }
  return null
}
