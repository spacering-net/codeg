"use client"

import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
} from "react"
import {
  cloneElement,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { MermaidConfig } from "@streamdown/mermaid"
import type { Components } from "streamdown"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  MaximizeIcon,
  RotateCcwIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useAppearance } from "@/hooks/use-appearance"
import { saveDiagram, type DiagramFormat } from "@/lib/mermaid-export"
import { cn, copyTextToClipboard } from "@/lib/utils"
import { overlayScrollportRef } from "./markdown-scrollport"
import {
  clampOffset,
  containZoom,
  fitZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  mermaidSourceFromPre,
  parseSvgSize,
  plantUmlSourceFromPre,
  stepZoom,
  stripSvgMaxWidth,
  zoomAroundPoint,
  type Point,
  type Size,
} from "./mermaid-view"
import { renderPlantUml } from "./plantuml-engine"
import { useMermaidEngine } from "./streamdown-plugins"

// --- Why this file exists ----------------------------------------------------
//
// Streamdown renders ```mermaid fences with its own component, and three of its
// choices are baked into the minified bundle with no prop to reach them:
//
//  * zoom is a CSS `transform: scale()` carrying an inline `will-change:
//    transform` AND a 150ms `transition-transform`. Either alone pins the
//    element to a composited layer rasterized once at 1x; together, a drag
//    (which restarts the transition on every pointermove) keeps it there for
//    the whole gesture, so the diagram is both blurry and smeared while it is
//    being moved — the exact symptom users report.
//  * the diagram is always rendered with Mermaid's light `default` theme.
//    Passing a theme through Streamdown's `mermaid` prop does not fix that
//    either: Streamdown's own `memo` comparator does not include that prop, so
//    switching the app theme leaves every already-rendered diagram behind.
//  * "fullscreen" is a bare `fixed inset-0 bg-background/95` layer with no
//    surface of its own, which reads as the page having lost its content
//    rather than as a panel.
//
// So we claim the fence instead. Streamdown builds its component map as
// `{...defaults, ...props.components}`, and its default `pre` only clones the
// child with `data-block`; overriding `pre` therefore intercepts exactly
// ```mermaid and leaves every other fence (shiki, plain code, indented blocks)
// on Streamdown's own path. No remark plugin, no sanitize schema change.
//
// The engine is still Streamdown's: `useMermaidEngine` hands back the same
// lazily-imported `@streamdown/mermaid` singleton the plugin config uses.
//
// ```plantuml fences are claimed at the same point and drawn into the same
// card — zoom, pan, fullscreen, copy, download — by PlantUML's own browser
// engine (`./plantuml-engine.ts`). Streamdown has no PlantUML support of its
// own, so without this such a fence is plain text.

/** Unique id for Mermaid's temporary DOM node — it renders through the document. */
let renderSeq = 0

type DiagramKind = "mermaid" | "plantuml"

/**
 * Draws one diagram source as SVG markup. `signal` aborts once nobody is
 * waiting for the answer any more (the source changed, the block unmounted).
 */
type DiagramRenderer = (source: string, signal: AbortSignal) => Promise<string>

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect

interface RenderState {
  /**
   * Last SVG that rendered successfully. Kept across re-renders so a theme
   * switch or a transient failure degrades to stale colours rather than to an
   * empty card.
   */
  svg: string | null
  error: string | null
  pending: boolean
}

const IDLE: RenderState = { svg: null, error: null, pending: true }

/**
 * Mermaid as a {@link DiagramRenderer}, or `null` until its engine has loaded.
 *
 * Must be called before {@link useRenderedDiagram} in the same component: its
 * ref effect then runs ahead of the render effect in the same commit, so the
 * renderer never reads a stale engine.
 */
function useMermaidRenderer(config: MermaidConfig): DiagramRenderer | null {
  const engine = useMermaidEngine()

  // The engine is a process-wide singleton that resolves exactly once, so what
  // the renderer cares about is only whether it is *there* — never its
  // identity. Keying on the object instead would turn any hook that returns a
  // fresh wrapper into an infinite render/re-render loop, since rendering ends
  // in a setState. Cheap invariant to pin down; expensive one to debug.
  const engineRef = useRef(engine)
  const ready = Boolean(engine)
  useEffect(() => {
    engineRef.current = engine
  }, [engine])

  return useMemo(() => {
    if (!ready) return null
    return async (source: string) => {
      const mermaid = engineRef.current
      if (!mermaid) throw new Error("Mermaid is not loaded")
      renderSeq += 1
      const id = `codeg-mermaid-${renderSeq}`
      const { svg } = await mermaid.getMermaid(config).render(id, source)
      return svg
    }
  }, [ready, config])
}

