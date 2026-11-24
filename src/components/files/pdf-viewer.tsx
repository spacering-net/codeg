"use client"

// PDF.js's stylesheet is imported here and nowhere else. This module is
// loaded on demand (see `pdf-preview.tsx`), so its ~170 KB arrive with the
// first PDF tab rather than with the workspace.
import "pdfjs-dist/legacy/web/pdf_viewer.css"

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDown,
  ChevronUp,
  LockKeyhole,
  Minus,
  MoveHorizontal,
  Plus,
  Search,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import { useImeGuard } from "@/hooks/use-ime-guard"
import {
  isPrimaryModifier,
  useOpenUrlTarget,
} from "@/hooks/use-open-url-target"
import { toErrorMessage } from "@/lib/app-error"
import {
  decodePdfDataUrl,
  isPdfDataUrl,
  loadPdfjs,
  pdfDocumentParams,
  type PdfjsModules,
  type PdfjsViewerComponents,
} from "@/lib/pdfjs"
import { cn } from "@/lib/utils"

type PdfViewerInstance = InstanceType<PdfjsViewerComponents["PDFViewer"]>
type EventBusInstance = InstanceType<PdfjsViewerComponents["EventBus"]>

/** The live viewer the toolbar drives; null while no document is set up. */
interface ViewerHandles {
  viewer: PdfViewerInstance
  eventBus: EventBusInstance
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "password"; incorrect: boolean }
  | { kind: "error"; invalid: boolean; message: string }

interface FindMatches {
  current: number
  total: number
}

/** Scale presets PDF.js re-fits whenever its container changes size. */
const FITTED_SCALES = new Set(["auto", "page-fit", "page-width"])

/** A trackpad pinch arrives as a ctrl+wheel with small deltas: below this
 *  change in scale per event it zooms continuously, above it (a mouse wheel's
 *  notch) a step at a time. PDF.js's own viewer draws the line in the same
 *  place. */
const PINCH_FACTOR_THRESHOLD = 0.05

const TOOLBAR_BUTTON =
  "rounded p-1 transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40"

/**
 * Where each PDF tab was last read, as PDF.js's own `page=…&zoom=…` hash,
 * keyed by tab id. The file column renders only the active tab, so switching
 * tabs unmounts the viewer; coming back resumes here, and so does the same
 * tab shown in the file viewer drawer or a canvas card, and the document
 * reopened after it changed on disk. Lives for the session: a few dozen
 * bytes per PDF opened.
 */
const lastLocations = new Map<string, string>()

function isInvalidPdf(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "InvalidPDFException"
  )
}

/**
 * A PDF file tab, rendered with PDF.js's own viewer components: continuous
 * pages rendered lazily as they scroll into view, a text layer to select and
 * copy from, working in-document links, zoom and find.
 *
 * The tab's content is the file as a `data:` URL (see `readBinaryPreview` in
 * the workspace provider). A document opens where its tab was last read (see
 * `lastLocations`), including after the file changed on disk.
 */
