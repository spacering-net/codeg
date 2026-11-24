export type AddToChatPillPlacement = "above" | "below"

/** Everything {@link getAddToChatPillPlacement} needs, in editor-viewport px. */
export interface AddToChatPillGeometry {
  /**
   * Top edge of the editor viewport to the top of the anchor line — Monaco's
   * own `anchor.top`, i.e. `getTopForPosition(line, col) - getScrollTop()`.
   * Negative once the anchor scrolls above the viewport. `null` when it cannot
   * be read (no model), which keeps the pre-existing ABOVE-first order.
   */
  spaceAbovePx: number | null
  /**
   * Bottom of the anchor line to the bottom edge of the editor viewport —
   * Monaco's `heightAvailableUnderLine`, i.e.
   * `getLayoutInfo().height - (spaceAbovePx + lineHeightPx)`.
   */
  spaceBelowPx: number
  /** Height of the anchor line — Monaco's `anchor.height`. */
  lineHeightPx: number
  /** Rendered height of the pill. */
  pillHeightPx: number
}

/**
 * Orders the placement preferences Monaco walks for the "Add to Chat" pill, or
 * returns an empty list to mean "do not place it at all".
 *
 * The pill is an `allowEditorOverflow` content widget — it has to be, or the
 * editor's own scrollbars paint over it near the right edge. But that flag also
 * switches Monaco from `_layoutBoxInViewport` to `_layoutBoxInPage`, which asks
 * whether the widget fits above/below the anchor *in the page* rather than *in
 * the editor viewport*. Every pixel the surrounding app chrome occupies — tab
 * strip, file path bar, terminal panel — then reads as free space, so ABOVE
 * always "fits" and the pill renders past the editor's edge, behind that chrome.
 *
 * So re-run the test Monaco applies to non-overflowing widgets against the
 * editor viewport, and hand back the answer `_layoutBoxInViewport` would have
 * produced. Monaco still owns the final decision; this only reorders the list it
 * walks.
 *
 * Monaco's third option, EXACT, is deliberately not used. It is the only
 * preference that can never leave the viewport vertically, which makes it look
 * like the obvious last resort — but for an overflowing widget its coordinate is
 * `anchor.left + contentLeft` with no `scrollLeft` term and no horizontal clamp
 * (`_prepareRenderWidgetAtExactPositionOverflowing`, versus the
 * `anchor.left - ctx.scrollLeft + contentLeft` that `_layoutBoxInPage` uses), so
 * in a horizontally scrolled editor it throws the pill clean outside the editor.
 * When neither side can seat the pill, lose the fewest pixels instead.
 */
export function getAddToChatPillPlacement({
  spaceAbovePx,
  spaceBelowPx,
  lineHeightPx,
  pillHeightPx,
}: AddToChatPillGeometry): AddToChatPillPlacement[] {
  if (spaceAbovePx === null) {
    return ["above", "below"]
  }
  // The anchor line is wholly out of sight — scrolled past, or left behind when
  // the editor was dragged short. Monaco still renders widgets a little beyond
  // the viewport, and from out there BOTH placements land outside the editor
  // (that is how a selection below a shrunken editor put the pill behind the
  // terminal panel). A pill pointing at an invisible line has nothing to say,
  // so withhold it until the anchor scrolls back.
  if (spaceAbovePx <= -lineHeightPx || spaceBelowPx <= -lineHeightPx) {
    return []
  }
  if (spaceAbovePx >= pillHeightPx) {
    return ["above", "below"]
  }
  if (spaceBelowPx >= pillHeightPx) {
    return ["below", "above"]
  }
  // Editor dragged shorter than one pill plus one line: pick the roomier side.
  return spaceAbovePx >= spaceBelowPx ? ["above", "below"] : ["below", "above"]
}