/**
 * Render `source` whenever the renderer (its engine, its theme) or the source
 * changes — but only once the block has been scrolled near the viewport.
 * `render` is `null` while its engine is still loading.
 */
function useRenderedDiagram(
  render: DiagramRenderer | null,
  source: string,
  active: boolean
): RenderState & { retry: () => void } {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<RenderState>(IDLE)

  useEffect(() => {
    if (!active || !render) return
    const controller = new AbortController()
    void (async () => {
      try {
        const svg = await render(source, controller.signal)
        if (controller.signal.aborted) return
        setState({ svg: stripSvgMaxWidth(svg), error: null, pending: false })
      } catch (err) {
        if (controller.signal.aborted) return
        const message =
          err instanceof Error ? err.message : "Failed to render diagram"
        setState((prev) => ({ ...prev, error: message, pending: false }))
      }
    })()
    return () => controller.abort()
  }, [render, source, active, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { ...state, retry }
}

/**
 * Hold the first render back until the block is near the viewport. A long
 * transcript can carry dozens of diagrams and Mermaid's layout pass is not
 * cheap; Streamdown gates its own renderer the same way.
 */
function useNearViewport(element: HTMLElement | null): boolean {
  // Without an observer (jsdom, and any environment that predates it) there is
  // nothing to wait for, so start out visible rather than setting state from
  // inside the effect.
  const [seen, setSeen] = useState(
    () => typeof IntersectionObserver === "undefined"
  )

  useEffect(() => {
    if (seen || !element) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true)
      },
      { rootMargin: "400px" }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, seen])

  return seen
}

interface ViewportController {
  setViewport: (element: HTMLDivElement | null) => void
  /** Effective zoom — the user's choice, or the fit-to-width factor. */
  zoom: number
  canZoomIn: boolean
  canZoomOut: boolean
  canPan: boolean
  isPanning: boolean
  /** There is diagram below the fold right now — drives the clipped-edge fade. */
  hasContentBelow: boolean
  /** Height the inline card should reserve, or `undefined` before measurement. */
  fitHeight: number | undefined
  contentStyle: CSSProperties
  zoomIn: () => void
  zoomOut: () => void
  reset: () => void
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
}

interface ViewState {
  /** `null` follows the surface's fit factor; a number is the user's choice. */
  zoom: number | null
  offset: Point
}

/**
 * How the default zoom is derived. `"width"` fills the column and lets a tall
 * diagram run past the fold (the inline card, which caps its own height);
 * `"contain"` fits the whole thing (the fullscreen dialog, whose entire job is
 * to show it).
 */
type FitMode = "width" | "contain"

const INITIAL_VIEW: ViewState = { zoom: null, offset: { x: 0, y: 0 } }
const NO_SIZE: Size = { width: 0, height: 0 }

/**
 * Owns zoom + pan for one diagram surface (the inline card and the fullscreen
 * dialog each get their own).
 *
 * ## The crispness contract
 *
 * Zoom is applied as the *width of the host element*, never as a transform: the
 * browser then lays the SVG out at its real size and repaints the vectors, so
 * the diagram is as sharp at 8x as at 1x — in WKWebView too, where a scaled
 * composite layer is at its blurriest. Pan is a `translate` with no
 * `transition` and no `will-change`, rounded to whole pixels so nothing is
 * resampled at a subpixel offset: the drag moves the picture without ever
 * handing it to the compositor to stretch.
 */
