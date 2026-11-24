// Marking up a screenshot before it goes to a conversation: boxes and arrows,
// drawn by a person over the picture the backend took of the page.
//
// Everything here works in the IMAGE's pixels, never the screen's. The picture
// is shown scaled down to fit a dialog, but what the agent receives is the
// picture at its own size, so that is the only coordinate system a mark can
// live in without drifting when the dialog is resized. One renderer draws both
// the preview and the file that is sent — what the person sees is what goes.
//
// Every mark carries a number, drawn on the picture and repeated in the text
// that goes with it. A person refers to "2" in their message; an agent reading
// the picture and the text can tell which red outline that is and where it
// sits on the page in CSS pixels, which is the unit it would use to find the
// element under it.

import type { CaptureOutcome } from "./types"

export type MarkupTool = "box" | "arrow"

export interface MarkupPoint {
  x: number
  y: number
}

export type MarkupMark =
  | { kind: "box"; x: number; y: number; width: number; height: number }
  | { kind: "arrow"; from: MarkupPoint; to: MarkupPoint }

export interface MarkupSize {
  width: number
  height: number
}

/** What a mark is described against: the picture's size, and the part of the
 *  page it shows. */
export type MarkupCapture = Pick<CaptureOutcome, "width" | "height" | "region">

/** Apple's system red. Marks have to read as "somebody drew this", not as
 *  part of the page — a colour a page rarely uses at full strength. */
export const MARK_COLOR = "#ff3b30"

/** Drawn under every stroke, so a mark stays visible on a red page, a dark
 *  one and a photograph alike. */
const HALO_COLOR = "rgba(255, 255, 255, 0.92)"

const BADGE_TEXT_COLOR = "#ffffff"

/** A drag shorter than this, in the pixels of the preview on screen, is a
 *  click — nobody means to draw a box three pixels wide. */
export const MIN_MARK_SCREEN_PX = 8

/** The most a marked-up picture may weigh before it is sent as JPEG instead.
 *  The same budget the backend holds a capture to (`CAPTURE_MAX_ENCODED_BYTES`
 *  in `browser/capture.rs`): under what a vision model takes for one image.
 *  A browser's PNG encoder is no match for the backend's, so a capture that
 *  only just fitted can come back from the canvas too heavy. */
export const MARKED_IMAGE_MAX_BYTES = 3_500_000

/** The quality the backend uses for JPEG (`CAPTURE_JPEG_QUALITY`). */
const MARKED_JPEG_QUALITY = 0.85

export interface MarkupStyle {
  /** Width of a box's outline and an arrow's shaft. */
  line: number
  /** The white edge drawn under every stroke, on each side of it. */
  halo: number
  /** How far an arrow's head reaches back from its tip. */
  head: number
  /** Radius of a number badge. */
  badge: number
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

/** Stroke sizes for a picture of this size. Proportional to the picture, so
 *  a mark on a narrow capture is not a smear and one on a wide capture is not
 *  a hairline — and bounded both ways, so neither end goes silly. */
export function markupStyle(size: MarkupSize): MarkupStyle {
  const line = clamp(Math.max(size.width, size.height) / 300, 2.5, 10)
  return {
    line,
    halo: Math.max(1.5, line * 0.4),
    head: line * 4.2,
    badge: Math.max(9, line * 2.5),
  }
}

/** The mark a drag from `start` to `end` makes, or null when the drag was too
 *  short to be one (`min`, in image pixels). A box is the same box whichever
 *  corner it was dragged from, and counts once either side reaches `min` — a
 *  long thin box is how a line of text gets underlined; only a drag short in
 *  every direction is a click. An arrow points where the drag ended. */
export function markFromDrag(
  tool: MarkupTool,
  start: MarkupPoint,
  end: MarkupPoint,
  min: number
): MarkupMark | null {
  if (tool === "arrow") {
    const length = Math.hypot(end.x - start.x, end.y - start.y)
    if (length === 0 || length < min) return null
    return { kind: "arrow", from: { ...start }, to: { ...end } }
  }
  const width = Math.abs(end.x - start.x)
  const height = Math.abs(end.y - start.y)
  if (width === 0 || height === 0 || Math.max(width, height) < min) return null
  return {
    kind: "box",
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width,
    height,
  }
}

export interface ArrowGeometry {
  /** Where the shaft stops: the middle of the head's base, so the head
   *  covers the shaft's rounded end and the tip stays a point. */
  shaftEnd: MarkupPoint
  /** The head: tip first, then the two corners of its base. */
  head: [MarkupPoint, MarkupPoint, MarkupPoint]
}

/** An arrow's shaft and head. A short arrow gets a proportionally smaller
 *  head, or the head would be longer than the arrow. */
export function arrowGeometry(
  from: MarkupPoint,
  to: MarkupPoint,
  style: MarkupStyle
): ArrowGeometry {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy) || 1
  const ux = dx / length
  const uy = dy / length
  const head = Math.min(style.head, length * 0.6)
  const half = head * 0.55
  const base = { x: to.x - ux * head, y: to.y - uy * head }
  return {
    shaftEnd: base,
    head: [
      { x: to.x, y: to.y },
      { x: base.x - uy * half, y: base.y + ux * half },
      { x: base.x + uy * half, y: base.y - ux * half },
    ],
  }
}

