"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import dynamic from "next/dynamic"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { useMonaco } from "@monaco-editor/react"
import type { DiffOnMount } from "@monaco-editor/react"
import type { editor as MonacoEditorNs } from "monaco-editor"
import {
  defineMonacoThemes,
  MONACO_UNICODE_HIGHLIGHT_OPTIONS,
  useMonacoWorkspaceTheme,
} from "@/lib/monaco-themes"
import { useZoomLevel, useEditorFont } from "@/hooks/use-appearance"
import { cn } from "@/lib/utils"

import "@/lib/monaco-local"

const MonacoDiffEditor = dynamic(
  async () => {
    const mod = await import("@monaco-editor/react")
    return { default: mod.DiffEditor }
  },
  { ssr: false }
)

// Commit-synchronous on the client so the teardown below runs in the deletion
// commit — strictly before the library's passive unmount cleanup, whatever the
// parent/child effect order is; a no-op-safe passive effect during the
// static-export prerender where `useLayoutEffect` would warn.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect

export interface DiffViewerProps {
  original: string
  modified: string
  originalLabel?: string
  modifiedLabel?: string
  language?: string
  className?: string
}

export function DiffViewer({
  original,
  modified,
  originalLabel = "Original",
  modifiedLabel = "Modified",
  language = "plaintext",
  className,
}: DiffViewerProps) {
  // Conditionally mounted (only when a diff is shown), so useMonaco() here is
  // already lazy — Monaco is loading for this editor anyway.
  const monaco = useMonaco()
  const editorTheme = useMonacoWorkspaceTheme(monaco)
  const { zoomLevel } = useZoomLevel()
  const { editorFontStack, editorFontSize, editorLigatures, editorWordWrap } =
    useEditorFont()
  const diffEditorRef = useRef<MonacoEditorNs.IStandaloneDiffEditor | null>(
    null
  )
  const [diffChanges, setDiffChanges] = useState<MonacoEditorNs.ILineChange[]>(
    []
  )
  const [currentChangeIndex, setCurrentChangeIndex] = useState(-1)
  // Initial diff read, deferred because the first computation lands after
  // mount. Cancelled on unmount so it can never poke a disposed widget.
  const initialDiffReadRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleEditorMount: DiffOnMount = useCallback((editor) => {
    diffEditorRef.current = editor
    let scrolledToFirst = false

    const updateDiffs = () => {
      const changes = editor.getLineChanges()
      setDiffChanges(changes ?? [])
      if (changes && changes.length > 0) {
        setCurrentChangeIndex(0)
        // Auto-scroll to the first change only once
        if (!scrolledToFirst) {
          scrolledToFirst = true
          const first = changes[0]
          const lineNumber =
            first.modifiedStartLineNumber || first.originalStartLineNumber || 1
          const modifiedEditor = editor.getModifiedEditor()
          modifiedEditor.revealLineInCenter(lineNumber)
          modifiedEditor.setPosition({ lineNumber, column: 1 })
        }
      }
    }

    editor.onDidUpdateDiff(updateDiffs)
    initialDiffReadRef.current = setTimeout(updateDiffs, 300)
  }, [])

  // @monaco-editor/react tears the diff editor down in the wrong order on
  // unmount: it disposes both text models and only then the widget. Monaco
  // flags that as a self-check bug ("TextModel got disposed before
  // DiffEditorWidget model got reset") and its default handler rethrows it from
  // a timeout, i.e. an uncaught error in the dev overlay on every diff→file tab
  // switch or dialog close. Do the teardown first, correctly: detach the models
  // (which drops the widget's onWillDispose listeners), then dispose them —
  // nothing else in the app owns or tracks them, since no model path is passed
  // and Monaco hands out an anonymous URI per model. The library then reads a
  // null model and only disposes the widget.
  //
  // This assumes the subtree is being DESTROYED. Layout cleanup also fires when
  // a subtree is merely hidden (`<Activity mode="hidden">`, a Suspense
  // fallback); no host does that today, and if one ever wraps a diff that way
  // the models must be re-created on re-show instead of disposed here.
  useIsomorphicLayoutEffect(
    () => () => {
      if (initialDiffReadRef.current) {
        clearTimeout(initialDiffReadRef.current)
        initialDiffReadRef.current = null
      }
      const editor = diffEditorRef.current
      diffEditorRef.current = null
      const model = editor?.getModel()
      editor?.setModel(null)
      model?.original.dispose()
      model?.modified.dispose()
    },
    []
  )

  const navigateToChange = useCallback(
    (index: number) => {
      const editor = diffEditorRef.current
      if (!editor || diffChanges.length === 0) return

      const clampedIndex = Math.max(0, Math.min(index, diffChanges.length - 1))
      setCurrentChangeIndex(clampedIndex)

      const change = diffChanges[clampedIndex]
      const lineNumber =
        change.modifiedStartLineNumber || change.originalStartLineNumber || 1

      const modifiedEditor = editor.getModifiedEditor()
      modifiedEditor.revealLineInCenter(lineNumber)
      modifiedEditor.setPosition({ lineNumber, column: 1 })
    },
    [diffChanges]
  )

  const handlePrevChange = useCallback(() => {
    if (currentChangeIndex > 0) {
      navigateToChange(currentChangeIndex - 1)
    }
  }, [currentChangeIndex, navigateToChange])

  const handleNextChange = useCallback(() => {
    if (currentChangeIndex < diffChanges.length - 1) {
      navigateToChange(currentChangeIndex + 1)
    }
  }, [currentChangeIndex, diffChanges.length, navigateToChange])

  // Stable identity: the library runs `updateOptions` on every change of this
  // prop, so an inline literal would re-push the whole option set each render.
  const diffOptions = useMemo<MonacoEditorNs.IDiffEditorConstructionOptions>(
    () => ({
      readOnly: true,
      renderSideBySide: true,
      renderSideBySideInlineBreakpoint: 0,
      automaticLayout: true,
      fontSize: (editorFontSize * zoomLevel) / 100,
      fontFamily: editorFontStack,
      fontLigatures: editorLigatures,
      wordWrap: editorWordWrap ? "on" : "off",
      minimap: { enabled: false },
      unicodeHighlight: MONACO_UNICODE_HIGHLIGHT_OPTIONS,
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      ignoreTrimWhitespace: true,
      renderIndicators: true,
      originalEditable: false,
    }),
    [
      zoomLevel,
      editorFontStack,
      editorFontSize,
      editorLigatures,
      editorWordWrap,
    ]
  )

  const { additions, deletions } = useMemo(() => {
    let add = 0
    let del = 0
    for (const change of diffChanges) {
      // Monaco ILineChange: endLineNumber === 0 means no lines on that side
      // Pure insertion: originalEndLineNumber === 0
      // Pure deletion: modifiedEndLineNumber === 0
      const isInsertion = change.originalEndLineNumber === 0
      const isDeletion = change.modifiedEndLineNumber === 0

      if (isInsertion) {
        add += change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1
      } else if (isDeletion) {
        del += change.originalEndLineNumber - change.originalStartLineNumber + 1
      } else {
        del += change.originalEndLineNumber - change.originalStartLineNumber + 1
        add += change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1
      }
    }
    return { additions: add, deletions: del }
  }, [diffChanges])

  return (
    <div className={cn("flex h-full flex-col", className)}>
      <div className="flex items-center gap-3 border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="font-medium">{originalLabel}</span>
        <span className="text-muted-foreground/60">↔</span>
        <span className="font-medium">{modifiedLabel}</span>
        {diffChanges.length > 0 && (
          <>
            <span className="ml-2 font-mono text-tone-success">
              +{additions}
            </span>
            <span className="font-mono text-tone-danger">-{deletions}</span>
            <span>
              {diffChanges.length}{" "}
              {diffChanges.length === 1 ? "change" : "changes"}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={handlePrevChange}
                disabled={currentChangeIndex <= 0}
                className="rounded border border-border bg-background px-2 py-0.5 text-3xs disabled:opacity-40 hover:bg-muted transition-colors inline-flex items-center gap-1"
              >
                <ChevronLeft className="h-3 w-3" />
                Prev
              </button>
              <span className="tabular-nums text-3xs">
                {currentChangeIndex + 1} / {diffChanges.length}
              </span>
              <button
                type="button"
                onClick={handleNextChange}
                disabled={currentChangeIndex >= diffChanges.length - 1}
                className="rounded border border-border bg-background px-2 py-0.5 text-3xs disabled:opacity-40 hover:bg-muted transition-colors inline-flex items-center gap-1"
              >
                Next
                <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <MonacoDiffEditor
          original={original}
          modified={modified}
          language={language}
          theme={editorTheme}
          beforeMount={defineMonacoThemes}
          onMount={handleEditorMount}
          loading={
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              Loading diff viewer...
            </div>
          }
          options={diffOptions}
        />
      </div>
    </div>
  )
}