function useViewportController(
  natural: Size | null,
  mode: FitMode
): ViewportController {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [viewport, setViewportSize] = useState<Size>(NO_SIZE)
  const [measured, setMeasured] = useState(false)
  const [view, setView] = useState<ViewState>(INITIAL_VIEW)
  const [isPanning, setIsPanning] = useState(false)
  const panRef = useRef<{ pointer: number; from: Point; origin: Point } | null>(
    null
  )

  // Measure the viewport, never the content: the content's width is derived
  // from the zoom, so observing it would feed straight back into itself.
  useIsomorphicLayoutEffect(() => {
    if (!element) return
    const read = () => {
      setViewportSize({
        width: element.clientWidth,
        height: element.clientHeight,
      })
      setMeasured(true)
    }
    read()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(read)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])

  const fit = !natural
    ? 1
    : mode === "contain"
      ? containZoom(natural, viewport)
      : fitZoom(natural.width, viewport.width)
  const zoom = view.zoom ?? fit
  const content: Size = natural
    ? { width: natural.width * zoom, height: natural.height * zoom }
    : viewport
  const offset = clampOffset(view.offset, content, viewport)

  // The wheel handler and the zoom buttons need live geometry, but a *size*
  // that is one frame stale is harmless (it only nudges the anchor point),
  // whereas a stale zoom/offset would compound over a gesture. So sizes go
  // through a ref and zoom/offset are only ever touched functionally.
  const geometryRef = useRef({ natural, viewport, fit })
  useEffect(() => {
    geometryRef.current = { natural, viewport, fit }
  }, [natural, viewport, fit])

  const applyZoom = useCallback((direction: 1 | -1, anchor: Point | null) => {
    setView((prev) => {
      const { natural: nat, viewport: box, fit: fitNow } = geometryRef.current
      if (!nat) return prev
      const current = prev.zoom ?? fitNow
      const next = stepZoom(current, direction)
      if (next === current) return prev
      const point = anchor ?? { x: box.width / 2, y: box.height / 2 }
      const from = clampOffset(
        prev.offset,
        { width: nat.width * current, height: nat.height * current },
        box
      )
      return {
        zoom: next,
        offset: zoomAroundPoint({
          zoom: current,
          nextZoom: next,
          offset: from,
          point,
        }),
      }
    })
  }, [])

  useEffect(() => {
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return
      // Non-passive listener: React's `onWheel` cannot preventDefault, and
      // without that the transcript scrolls out from under the zoom.
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      applyZoom(event.deltaY > 0 ? -1 : 1, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      })
    }
    element.addEventListener("wheel", onWheel, { passive: false })
    return () => element.removeEventListener("wheel", onWheel)
  }, [applyZoom, element])

  const canPan =
    content.width > viewport.width + 1 || content.height > viewport.height + 1

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !canPan) return
      panRef.current = {
        pointer: event.pointerId,
        from: { x: event.clientX, y: event.clientY },
        origin: offset,
      }
      setIsPanning(true)
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [canPan, offset]
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const pan = panRef.current
      if (!pan || pan.pointer !== event.pointerId) return
      event.preventDefault()
      const next = {
        x: pan.origin.x + (event.clientX - pan.from.x),
        y: pan.origin.y + (event.clientY - pan.from.y),
      }
      setView((prev) => ({ ...prev, offset: next }))
    },
    []
  )

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const pan = panRef.current
      if (!pan || pan.pointer !== event.pointerId) return
      panRef.current = null
      setIsPanning(false)
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    },
    []
  )

  return {
    setViewport: setElement,
    zoom,
    canZoomIn: Boolean(natural) && zoom < MAX_ZOOM,
    canZoomOut: Boolean(natural) && zoom > MIN_ZOOM,
    canPan,
    isPanning,
    hasContentBelow: offset.y + content.height > viewport.height + 1,
    fitHeight: natural && measured ? natural.height * fit : undefined,
    contentStyle: {
      width: natural ? natural.width * zoom : "100%",
      transform: `translate(${Math.round(offset.x)}px, ${Math.round(offset.y)}px)`,
    },
    zoomIn: useCallback(() => applyZoom(1, null), [applyZoom]),
    zoomOut: useCallback(() => applyZoom(-1, null), [applyZoom]),
    reset: useCallback(() => setView(INITIAL_VIEW), []),
    onPointerDown,
    onPointerMove,
    onPointerUp,
  }
}

