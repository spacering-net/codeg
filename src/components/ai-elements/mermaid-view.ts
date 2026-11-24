/**
 * Geometry and detection helpers for the diagram viewport that Mermaid and
 * PlantUML fences render into (see `./mermaid-block.tsx`).
 *
 * Kept free of React and the DOM on purpose: jsdom reports zero for every
 * measurement, so none of this could be covered through the component. The
 * component is a thin shell around these functions — everything that can be
 * gotten wrong numerically lives here and is unit-tested directly.
 */

/**
 * Zoom bounds. Wider than Streamdown's built-in 0.5–3: a dense flowchart is
 * routinely rendered at a fit factor well under 0.5 (so the lower bound has to
 * leave room below "fits the chat column"), and reading a small label in a
 * large diagram wants more than 3.
 */
export const MIN_ZOOM = 0.2
export const MAX_ZOOM = 8

/**
 * Multiplicative step. A fixed additive step (Streamdown uses +/-0.1) is far
 * too coarse near the bottom of the range and far too fine near the top;
 * multiplying keeps every click the same *perceived* amount of zoom.
 */
export const ZOOM_FACTOR = 1.25

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/** One zoom click: `direction` 1 zooms in, -1 zooms out. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  return clampZoom(direction > 0 ? zoom * ZOOM_FACTOR : zoom / ZOOM_FACTOR)
}

/**
 * Zoom at which a diagram of `naturalWidth` fills `viewportWidth`, capped at
 * 1: a diagram narrower than the column is shown at its own size rather than
 * blown up to fill it (Mermaid picks a font size for 1:1).
 */
export function fitZoom(naturalWidth: number, viewportWidth: number): number {
  if (naturalWidth <= 0 || viewportWidth <= 0) return 1
  return clampZoom(Math.min(1, viewportWidth / naturalWidth))
}

/**
 * Zoom at which the whole diagram fits inside `viewport`, capped at 1.
 *
 * The fullscreen dialog's job is to show the diagram, so it fits both axes;
 * the inline card fits width only and clips the overflow, which keeps a
 * diagram in the transcript at a readable scale instead of shrinking a tall
 * one to a thumbnail.
 */
export function containZoom(natural: Size, viewport: Size): number {
  if (
    natural.width <= 0 ||
    natural.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return 1
  }
  return clampZoom(
    Math.min(
      1,
      viewport.width / natural.width,
      viewport.height / natural.height
    )
  )
}

/**
 * Pan offset that keeps the content point currently under `point` under it
 * after the zoom changes from `zoom` to `nextZoom`.
 *
 * `point` and `offset` are both viewport-local pixels (origin = viewport's
 * top-left). The content coordinate under the pointer is
 * `(point - offset) / zoom`; requiring it to still land on `point` at
 * `nextZoom` gives the expression below.
 */
export function zoomAroundPoint(opts: {
  zoom: number
  nextZoom: number
  offset: Point
  point: Point
}): Point {
  const { zoom, nextZoom, offset, point } = opts
  if (zoom <= 0) return offset
  const ratio = nextZoom / zoom
  return {
    x: point.x - (point.x - offset.x) * ratio,
    y: point.y - (point.y - offset.y) * ratio,
  }
}

/**
 * Clamp one axis of the pan offset. Content smaller than the viewport is
 * centred and not draggable at all (the offset is derived, not remembered);
 * larger content is held so that its edges can never be dragged inside the
 * viewport, which is what makes a diagram impossible to lose.
 */
export function clampAxis(
  offset: number,
  contentSize: number,
  viewportSize: number
): number {
  if (contentSize <= viewportSize) return (viewportSize - contentSize) / 2
  return Math.min(0, Math.max(viewportSize - contentSize, offset))
}

export function clampOffset(
  offset: Point,
  content: Size,
  viewport: Size
): Point {
  return {
    x: clampAxis(offset.x, content.width, viewport.width),
    y: clampAxis(offset.y, content.height, viewport.height),
  }
}

const SVG_TAG = /<svg\b[^>]*>/i
const VIEW_BOX_ATTR = /\bviewBox\s*=\s*["']([^"']*)["']/i
const WIDTH_ATTR = /\bwidth\s*=\s*["']([^"']*)["']/i
const HEIGHT_ATTR = /\bheight\s*=\s*["']([^"']*)["']/i

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

/**
 * A `width`/`height` attribute in absolute pixels, or `null`.
 *
 * `parseFloat` would happily read `"100%"` as `100` — which is exactly the
 * value Mermaid puts there, so accepting it would size a diagram to a 100px
 * box. Only a bare number or an explicit `px` counts.
 */