/** Where a mark's number goes: just outside it, touching it — off a box's
 *  top-left corner, behind an arrow's tail. Never on the mark itself: a badge
 *  is wider than the smallest box or arrow a person can draw, and one sitting
 *  on top would leave a number where the text describes a mark nobody can
 *  see. Pulled inside the picture, so a mark against the edge still shows its
 *  whole number (overlapping the mark there is the lesser loss). */
export function badgeCenter(
  mark: MarkupMark,
  style: MarkupStyle,
  size: MarkupSize
): MarkupPoint {
  const reach = style.badge + style.halo
  let anchor: MarkupPoint
  if (mark.kind === "box") {
    // Out along the diagonal until the badge's edge meets the corner.
    const out = reach * Math.SQRT1_2
    anchor = { x: mark.x - out, y: mark.y - out }
  } else {
    const dx = mark.to.x - mark.from.x
    const dy = mark.to.y - mark.from.y
    const length = Math.hypot(dx, dy) || 1
    anchor = {
      x: mark.from.x - (dx / length) * reach,
      y: mark.from.y - (dy / length) * reach,
    }
  }
  return {
    x: clamp(anchor.x, reach, Math.max(reach, size.width - reach)),
    y: clamp(anchor.y, reach, Math.max(reach, size.height - reach)),
  }
}

/** Where a box's outline is drawn: the box itself, with any side that runs
 *  along the picture's edge pulled in until its whole stroke shows. A stroke
 *  straddles its line, so a box dragged to the edge would otherwise lose half
 *  of that side — the side that says where the box ends. */