function MermaidCanvas({
  svg,
  label,
  controller,
  className,
  style,
}: {
  svg: string
  label: string
  controller: ViewportController
  className?: string
  style?: CSSProperties
}) {
  // Destructured rather than read through `controller.*`: handing a member
  // expression straight to `ref=` makes the hooks lint treat the whole object
  // as a ref and flag every other read as a render-phase ref access.
  const {
    setViewport,
    canPan,
    isPanning,
    contentStyle,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  } = controller

  return (
    <div
      ref={setViewport}
      // Pinned LTR: under an RTL locale the flex origin and the drag axis both
      // flip, which puts the diagram somewhere the pan clamp does not expect.
      // The direction has to sit on the panning surface itself.
      dir="ltr"
      data-codeg="mermaid-canvas"
      className={cn(
        "relative overflow-hidden",
        // `touch-none` only while there is something to pan, or a touch scroll
        // that happens to start on a diagram would go nowhere.
        canPan &&
          cn(
            "touch-none",
            isPanning ? "cursor-grabbing select-none" : "cursor-grab"
          ),
        className
      )}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      // Capture can also be lost without a pointerup — the browser revokes it
      // when the captured element is removed or hidden. Ending the gesture on
      // that too is what keeps the cursor from staying stuck on `grabbing`
      // with a live pan still recorded.
      onLostPointerCapture={onPointerUp}
    >
      <div
        role="img"
        aria-label={label}
        // No `transition` and no `will-change` here, on purpose — see
        // `useViewportController`.
        className="absolute top-0 left-0 origin-top-left [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
        style={contentStyle}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  )
}

function ZoomControls({ controller }: { controller: ViewportController }) {
  const t = useTranslations("Folder.chat.mermaid")
  return (
    <div className="flex items-center gap-0.5">
      <Button
        aria-label={t("zoomOut")}
        disabled={!controller.canZoomOut}
        onClick={controller.zoomOut}
        size="icon-xs"
        title={t("zoomOut")}
        type="button"
        variant="ghost"
      >
        <ZoomOutIcon />
      </Button>
      <span className="min-w-9 text-center text-2xs text-muted-foreground tabular-nums">
        {Math.round(controller.zoom * 100)}%
      </span>
      <Button
        aria-label={t("zoomIn")}
        disabled={!controller.canZoomIn}
        onClick={controller.zoomIn}
        size="icon-xs"
        title={t("zoomIn")}
        type="button"
        variant="ghost"
      >
        <ZoomInIcon />
      </Button>
      <Button
        aria-label={t("resetView")}
        onClick={controller.reset}
        size="icon-xs"
        title={t("resetView")}
        type="button"
        variant="ghost"
      >
        <RotateCcwIcon />
      </Button>
    </div>
  )
}

function CopySourceButton({ source }: { source: string }) {
  const t = useTranslations("Folder.chat.mermaid")
  const [copied, setCopied] = useState(false)
  const timeoutRef = useRef<number>(0)

  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current)
    },
    []
  )

  const copy = useCallback(async () => {
    if (copied) return
    if (!(await copyTextToClipboard(source))) return
    setCopied(true)
    timeoutRef.current = window.setTimeout(() => setCopied(false), 2000)
  }, [copied, source])

  const label = copied ? t("copied") : t("copySource")
  return (
    <Button
      aria-label={label}
      onClick={() => void copy()}
      size="icon-xs"
      title={label}
      type="button"
      variant="ghost"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  )
}

