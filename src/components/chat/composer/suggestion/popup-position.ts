/**
 * The bounding rect the panel hangs off, in viewport coordinates (the subset we
 * need) — a text caret for the `@` panel, the composer box for the `/` one.
 */
export interface AnchorRect {
  left: number
  top: number
  bottom: number
}

export interface PopupSize {
  width: number
  height: number
}

export interface Viewport {
  width: number
  height: number
  /**
   * Client-coordinate origin of the visible band. Zero on a desktop window; on
   * a phone with the on-screen keyboard up (or under pinch-zoom) the visual
   * viewport is a window onto the layout viewport, and this is where it starts.
   * Both `getBoundingClientRect` and `position: fixed` resolve against the
   * LAYOUT viewport, so the panel's coordinates stay layout-relative and it is
   * the band — not the panel — that moves. Defaults to 0/0.
   */
  left?: number
  top?: number
}

export type PopupPlacement = "above" | "below"

export interface PopupPosition {
  /** Viewport x for the panel's left edge. */
  left: number
  /** Viewport y for the panel's top edge. */
  top: number
  /** Which side of the anchor the panel landed on. */
  placement: PopupPlacement
}

export interface PlaceAnchoredPopupOptions {
  /** Padding kept between the panel and each viewport edge. Default 8. */
  margin?: number
  /** Gap between the anchor and the panel's near edge. Default 4. */
  gap?: number
  /**
   * Which side to try first. Default `above`, for a composer that hugs the
   * bottom of the window; `below` suits a panel that hangs under an input
   * sitting mid-form, where dropping down is the resting look.
   */
  prefer?: PopupPlacement
}

const DEFAULT_MARGIN = 8
const DEFAULT_GAP = 4

function clamp(value: number, min: number, max: number): number {
  // A degenerate band (panel larger than the space between the margins) makes
  // max < min; pin to min (the leading margin) rather than returning NaN-ish
  // ordering. The panel then overflows the far edge but scrolls internally.
  if (max < min) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * Compute a viewport-clamped position for a popup anchored to a rect — the
 * caret for the `@` mention panel, the composer box for the `/` command one.
 *
 * Pure (no DOM access) so it is unit-testable; the component measures the panel
 * and the viewport, then calls this.
 *
 * The panels that use this are positioned against the VIEWPORT (fixed, and
 * portalled out of the tree) rather than laid out beside their anchor, which is
 * the whole point: an in-flow popup inside a scrollable dialog or form is
 * clipped by it, and no amount of z-index helps.
 *
 * - **Horizontal**: the panel's left edge follows the anchor but is clamped so
 *   the whole panel stays within `margin` of both viewport edges.
 * - **Vertical**: the panel tries `options.prefer` first, flips to the other
 *   side when that one has no room, and falls back to whichever side has more
 *   room when neither fully fits — always clamped so the panel never leaves the
 *   viewport.
 * - **No anchor** (rare IME states where `clientRect` is null): pin to the
 *   top-left corner, still clamped.
 *
 * "Viewport" here is the VISIBLE band ({@link readViewport}), not the window:
 * on a phone the on-screen keyboard covers the bottom of the layout viewport
 * without shrinking `window.innerHeight`, so measuring the window would happily
 * park the panel behind the keyboard.
 */
export function placeAnchoredPopup(
  anchor: AnchorRect | null,
  size: PopupSize,
  viewport: Viewport,
  options: PlaceAnchoredPopupOptions = {}
): PopupPosition {
  const margin = options.margin ?? DEFAULT_MARGIN
  const gap = options.gap ?? DEFAULT_GAP
  const prefer = options.prefer ?? "above"
  const viewLeft = viewport.left ?? 0
  const viewTop = viewport.top ?? 0
  const viewRight = viewLeft + viewport.width
  const viewBottom = viewTop + viewport.height

  if (!anchor) {
    return {
      left: viewLeft + margin,
      top: viewTop + margin,
      placement: "below",
    }
  }

  const left = clamp(
    anchor.left,
    viewLeft + margin,
    viewRight - size.width - margin
  )

  const roomAbove = anchor.top - viewTop - margin
  const roomBelow = viewBottom - anchor.bottom - margin
  const needed = size.height + gap
  const other: PopupPlacement = prefer === "above" ? "below" : "above"
  const roomFor = (side: PopupPlacement) =>
    side === "above" ? roomAbove : roomBelow

  let placement: PopupPlacement
  if (roomFor(prefer) >= needed) placement = prefer
  else if (roomFor(other) >= needed) placement = other
  // Neither side fully fits: take the side with more room.
  else placement = roomAbove >= roomBelow ? "above" : "below"

  const rawTop =
    placement === "above" ? anchor.top - gap - size.height : anchor.bottom + gap
  // Final clamp so even the "more room" fallback can't leave the viewport.
  const top = clamp(rawTop, viewTop + margin, viewBottom - size.height - margin)

  return { left, top, placement }
}

/**
 * Measure the band the panel must stay inside, in client coordinates.
 *
 * `window.innerWidth/Height` is the LAYOUT viewport. On a phone that is the
 * wrong box twice over: the on-screen keyboard can cover its bottom third
 * without changing `innerHeight` at all (iOS never resizes the layout viewport
 * for the keyboard; Android's behaviour depends on the page's
 * `interactive-widget` setting, which this app leaves at the platform default),
 * and a pinch-zoom — or the keyboard scrolling a focused field into view —
 * shifts the visible band down inside it. `visualViewport` reports both, the
 * size of what the user can actually see and where it sits, so a panel clamped
 * against it lands above the keyboard instead of under it.
 *
 * The offsets are what keeps this correct for a `position: fixed` panel: fixed
 * placement and `getBoundingClientRect` are both layout-viewport relative, so
 * the band moves and the coordinate space does not. That holds for the case
 * this targets — the keyboard, at scale 1, where the offset comes from the
 * browser scrolling the focused field into view. Under an active pinch-zoom
 * WebKit's fixed-element/client-rect alignment is famously not exact, so treat
 * the panel's placement there as best-effort rather than pixel-true.
 *
 * Falls back to the window where `visualViewport` is missing (jsdom, older
 * WebViews), which is the old behaviour exactly.
 */
export function readViewport(): Viewport {
  const visual =
    typeof window !== "undefined" ? (window.visualViewport ?? null) : null
  if (visual) {
    return {
      width: visual.width,
      height: visual.height,
      left: visual.offsetLeft,
      top: visual.offsetTop,
    }
  }
  return { width: window.innerWidth, height: window.innerHeight }
}
