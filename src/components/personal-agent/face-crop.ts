/**
 * The arithmetic of framing a picture in the round window of the face
 * editor's upload page: the picture always covers the window — at zoom 1
 * its shorter side just fills it — and is moved and zoomed under it, the
 * point in the middle of the window staying put as it zooms.
 */

import type { AvatarCrop } from "@/lib/assistant-avatar"

export const ZOOM_MIN = 1
export const ZOOM_MAX = 4

/** Where the picture is under a window `view` px wide: zoomed by `zoom`,
 *  its top left corner at (`x`, `y`) from the window's (zero or less). */
export interface Framing {
  zoom: number
  x: number
  y: number
}

/** The picture's scale, its pixels to the window's, at `zoom`. */
export function scaleAt(
  view: number,
  width: number,
  height: number,
  zoom: number
): number {
  return (view / Math.min(width, height)) * zoom
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** `f` held so the picture still covers the window. */
export function clampFraming(
  view: number,
  width: number,
  height: number,
  f: Framing
): Framing {
  const zoom = clamp(f.zoom, ZOOM_MIN, ZOOM_MAX)
  const s = scaleAt(view, width, height, zoom)
  return {
    zoom,
    x: clamp(f.x, view - width * s, 0),
    y: clamp(f.y, view - height * s, 0),
  }
}

/** The picture in the middle of the window, its shorter side filling it. */
export function centered(view: number, width: number, height: number): Framing {
  const s = scaleAt(view, width, height, ZOOM_MIN)
  return {
    zoom: ZOOM_MIN,
    x: (view - width * s) / 2,
    y: (view - height * s) / 2,
  }
}

/** `f` zoomed to `zoom`, the middle of the window kept where it is. */
export function zoomTo(
  view: number,
  width: number,
  height: number,
  f: Framing,
  zoom: number
): Framing {
  const from = scaleAt(view, width, height, f.zoom)
  const next = clamp(zoom, ZOOM_MIN, ZOOM_MAX)
  const to = scaleAt(view, width, height, next)
  // The picture's point under the middle of the window, in its pixels.
  const cx = (view / 2 - f.x) / from
  const cy = (view / 2 - f.y) / from
  return clampFraming(view, width, height, {
    zoom: next,
    x: view / 2 - cx * to,
    y: view / 2 - cy * to,
  })
}

/** What the window shows of the picture, in its own pixels. */
export function cropOf(
  view: number,
  width: number,
  height: number,
  f: Framing
): AvatarCrop {
  const s = scaleAt(view, width, height, f.zoom)
  const side = Math.min(view / s, width, height)
  return {
    x: clamp(-f.x / s, 0, width - side),
    y: clamp(-f.y / s, 0, height - side),
    side,
  }
}