function DownloadMenu({
  kind,
  svg,
  source,
}: {
  kind: DiagramKind
  svg: string | null
  source: string
}) {
  const t = useTranslations("Folder.chat.mermaid")

  const save = useCallback(
    async (format: DiagramFormat) => {
      try {
        await saveDiagram({ format, svg, source })
      } catch (err) {
        console.error("[MermaidBlock] download failed:", err)
        toast.error(t("downloadFailed"))
      }
    },
    [source, svg, t]
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={t("download")}
          size="icon-xs"
          title={t("download")}
          type="button"
          variant="ghost"
        >
          <DownloadIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={!svg} onSelect={() => void save("svg")}>
          {t("downloadSvg")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!svg} onSelect={() => void save("png")}>
          {t("downloadPng")}
        </DropdownMenuItem>
        {kind === "plantuml" ? (
          <DropdownMenuItem onSelect={() => void save("puml")}>
            {t("downloadPuml")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => void save("mmd")}>
            {t("downloadMmd")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Floating control cluster. It carries a real surface — border, background,
 * shadow — precisely because bare icons laid straight over a diagram are what
 * "blends into the background" means.
 */
function ControlChip({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        "absolute z-10 flex items-center gap-0.5 rounded-lg border border-border bg-background/90 p-0.5 shadow-sm supports-backdrop-filter:backdrop-blur-sm",
        className
      )}
    >
      {children}
    </div>
  )
}

function DiagramError({
  kind,
  message,
  source,
  onRetry,
}: {
  kind: DiagramKind
  message: string
  source: string
  onRetry: () => void
}) {
  const t = useTranslations("Folder.chat.mermaid")
  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-destructive text-sm">
          {t(kind === "plantuml" ? "plantumlRenderFailed" : "renderFailed", {
            message,
          })}
        </p>
        <Button onClick={onRetry} size="xs" type="button" variant="outline">
          {t("retry")}
        </Button>
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-muted-foreground text-xs">
          {t("showSource")}
        </summary>
        <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 text-xs">
          {source}
        </pre>
      </details>
    </div>
  )
}

function FullscreenDiagram({
  kind,
  svg,
  source,
  natural,
}: {
  kind: DiagramKind
  svg: string
  source: string
  natural: Size | null
}) {
  const t = useTranslations("Folder.chat.mermaid")
  const controller = useViewportController(natural, "contain")

  return (
    <DialogContent
      aria-describedby={undefined}
      // A framed panel on the dimmed overlay `DialogContent` already brings —
      // the point of moving fullscreen into a real dialog.
      className="grid h-[90dvh] w-full max-w-[95vw] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden overflow-y-hidden rounded-2xl p-0"
      showCloseButton={false}
    >
      <div className="flex items-center justify-between gap-2 border-border border-b px-3 py-2">
        <DialogTitle className="truncate font-medium text-sm">
          {t("diagram")}
        </DialogTitle>
        <div className="flex items-center gap-0.5">
          <ZoomControls controller={controller} />
          <span className="mx-1 h-4 w-px bg-border" />
          <DownloadMenu kind={kind} source={source} svg={svg} />
          <CopySourceButton source={source} />
          <DialogClose asChild>
            <Button
              aria-label={t("close")}
              size="icon-xs"
              title={t("close")}
              type="button"
              variant="ghost"
            >
              <XIcon />
            </Button>
          </DialogClose>
        </div>
      </div>
      <MermaidCanvas
        className="size-full bg-card"
        controller={controller}
        label={t("diagram")}
        svg={svg}
      />
    </DialogContent>
  )
}

/**
 * The card a rendered diagram sits in — the same for both fence languages.
 * Rendering itself stays with the block that owns the engine.
 */
function DiagramCard({
  kind,
  source,
  state,
  active,
  setRoot,
}: {
  kind: DiagramKind
  source: string
  state: RenderState & { retry: () => void }
  active: boolean
  setRoot: (element: HTMLDivElement | null) => void
}) {
  const t = useTranslations("Folder.chat.mermaid")
  const { svg, error, pending, retry } = state
  // Mermaid and PlantUML both emit a viewBox. If one ever does not, the
  // diagram still renders at its natural flow size and the zoom controls stay
  // disabled rather than pretending to work.
  const natural = useMemo(() => (svg ? parseSvgSize(svg) : null), [svg])
  const controller = useViewportController(natural, "width")

  if (error && !svg) {
    return (
      <div className="my-4" ref={setRoot}>
        <DiagramError
          kind={kind}
          message={error}
          onRetry={retry}
          source={source}
        />
      </div>
    )
  }

  if (!svg) {
    return (
      <div
        className="my-4 flex min-h-28 items-center justify-center rounded-xl border border-border bg-card"
        ref={setRoot}
      >
        <span className="text-muted-foreground text-sm">
          {active && pending ? t("loading") : null}
        </span>
      </div>
    )
  }

  return (
    <div
      className="relative my-4 overflow-hidden rounded-xl border border-border bg-card"
      data-codeg={`${kind}-block`}
      ref={setRoot}
    >
      {/* The height comes from the fit factor, not from the current zoom:
          zooming has to move the picture inside a stable box rather than
          reflow the transcript around it. `max-h-[60vh]` keeps a tall diagram
          from swallowing the screen — what it cannot show is one drag or one
          fullscreen click away. */}
      <MermaidCanvas
        className={cn(
          "max-h-[60vh] w-full",
          controller.fitHeight === undefined && "min-h-28"
        )}
        controller={controller}
        label={t("diagram")}
        style={{ height: controller.fitHeight }}
        svg={svg}
      />
      {/* The cap above cuts a tall diagram mid-stroke, which reads as a
          rendering fault rather than as "there is more". Fade the clipped edge
          while there actually is something below it. */}
      {controller.hasContentBelow && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent"
        />
      )}
      <ControlChip className="top-2 right-2">
        <DownloadMenu kind={kind} source={source} svg={svg} />
        <CopySourceButton source={source} />
        <Dialog>
          <DialogTrigger asChild>
            <Button
              aria-label={t("fullscreen")}
              size="icon-xs"
              title={t("fullscreen")}
              type="button"
              variant="ghost"
            >
              <MaximizeIcon />
            </Button>
          </DialogTrigger>
          <FullscreenDiagram
            kind={kind}
            natural={natural}
            source={source}
            svg={svg}
          />
        </Dialog>
      </ControlChip>
      <ControlChip className="bottom-2 left-2">
        <ZoomControls controller={controller} />
      </ControlChip>
    </div>
  )
}

function MermaidBlockImpl({ source }: { source: string }) {
  const { isDarkMode } = useAppearance()
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const active = useNearViewport(root)

  // Mermaid's own dark palette. Reading `isDarkMode` from context is what makes
  // a live theme switch work at all: a context update pierces the `memo` around
  // `MessageResponse` and the one around Streamdown itself, neither of which
  // compares anything theme-shaped.
  const config = useMemo<MermaidConfig>(
    () => ({ theme: isDarkMode ? "dark" : "default" }),
    [isDarkMode]
  )
  const render = useMermaidRenderer(config)
  const state = useRenderedDiagram(render, source, active)

  return (
    <DiagramCard
      active={active}
      kind="mermaid"
      setRoot={setRoot}
      source={source}
      state={state}
    />
  )
}

const MermaidBlock = memo(MermaidBlockImpl)
MermaidBlock.displayName = "MermaidBlock"

function PlantUmlBlockImpl({ source }: { source: string }) {
  const { isDarkMode } = useAppearance()
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const active = useNearViewport(root)

  // PlantUML's own dark palette, switched live the same way as Mermaid's.
  const render = useCallback<DiagramRenderer>(
    (text, signal) => renderPlantUml(text, { dark: isDarkMode, signal }),
    [isDarkMode]
  )
  const state = useRenderedDiagram(render, source, active)

  return (
    <DiagramCard
      active={active}
      kind="plantuml"
      setRoot={setRoot}
      source={source}
      state={state}
    />
  )
}

const PlantUmlBlock = memo(PlantUmlBlockImpl)
PlantUmlBlock.displayName = "PlantUmlBlock"

/**
 * `pre` override installed on every `<Streamdown>` in the app.
 *
 * Claims ` ```mermaid ` and ` ```plantuml ` (or ` ```puml `), and reproduces
 * Streamdown's default behaviour for everything else: its own `pre` does
 * nothing but stamp `data-block` on the child, and that flag is what its
 * `code` component reads to tell a fenced block from inline code. Dropping it
 * would render every code fence as inline code, so the passthrough is
 * load-bearing.
 *
 * The passthrough also hands the code element a ref, which Streamdown passes
 * on with the element's other props to the block's scrolling body: the body
 * gets the app's overlay scrollbars.
 */
export function MermaidAwarePre({ children }: { children?: ReactNode }) {
  if (!isValidElement(children)) return <>{children}</>
  const mermaid = mermaidSourceFromPre(children)
  if (mermaid !== null) return <MermaidBlock source={mermaid} />
  const plantUml = plantUmlSourceFromPre(children)
  if (plantUml !== null) return <PlantUmlBlock source={plantUml} />
  return cloneElement(
    children as ReactElement<{
      "data-block"?: string
      ref?: typeof overlayScrollportRef
    }>,
    { "data-block": "true", ref: overlayScrollportRef }
  )
}

export const mermaidComponents: Components = {
  pre: MermaidAwarePre as Components["pre"],
}