export function visibleBox(
  mark: Extract<MarkupMark, { kind: "box" }>,
  style: MarkupStyle,
  size: MarkupSize
): { x: number; y: number; width: number; height: number } {
  const edge = style.line / 2 + style.halo
  const left = Math.max(mark.x, edge)
  const top = Math.max(mark.y, edge)
  const right = Math.min(mark.x + mark.width, size.width - edge)
  const bottom = Math.min(mark.y + mark.height, size.height - edge)
  // Too small to pull in without turning it inside out: draw it as it is.
  if (right - left < 1 || bottom - top < 1) {
    return { x: mark.x, y: mark.y, width: mark.width, height: mark.height }
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function traceShape(
  ctx: CanvasRenderingContext2D,
  mark: MarkupMark,
  style: MarkupStyle,
  size: MarkupSize
): void {
  ctx.beginPath()
  if (mark.kind === "box") {
    const { x, y, width, height } = visibleBox(mark, style, size)
    ctx.rect(x, y, width, height)
    return
  }
  const { shaftEnd } = arrowGeometry(mark.from, mark.to, style)
  ctx.moveTo(mark.from.x, mark.from.y)
  ctx.lineTo(shaftEnd.x, shaftEnd.y)
}

function traceHead(
  ctx: CanvasRenderingContext2D,
  mark: Extract<MarkupMark, { kind: "arrow" }>,
  style: MarkupStyle
): void {
  const [tip, left, right] = arrowGeometry(mark.from, mark.to, style).head
  ctx.beginPath()
  ctx.moveTo(tip.x, tip.y)
  ctx.lineTo(left.x, left.y)
  ctx.lineTo(right.x, right.y)
  ctx.closePath()
}

function drawBadge(
  ctx: CanvasRenderingContext2D,
  label: string,
  center: MarkupPoint,
  style: MarkupStyle
): void {
  ctx.beginPath()
  ctx.arc(center.x, center.y, style.badge + style.halo, 0, Math.PI * 2)
  ctx.fillStyle = HALO_COLOR
  ctx.fill()
  ctx.beginPath()
  ctx.arc(center.x, center.y, style.badge, 0, Math.PI * 2)
  ctx.fillStyle = MARK_COLOR
  ctx.fill()
  // Two digits get a smaller face so they stay inside the circle.
  const face = Math.round(style.badge * (label.length > 1 ? 1 : 1.25))
  ctx.font = `600 ${face}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`
  ctx.fillStyle = BADGE_TEXT_COLOR
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(label, center.x, center.y)
}

/**
 * Draw the picture and its marks. The same call paints the preview and the
 * file that is sent.
 *
 * Three passes rather than one per mark: every white edge first, then every
 * red stroke, then every number. Drawn mark by mark, a later mark's white edge
 * would cut a gap through an earlier mark wherever the two cross, and a later
 * stroke would run over an earlier number.
 */
export function drawMarkup(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  marks: readonly MarkupMark[],
  size: MarkupSize
): void {
  const style = markupStyle(size)
  ctx.clearRect(0, 0, size.width, size.height)
  ctx.drawImage(image, 0, 0, size.width, size.height)
  ctx.lineCap = "round"
  ctx.lineJoin = "round"

  ctx.strokeStyle = HALO_COLOR
  for (const mark of marks) {
    ctx.lineWidth = style.line + style.halo * 2
    traceShape(ctx, mark, style, size)
    ctx.stroke()
    if (mark.kind === "arrow") {
      ctx.lineWidth = style.halo * 2
      traceHead(ctx, mark, style)
      ctx.stroke()
    }
  }

  for (const mark of marks) {
    ctx.strokeStyle = MARK_COLOR
    ctx.lineWidth = style.line
    traceShape(ctx, mark, style, size)
    ctx.stroke()
    if (mark.kind === "arrow") {
      ctx.fillStyle = MARK_COLOR
      traceHead(ctx, mark, style)
      ctx.fill()
    }
  }

  marks.forEach((mark, index) => {
    drawBadge(ctx, String(index + 1), badgeCenter(mark, style, size), style)
  })
}

/**
 * The marks, in words, for the agent: what each numbered mark is and where it
 * sits on the page in CSS pixels — the unit the rest of the screenshot's block
 * is written in, and the one a page is laid out in. Empty when there are none.
 *
 * Nothing in here came from the page: the numbers are the person's marks and
 * the positions are arithmetic, so no page can put words into it. What it
 * does have to say is that the red is not the page's own, or an agent reading
 * the picture would report a red box around the button as a bug in the page.
 */
export function describeMarkup(
  marks: readonly MarkupMark[],
  capture: MarkupCapture
): string {
  if (marks.length === 0) return ""
  const sx = capture.width > 0 ? capture.region.width / capture.width : 1
  const sy = capture.height > 0 ? capture.region.height / capture.height : 1
  const x = (value: number) => Math.round(capture.region.x + value * sx)
  const y = (value: number) => Math.round(capture.region.y + value * sy)
  const count =
    marks.length === 1 ? "1 numbered mark" : `${marks.length} numbered marks`
  const lines = [
    `- markup: the person drew ${count} on this screenshot, in red; the marks are not part of the page`,
  ]
  marks.forEach((mark, index) => {
    const n = index + 1
    if (mark.kind === "box") {
      // Never "0×…": every box has a size, and one thinner than half a CSS
      // pixel (a picture denser than the page) is still there.
      const width = Math.max(1, Math.round(mark.width * sx))
      const height = Math.max(1, Math.round(mark.height * sy))
      lines.push(
        `  ${n}. box: ${width}×${height} CSS px at (${x(mark.x)}, ${y(mark.y)})`
      )
    } else {
      lines.push(
        `  ${n}. arrow: pointing at (${x(mark.to.x)}, ${y(mark.to.y)}) CSS px, from (${x(mark.from.x)}, ${y(mark.from.y)})`
      )
    }
  })
  return `${lines.join("\n")}\n`
}

/** The screenshot's block with its marks described after it — or the block
 *  as it came, when nothing was drawn. */
export function withMarkup(
  text: string,
  marks: readonly MarkupMark[],
  capture: MarkupCapture
): string {
  if (marks.length === 0) return text
  const separator = text === "" || text.endsWith("\n") ? "" : "\n"
  return `${text}${separator}${describeMarkup(marks, capture)}`
}

function encode(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error("the marked-up screenshot could not be encoded"))
      },
      type,
      quality
    )
  })
}

/** The picture with its marks drawn in, at the picture's own size: PNG, or
 *  JPEG when the PNG would be heavier than a vision model takes. */
export async function renderMarkedScreenshot(
  image: CanvasImageSource,
  marks: readonly MarkupMark[],
  size: MarkupSize
): Promise<Blob> {
  const canvas = document.createElement("canvas")
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("the screenshot could not be drawn on")
  drawMarkup(ctx, image, marks, size)
  const png = await encode(canvas, "image/png")
  if (png.size <= MARKED_IMAGE_MAX_BYTES) return png
  return encode(canvas, "image/jpeg", MARKED_JPEG_QUALITY)
}