function pixelAttr(raw: string | undefined): number | null {
  if (!raw) return null
  const match = /^\s*(-?[\d.]+)(px)?\s*$/i.exec(raw)
  if (!match) return null
  const value = Number.parseFloat(match[1])
  return finitePositive(value) ? value : null
}

/**
 * Natural size of a rendered Mermaid SVG, in CSS pixels.
 *
 * Mermaid's `useMaxWidth` default emits `width="100%"` on the root `<svg>` and
 * puts the real size in `viewBox` (plus a `style="max-width: Npx"`), so the
 * width attribute is useless and the viewBox is the authority. The
 * width/height attributes are still read as a fallback for the diagram types
 * (and `useMaxWidth: false` configs) that emit pixel sizes instead.
 */
export function parseSvgSize(svg: string): Size | null {
  const tag = svg.match(SVG_TAG)?.[0]
  if (!tag) return null

  const viewBox = tag.match(VIEW_BOX_ATTR)?.[1]
  if (viewBox) {
    const parts = viewBox
      .trim()
      .split(/[\s,]+/)
      .map(Number)
    if (parts.length === 4) {
      const [, , width, height] = parts as [number, number, number, number]
      if (finitePositive(width) && finitePositive(height)) {
        return { width, height }
      }
    }
  }

  const width = pixelAttr(tag.match(WIDTH_ATTR)?.[1])
  const height = pixelAttr(tag.match(HEIGHT_ATTR)?.[1])
  return width !== null && height !== null ? { width, height } : null
}

/**
 * Drop the inline `max-width` Mermaid puts on the root `<svg>`.
 *
 * That declaration is how Mermaid's `useMaxWidth` default keeps a diagram from
 * overflowing its container — and it is exactly what has to go for zoom to
 * work here, because we zoom by *sizing the host element* rather than by
 * scaling a transform (the whole point: a real vector re-layout stays crisp at
 * any factor, a scaled composite layer does not). An inline declaration cannot
 * be beaten from a stylesheet without `!important`, so remove it at the source
 * instead. Only the root tag is touched; nested styles are left alone.
 */
export function stripSvgMaxWidth(svg: string): string {
  return svg.replace(SVG_TAG, (tag) =>
    tag.replace(
      /\bstyle\s*=\s*(["'])([\s\S]*?)\1/i,
      (_match, quote: string, css: string) => {
        const next = css
          .replace(/(?:^|;)\s*max-width\s*:[^;]*/gi, ";")
          .replace(/^;+|;+$/g, "")
        return `style=${quote}${next}${quote}`
      }
    )
  )
}

/**
 * `language-mermaid` and nothing else — `language-mermaidx` must not match, and
 * the class sits in a space-separated list alongside Streamdown's own classes.
 */
const MERMAID_LANGUAGE = /(?:^|\s)language-mermaid(?:\s|$)/

/** `language-plantuml`, or `language-puml` (PlantUML's file extension). */
const PLANTUML_LANGUAGE = /(?:^|\s)language-(?:plantuml|puml)(?:\s|$)/

interface ElementLike {
  props?: { className?: unknown; children?: unknown }
}

function isElementLike(value: unknown): value is ElementLike {
  return typeof value === "object" && value !== null && "props" in value
}

/**
 * The fence source inside a `<pre>`'s child when its language matches, or
 * `null` when that child is anything else.
 *
 * This is the interception point for the diagram blocks: Markdown renders
 * ` ```mermaid ` as `<pre><code class="language-mermaid">…</code></pre>`, and
 * overriding `components.pre` lets us claim exactly that shape while every
 * other fence keeps flowing to Streamdown's own code block. Reading the source
 * off `props.children` as a string mirrors how Streamdown's `MarkdownCode`
 * does it, so a fence we claim carries the same text it would have.
 */
function fenceSourceFromPre(child: unknown, language: RegExp): string | null {
  if (!isElementLike(child)) return null
  const className = child.props?.className
  if (typeof className !== "string" || !language.test(className)) {
    return null
  }
  const source = child.props?.children
  return typeof source === "string" ? source : null
}

/** The source of a ` ```mermaid ` fence, or `null` for any other `<pre>` child. */
export function mermaidSourceFromPre(child: unknown): string | null {
  return fenceSourceFromPre(child, MERMAID_LANGUAGE)
}

/** The source of a ` ```plantuml ` / ` ```puml ` fence, or `null` otherwise. */
export function plantUmlSourceFromPre(child: unknown): string | null {
  return fenceSourceFromPre(child, PLANTUML_LANGUAGE)
}