export function PdfViewer({ tab }: { tab: FileWorkspaceTab }) {
  const t = useTranslations("Folder.fileWorkspacePanel")
  const tabId = tab.id
  const content = tab.content
  const isPdf = isPdfDataUrl(content)

  const containerRef = useRef<HTMLDivElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const handlesRef = useRef<ViewerHandles | null>(null)
  const submitPasswordRef = useRef<((password: string) => void) | null>(null)

  const openUrlTarget = useOpenUrlTarget()
  const openUrlTargetRef = useRef(openUrlTarget)
  const [findQuery, setFindQuery] = useState("")
  const findQueryRef = useRef(findQuery)
  useEffect(() => {
    openUrlTargetRef.current = openUrlTarget
    findQueryRef.current = findQuery
  }, [openUrlTarget, findQuery])

  // The outcome is recorded against the content it belongs to, so a new
  // content reads as loading until its own outcome lands.
  const [status, setStatus] = useState<{
    content: string
    state: LoadState
  } | null>(null)
  const state: LoadState =
    status?.content === content ? status.state : { kind: "loading" }
  const ready = state.kind === "ready"

  const [pagesCount, setPagesCount] = useState(0)
  const [pageNumber, setPageNumber] = useState(1)
  // The page field while someone types in it; null shows the current page.
  const [pageDraft, setPageDraft] = useState<string | null>(null)
  const [scale, setScale] = useState<{ value: number; preset: string | null }>({
    value: 1,
    preset: null,
  })
  const [findMatches, setFindMatches] = useState<FindMatches | null>(null)
  const [findNotFound, setFindNotFound] = useState(false)
  const [password, setPassword] = useState("")
  const ime = useImeGuard()

  useEffect(() => {
    const container = containerRef.current
    if (!container || !isPdfDataUrl(content)) return
    const restoreHash = lastLocations.get(tabId) ?? null
    const abort = new AbortController()
    const { signal } = abort
    let disposed = false
    let viewer: PdfViewerInstance | null = null
    let linkService: { setDocument(doc: unknown): void } | null = null
    let loadingTask: { destroy(): Promise<void> } | null = null
    const settle = (next: LoadState) => {
      if (!disposed) setStatus({ content, state: next })
    }

    // Links in the document. PDF.js renders an external one as a plain
    // anchor, and following it would navigate the app's own window away.
    // Route it through the app's link decision instead (the built-in or the
    // system browser), the way a link in a rendered markdown file goes.
    // In-document links (`#…`) are PDF.js's own and pass through.
    const followLink = (event: MouseEvent, modifier: boolean) => {
      const anchor = (event.target as Element | null)?.closest?.("a")
      const href = anchor?.getAttribute("href")
      if (!anchor || !href || href.startsWith("#")) return
      event.preventDefault()
      openUrlTargetRef.current(href, { source: "editor", modifier })
    }
    container.addEventListener(
      "click",
      (event) => followLink(event, isPrimaryModifier(event)),
      { capture: true, signal }
    )
    container.addEventListener(
      "auxclick",
      (event) => {
        if (event.button === 1) followLink(event, true)
      },
      { capture: true, signal }
    )

    // ⌘/Ctrl + wheel, and a trackpad pinch (which arrives as one), zooms the
    // document instead of the whole app.
    container.addEventListener(
      "wheel",
      (event) => {
        if (!(event.ctrlKey || event.metaKey) || !viewer?.pdfDocument) return
        event.preventDefault()
        const factor = Math.exp(-event.deltaY / 100)
        const origin = [event.clientX, event.clientY]
        if (Math.abs(factor - 1) < PINCH_FACTOR_THRESHOLD) {
          viewer.updateScale({ drawingDelay: 400, scaleFactor: factor, origin })
        } else {
          viewer.updateScale({ steps: event.deltaY < 0 ? 1 : -1, origin })
        }
      },
      { passive: false, signal }
    )

    // A fitted scale follows the container: a resized column, a maximized
    // one, a resized canvas card.
    const resizeObserver = new ResizeObserver(() => {
      if (!viewer?.pdfDocument) return
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      const value = viewer.currentScaleValue
      if (FITTED_SCALES.has(value)) viewer.currentScaleValue = value
      viewer.update()
    })
    resizeObserver.observe(container)
    signal.addEventListener("abort", () => resizeObserver.disconnect())

    const open = async () => {
      const modules: PdfjsModules = await loadPdfjs()
      const data = decodePdfDataUrl(content)
      if (disposed || !data) return
      const { lib, components } = modules

      const eventBus = new components.EventBus()
      const links = new components.PDFLinkService({ eventBus })
      const findController = new components.PDFFindController({
        eventBus,
        linkService: links,
      })
      const pdfViewer = new components.PDFViewer({
        container,
        eventBus,
        linkService: links,
        findController,
        // Not in the published typings, but the constructor reads it (PDF.js's
        // own viewer passes it): aborting detaches the viewer's scroll
        // listener and resize observer from a container that outlives it.
        ...({ abortSignal: signal } as object),
      })
      links.setViewer(pdfViewer)
      viewer = pdfViewer
      linkService = links
      handlesRef.current = { viewer: pdfViewer, eventBus }

      eventBus.on("pagesinit", () => {
        if (disposed) return
        // "auto" first, so a place the new document cannot honour (it has
        // fewer pages now) still leaves it fitted rather than unscaled.
        pdfViewer.currentScaleValue = "auto"
        if (restoreHash) links.setHash(restoreHash)
        // A search still in the box carries over to the new document.
        const query = findQueryRef.current
        if (query) eventBus.dispatch("find", findEvent(query, ""))
      })
      eventBus.on("pagechanging", (event: { pageNumber: number }) => {
        if (!disposed) setPageNumber(event.pageNumber)
      })
      eventBus.on(
        "scalechanging",
        (event: { scale: number; presetValue?: string }) => {
          if (disposed) return
          setScale({ value: event.scale, preset: event.presetValue ?? null })
        }
      )
      eventBus.on(
        "updateviewarea",
        (event: { location?: { pdfOpenParams: string } }) => {
          if (disposed || !event.location) return
          lastLocations.set(
            tabId,
            event.location.pdfOpenParams.replace(/^#/, "")
          )
        }
      )
      eventBus.on(
        "updatefindmatchescount",
        (event: { matchesCount: FindMatches }) => {
          if (!disposed) setFindMatches(event.matchesCount)
        }
      )
      eventBus.on(
        "updatefindcontrolstate",
        (event: { state: number; matchesCount: FindMatches }) => {
          if (disposed) return
          setFindMatches(event.matchesCount)
          setFindNotFound(event.state === components.FindState.NOT_FOUND)
        }
      )

      const task = lib.getDocument(pdfDocumentParams(data))
      loadingTask = task
      task.onPassword = (
        update: (password: string) => void,
        reason: number
      ) => {
        if (disposed) return
        submitPasswordRef.current = update
        settle({
          kind: "password",
          incorrect: reason === lib.PasswordResponses.INCORRECT_PASSWORD,
        })
      }
      const pdfDocument = await task.promise
      if (disposed) return
      submitPasswordRef.current = null
      pdfViewer.setDocument(pdfDocument)
      links.setDocument(pdfDocument, null)
      setPagesCount(pdfDocument.numPages)
      setPageNumber(1)
      settle({ kind: "ready" })
    }
    // Every failure lands here: PDF.js not loading, bytes that do not decode,
    // a viewer that refuses to start, a document PDF.js cannot parse.
    open().catch((error: unknown) => {
      settle({
        kind: "error",
        invalid: isInvalidPdf(error),
        message: toErrorMessage(error),
      })
    })

    return () => {
      disposed = true
      handlesRef.current = null
      submitPasswordRef.current = null
      viewer?.setDocument(null)
      linkService?.setDocument(null)
      abort.abort()
      void loadingTask?.destroy()
    }
  }, [content, tabId])

  const setScaleValue = (value: string) => {
    const handles = handlesRef.current
    if (handles) handles.viewer.currentScaleValue = value
  }

  const commitPageDraft = () => {
    const handles = handlesRef.current
    const target = Number.parseInt(pageDraft ?? "", 10)
    if (handles && target >= 1 && target <= pagesCount) {
      handles.viewer.currentPageNumber = target
    }
    setPageDraft(null)
  }

  const runFind = (query: string, type: "" | "again", previous = false) => {
    const handles = handlesRef.current
    if (!handles) return
    if (!query) {
      handles.eventBus.dispatch("findbarclose", { source: null })
      setFindMatches(null)
      setFindNotFound(false)
      return
    }
    handles.eventBus.dispatch("find", findEvent(query, type, previous))
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isPrimaryModifier(event) && event.key.toLowerCase() === "f") {
      event.preventDefault()
      findInputRef.current?.focus()
      findInputRef.current?.select()
    }
  }

  const handlePasswordSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const submit = submitPasswordRef.current
    if (!submit || !password) return
    submitPasswordRef.current = null
    setStatus({ content, state: { kind: "loading" } })
    setPassword("")
    submit(password)
  }

  if (!isPdf) {
    // No document yet (the cold load), or the message of a load that failed.
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
        {content || t("loading")}
      </div>
    )
  }

  // The page, zoom and match figures belong to the document on screen. A
  // reload keeps them up (it reopens at the same place, so they hold), but
  // behind a password prompt or an error there is no document, and the
  // previous one's figures would only mislead.
  const hasDocument = state.kind === "ready" || state.kind === "loading"
  const findStatus = !hasDocument
    ? null
    : findQuery && findNotFound
      ? t("pdfFindNoMatches")
      : findQuery && findMatches && findMatches.total > 0
        ? `${findMatches.current}/${findMatches.total}`
        : null

  return (
    <div className="flex h-full flex-col" onKeyDown={handleKeyDown}>
      {/* Three groups that wrap as wholes: a narrow column (or canvas card)
          puts the find box on a second row instead of cutting it off. */}
      <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/30 px-3 py-1">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => handlesRef.current?.viewer.decreaseScale()}
            disabled={!ready}
            className={TOOLBAR_BUTTON}
            title={t("pdfZoomOut")}
            aria-label={t("pdfZoomOut")}
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setScaleValue("auto")}
            disabled={!ready}
            className="min-w-[3.5rem] rounded px-1.5 py-0.5 text-center font-mono text-2xs text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
            title={t("pdfZoomReset")}
            aria-label={t("pdfZoomReset")}
          >
            {hasDocument ? `${Math.round(scale.value * 100)}%` : "-"}
          </button>
          <button
            type="button"
            onClick={() => handlesRef.current?.viewer.increaseScale()}
            disabled={!ready}
            className={TOOLBAR_BUTTON}
            title={t("pdfZoomIn")}
            aria-label={t("pdfZoomIn")}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setScaleValue("page-width")}
            disabled={!ready}
            aria-pressed={scale.preset === "page-width"}
            className={cn(
              TOOLBAR_BUTTON,
              "ml-0.5",
              scale.preset === "page-width" && "text-primary"
            )}
            title={t("pdfFitWidth")}
            aria-label={t("pdfFitWidth")}
          >
            <MoveHorizontal className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-1 text-2xs text-muted-foreground">
          <input
            value={hasDocument ? (pageDraft ?? String(pageNumber)) : ""}
            onChange={(event) => setPageDraft(event.target.value)}
            onBlur={() => setPageDraft(null)}
            {...ime.props}
            onKeyDown={(event) => {
              // An Enter that confirms an IME candidate is the IME's.
              if (ime.isComposing(event)) return
              if (event.key === "Enter") {
                event.preventDefault()
                commitPageDraft()
              } else if (event.key === "Escape") {
                event.preventDefault()
                setPageDraft(null)
              }
            }}
            disabled={!ready}
            inputMode="numeric"
            aria-label={t("pdfPageNumber")}
            title={t("pdfPageNumber")}
            className="h-5 w-9 rounded border border-border bg-background px-1 text-center font-mono text-2xs text-foreground outline-none focus-visible:border-ring disabled:opacity-40"
          />
          <span className="font-mono">/ {ready ? pagesCount : "-"}</span>
        </div>

        <div className="ml-auto flex min-w-0 items-center gap-1">
          <div className="relative min-w-0">
            <Search className="pointer-events-none absolute top-1/2 left-1.5 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={findInputRef}
              type="search"
              value={findQuery}
              onChange={(event) => {
                setFindQuery(event.target.value)
                runFind(event.target.value, "")
              }}
              {...ime.props}
              onKeyDown={(event) => {
                if (ime.isComposing(event)) return
                if (event.key === "Enter") {
                  event.preventDefault()
                  runFind(findQuery, "again", event.shiftKey)
                } else if (event.key === "Escape") {
                  event.preventDefault()
                  setFindQuery("")
                  runFind("", "")
                  containerRef.current?.focus()
                }
              }}
              disabled={!ready}
              placeholder={t("pdfFind")}
              aria-label={t("pdfFind")}
              className="h-5 w-40 min-w-0 rounded border border-border bg-background pr-1 pl-5 text-2xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring disabled:opacity-40"
            />
          </div>
          {findStatus && (
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">
              {findStatus}
            </span>
          )}
          <button
            type="button"
            onClick={() => runFind(findQuery, "again", true)}
            disabled={!ready || !findQuery}
            className={TOOLBAR_BUTTON}
            title={t("pdfFindPrevious")}
            aria-label={t("pdfFindPrevious")}
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => runFind(findQuery, "again")}
            disabled={!ready || !findQuery}
            className={TOOLBAR_BUTTON}
            title={t("pdfFindNext")}
            aria-label={t("pdfFindNext")}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {/* PDF.js requires its container to be absolutely positioned and to
            hold the `.pdfViewer` element it fills with pages. Focusable, so
            the keyboard scrolls it and ⌘/Ctrl+F reaches the find box. */}
        <div
          ref={containerRef}
          tabIndex={0}
          role="region"
          aria-label={t("pdfDocument")}
          className="absolute inset-0 overflow-auto bg-muted-foreground/15 outline-none"
        >
          <div className="pdfViewer" />
        </div>
        {state.kind !== "ready" && (
          <div className="absolute inset-0 flex items-center justify-center bg-background px-6 text-center text-xs text-muted-foreground">
            {state.kind === "loading" && t("loading")}
            {state.kind === "error" &&
              (state.invalid
                ? t("pdfInvalid")
                : t("pdfLoadFailed", { message: state.message }))}
            {state.kind === "password" && (
              <form
                onSubmit={handlePasswordSubmit}
                className="flex w-full max-w-xs flex-col items-center gap-3"
              >
                <LockKeyhole className="h-5 w-5" />
                <p>
                  {state.incorrect
                    ? t("pdfPasswordIncorrect")
                    : t("pdfPasswordPrompt")}
                </p>
                <div className="flex w-full items-center gap-2">
                  <Input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={t("pdfPassword")}
                    aria-label={t("pdfPassword")}
                    aria-invalid={state.incorrect || undefined}
                    className="h-7 text-xs md:text-xs"
                  />
                  <Button type="submit" size="xs" disabled={!password}>
                    {t("pdfPasswordSubmit")}
                  </Button>
                </div>
              </form>
            )}
          </div>
        )}
        {tab.loading && ready && (
          <div className="absolute top-2 right-3 z-10 rounded-md bg-background/70 px-2 py-1 text-2xs text-muted-foreground backdrop-blur-sm">
            {t("loading")}
          </div>
        )}
      </div>
    </div>
  )
}

/** The payload PDF.js's find controller takes: case- and diacritic-
 *  insensitive, every match highlighted, the way its own find bar defaults. */
function findEvent(query: string, type: "" | "again", previous = false) {
  return {
    source: null,
    type,
    query,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious: previous,
    matchDiacritics: false,
  }
}
