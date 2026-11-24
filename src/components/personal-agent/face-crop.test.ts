import { describe, expect, it } from "vitest"

import {
  centered,
  clampFraming,
  cropOf,
  zoomTo,
  ZOOM_MAX,
  ZOOM_MIN,
} from "./face-crop"

describe("framing a picture in the round window", () => {
  it("starts in the middle, its shorter side filling the window", () => {
    // 400×200 in a window of 1: scaled to 2×1, half its overhang each side.
    expect(centered(1, 400, 200)).toEqual({ zoom: 1, x: -0.5, y: 0 })
    expect(cropOf(1, 400, 200, centered(1, 400, 200))).toEqual({
      x: 100,
      y: 0,
      side: 200,
    })
  })

  it("never lets the window show past the picture's edges", () => {
    expect(clampFraming(1, 400, 200, { zoom: 1, x: 0.3, y: 0.3 })).toEqual({
      zoom: 1,
      x: 0,
      y: 0,
    })
    expect(clampFraming(1, 400, 200, { zoom: 1, x: -5, y: -5 })).toEqual({
      zoom: 1,
      x: -1,
      y: 0,
    })
    expect(clampFraming(1, 400, 200, { zoom: 9, x: 0, y: 0 }).zoom).toBe(
      ZOOM_MAX
    )
    expect(clampFraming(1, 400, 200, { zoom: 0.2, x: 0, y: 0 }).zoom).toBe(
      ZOOM_MIN
    )
  })

  it("zooms about the middle of the window, and crops what it shows", () => {
    const f = zoomTo(1, 200, 200, centered(1, 200, 200), 2)
    // The middle stays the middle: a quarter cut off each side.
    expect(f).toEqual({ zoom: 2, x: -0.5, y: -0.5 })
    expect(cropOf(1, 200, 200, f)).toEqual({ x: 50, y: 50, side: 100 })
    // Moved to the corner, then zoomed out: held inside the picture.
    const corner = clampFraming(1, 200, 200, { ...f, x: 0, y: 0 })
    expect(cropOf(1, 200, 200, corner)).toEqual({ x: 0, y: 0, side: 100 })
    expect(zoomTo(1, 200, 200, corner, 1)).toEqual({ zoom: 1, x: 0, y: 0 })
  })
})
