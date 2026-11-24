import { describe, expect, it } from "vitest"

import {
  BROWSER_DEVICES,
  CUSTOM_VIEWPORT_RANGE,
  DEVICE_VIEWPORTS,
  MIN_PAGE_ZOOM,
  browserDeviceKey,
  browserTabDevice,
  clampCustomLength,
  emulatedViewport,
  fitDeviceFrame,
  isBrowserDevice,
  isCustomViewport,
  parseEmulatedBrowserDevice,
  sameBrowserDevice,
} from "./browser-device"

/** The CSS width a native surface of `frame.width` lays its page out at, as
 *  the engine works it out: the device pixels the platform rounds the frame
 *  to, over the device pixels one zoomed CSS pixel takes. */
function laidOutWidth(
  frame: { width: number; zoom: number },
  devicePixelRatio: number
): number {
  return (
    Math.round(frame.width * devicePixelRatio) / (devicePixelRatio * frame.zoom)
  )
}

describe("browser devices", () => {
  it("knows the four kinds of device, desktop first", () => {
    expect(BROWSER_DEVICES).toEqual(["desktop", "tablet", "phone", "custom"])
    expect(BROWSER_DEVICES.every(isBrowserDevice)).toBe(true)
    expect(isBrowserDevice("watch")).toBe(false)
  })

  it("keeps a preset by name and a custom device as its two lengths", () => {
    expect(parseEmulatedBrowserDevice("phone")).toBe("phone")
    expect(parseEmulatedBrowserDevice("tablet")).toBe("tablet")
    const typed = { width: 1440, height: 900, label: "laptop" }
    const kept = parseEmulatedBrowserDevice(typed)
    expect(kept).toEqual({ width: 1440, height: 900 })
    expect(kept).not.toBe(typed)
    // The desktop is no device; neither is anything this build cannot show.
    for (const value of [
      "desktop",
      "custom",
      "watch",
      undefined,
      null,
      2,
      [1440, 900],
      { width: 1440 },
      { width: 1440.5, height: 900 },
      { width: "1440", height: 900 },
      { width: CUSTOM_VIEWPORT_RANGE.min - 1, height: 900 },
      { width: 1440, height: CUSTOM_VIEWPORT_RANGE.max + 1 },
      { width: Number.NaN, height: 900 },
    ]) {
      expect(parseEmulatedBrowserDevice(value)).toBeUndefined()
    }
    expect(
      isCustomViewport({
        width: CUSTOM_VIEWPORT_RANGE.min,
        height: CUSTOM_VIEWPORT_RANGE.max,
      })
    ).toBe(true)
  })

  it("gives the desktop no viewport of its own, and a custom device its own", () => {
    expect(emulatedViewport(undefined)).toBeNull()
    expect(emulatedViewport("tablet")).toEqual({ width: 768, height: 1024 })
    expect(emulatedViewport("phone")).toEqual({ width: 390, height: 844 })
    const custom = { width: 1440, height: 900 }
    expect(emulatedViewport(custom)).toBe(custom)
  })

  it("reads a record without a device as a desktop", () => {
    expect(browserTabDevice({})).toBe("desktop")
    expect(browserTabDevice({ device: "phone" })).toBe("phone")
    expect(browserTabDevice({ device: { width: 1440, height: 900 } })).toBe(
      "custom"
    )
    // A record from somewhere that wrote nonsense is a desktop too.
    expect(browserTabDevice({ device: "watch" as unknown as "phone" })).toBe(
      "desktop"
    )
    expect(browserTabDevice({ device: { width: 20, height: 20 } })).toBe(
      "desktop"
    )
  })

  it("tells two devices apart by what they show, not by identity", () => {
    expect(browserDeviceKey(undefined)).toBe("")
    expect(browserDeviceKey("tablet")).toBe("tablet")
    expect(browserDeviceKey({ width: 1440, height: 900 })).toBe("1440x900")
    expect(
      sameBrowserDevice(
        { width: 1440, height: 900 },
        { width: 1440, height: 900 }
      )
    ).toBe(true)
    expect(
      sameBrowserDevice(
        { width: 1440, height: 900 },
        { width: 900, height: 1440 }
      )
    ).toBe(false)
    expect(sameBrowserDevice("phone", undefined)).toBe(false)
    expect(sameBrowserDevice(undefined, undefined)).toBe(true)
  })

  it("holds a typed length to what a custom device can be", () => {
    expect(clampCustomLength(1280)).toBe(1280)
    expect(clampCustomLength(1280.6)).toBe(1281)
    expect(clampCustomLength(0)).toBe(CUSTOM_VIEWPORT_RANGE.min)
    expect(clampCustomLength(99_999)).toBe(CUSTOM_VIEWPORT_RANGE.max)
    expect(clampCustomLength(Number.NaN)).toBe(CUSTOM_VIEWPORT_RANGE.min)
  })
})

describe("fitDeviceFrame", () => {
  const phone = DEVICE_VIEWPORTS.phone
  const tablet = DEVICE_VIEWPORTS.tablet

  it("shows a device that fits at its own size, unzoomed", () => {
    expect(fitDeviceFrame(phone, { width: 1200, height: 900 })).toEqual({
      width: 390,
      height: 844,
      scale: 1,
      zoom: 1,
      layout: phone,
    })
    // Exactly as much room as the device needs is enough.
    expect(fitDeviceFrame(phone, { width: 390, height: 844 }).zoom).toBe(1)
  })

  it("shrinks a device that does not fit, keeping its proportions", () => {
    const frame = fitDeviceFrame(tablet, { width: 900, height: 600 })
    // Height-bound: 600 / 1024 of the tablet.
    expect(frame.width).toBe(450)
    expect(frame.height).toBe(600)
    expect(frame.scale).toBeCloseTo(450 / 768)
    expect(frame.width).toBeLessThanOrEqual(900)
    expect(frame.height).toBeLessThanOrEqual(600)
  })

  it("lays a shrunk page out at the device's width, never a pixel short", () => {
    // The tablet is the one where a pixel matters: at 767 a page's `md`
    // breakpoint is off and the tablet shows the phone layout.
    for (const devicePixelRatio of [1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
      for (let height = 260; height < 1024; height += 7) {
        for (const viewport of [tablet, phone]) {
          const frame = fitDeviceFrame(
            viewport,
            { width: 2000, height },
            devicePixelRatio
          )
          if (frame.zoom === MIN_PAGE_ZOOM) continue
          const width = laidOutWidth(frame, devicePixelRatio)
          expect(width).toBeGreaterThanOrEqual(viewport.width)
          expect(width).toBeLessThan(viewport.width + 0.5)
          // The height too, the frame a pixel narrower where the width's
          // rounding would have asked for more height than the slot has.
          const laidOutHeight =
            Math.round(frame.height * devicePixelRatio) /
            (devicePixelRatio * frame.zoom)
          expect(frame.layout).toBe(viewport)
          expect(laidOutHeight).toBeGreaterThanOrEqual(viewport.height)
          // Over by at most the one frame pixel it was rounded up by, which
          // a small zoom makes several of the page's.
          expect(laidOutHeight).toBeLessThan(viewport.height + 1.5 / frame.zoom)
          expect(frame.height).toBeLessThanOrEqual(height)
          // Whole CSS pixels, so WebKit's whole-point view is the frame.
          expect(Number.isInteger(frame.width)).toBe(true)
        }
      }
    }
  })

  // The same promise for a size of the person's own: any width they type is
  // the width the page gets, shrunk or not, while the engines can zoom that
  // far — and the frame says so (`layout`) when they cannot.
  it("lays a custom device's page out at its own width, never a pixel short", () => {
    const customs = [
      { width: 100, height: 100 },
      { width: 320, height: 568 },
      { width: 412, height: 915 },
      { width: 1024, height: 768 },
      { width: 1280, height: 800 },
      { width: 1366, height: 768 },
      { width: 1920, height: 1080 },
      { width: 2560, height: 1440 },
      { width: 1280, height: 4000 },
      { width: 8192, height: 8192 },
    ]
    for (const devicePixelRatio of [1, 1.25, 1.4, 1.5, 2, 3]) {
      for (const available of [
        { width: 640, height: 480 },
        { width: 913.5, height: 601.25 },
        { width: 1440, height: 900 },
        { width: 3000, height: 2000 },
      ]) {
        for (const viewport of customs) {
          const frame = fitDeviceFrame(viewport, available, devicePixelRatio)
          expect(frame.width).toBeLessThanOrEqual(available.width)
          expect(frame.height).toBeLessThanOrEqual(available.height)
          expect(Number.isInteger(frame.width)).toBe(true)
          const width = laidOutWidth(frame, devicePixelRatio)
          const height =
            Math.round(frame.height * devicePixelRatio) /
            (devicePixelRatio * frame.zoom)
          const short =
            frame.layout.width !== viewport.width ||
            frame.layout.height !== viewport.height
          if (!short) {
            expect(width).toBeGreaterThanOrEqual(viewport.width)
            expect(width).toBeLessThan(viewport.width + 0.5)
            expect(height).toBeGreaterThanOrEqual(viewport.height)
          } else {
            // The page is smaller than the device, and `layout` says how
            // much — never more than it really is.
            expect(width).toBeGreaterThanOrEqual(frame.layout.width - 1e-6)
            expect(width).toBeLessThan(frame.layout.width + 1)
            expect(height).toBeGreaterThanOrEqual(frame.layout.height - 1e-6)
            expect(height).toBeLessThan(frame.layout.height + 1)
            expect(frame.layout.width).toBeLessThanOrEqual(viewport.width)
            expect(frame.layout.height).toBeLessThanOrEqual(viewport.height)
          }
        }
      }
    }
  })

  // A device at its own size is drawn at whatever the display rounds it to:
  // at 140% a 768-pixel tablet is 1075 device pixels, 767.86 CSS pixels —
  // and `min-width: 768px` is off unless the page is zoomed to make it up.
  it("keeps a device drawn at its own size at its width on any display", () => {
    for (const devicePixelRatio of [1, 1.1, 1.25, 1.4, 1.5, 1.75, 2, 2.25]) {
      for (const viewport of [tablet, phone]) {
        const frame = fitDeviceFrame(
          viewport,
          { width: 3000, height: 2000 },
          devicePixelRatio
        )
        expect(frame.width).toBe(viewport.width)
        expect(laidOutWidth(frame, devicePixelRatio)).toBeGreaterThanOrEqual(
          viewport.width
        )
        expect(laidOutWidth(frame, devicePixelRatio)).toBeLessThan(
          viewport.width + 0.5
        )
      }
    }
    // Drawn whole, it needs no zoom at all.
    expect(
      fitDeviceFrame(tablet, { width: 3000, height: 2000 }, 1.25).zoom
    ).toBe(1)
    expect(
      fitDeviceFrame(tablet, { width: 3000, height: 2000 }, 1.4).zoom
    ).toBeLessThan(1)
  })

  it("lays the page out narrower only below the engines' least zoom, keeps the frame's shape, and says at what size", () => {
    const frame = fitDeviceFrame(tablet, { width: 120, height: 2000 })
    expect(frame.zoom).toBe(MIN_PAGE_ZOOM)
    expect(laidOutWidth(frame, 1)).toBeLessThan(tablet.width)
    // 120 wide is 160 tall in a tablet's proportions.
    expect(frame).toMatchObject({ width: 120, height: 160 })
    expect(frame.layout).toEqual({ width: 480, height: 640 })
    // A tall custom device is cut down the same way, its width with it.
    const tall = fitDeviceFrame(
      { width: 1280, height: 4000 },
      { width: 900, height: 600 },
      2
    )
    expect(tall.zoom).toBe(MIN_PAGE_ZOOM)
    expect(tall.layout.width).toBeLessThan(1280)
    expect(tall.layout.width / tall.layout.height).toBeCloseTo(1280 / 4000, 2)
    // Every device the frame does show whole keeps its own viewport.
    expect(fitDeviceFrame(tablet, { width: 900, height: 600 }).layout).toBe(
      tablet
    )
  })

  // At 125% a 450-pixel frame is drawn 450.4 wide, which takes a zoom that
  // needs 601 pixels of height where the slot has 600: one pixel narrower,
  // the tablet is whole in both directions.
  it("narrows the frame a pixel rather than cut the page's height short", () => {
    const frame = fitDeviceFrame(tablet, { width: 900, height: 600.4 }, 1.25)
    expect(frame).toMatchObject({ width: 449, height: 599, layout: tablet })
    expect(
      Math.round(frame.height * 1.25) / (1.25 * frame.zoom)
    ).toBeGreaterThanOrEqual(1024)
  })

  // A frame so narrow that one pixel less is past the least zoom keeps its
  // width, so the page keeps the device's — and says it is shorter.
  it("says so when the page is left shorter than the device", () => {
    const frame = fitDeviceFrame(
      { width: 100, height: 4000 },
      { width: 900, height: 1040 },
      1.25
    )
    expect(frame.width).toBe(26)
    expect(frame.height).toBe(1040)
    expect(frame.zoom).toBeGreaterThan(MIN_PAGE_ZOOM)
    expect(frame.layout).toEqual({ width: 100, height: 3939 })
  })

  // A browser zoomed out to 25% on a plain display has a ratio of 0.25: a
  // frame one CSS pixel wide is a quarter of a device pixel, which is none.
  it("never zooms a page to nothing, however far out the window is zoomed", () => {
    const tall = { width: 100, height: 4000 }
    for (const minZoom of [0, MIN_PAGE_ZOOM]) {
      const frame = fitDeviceFrame(
        tall,
        { width: 900, height: 100 },
        0.25,
        minZoom
      )
      expect(frame.zoom).toBeGreaterThan(0)
      expect(Number.isFinite(frame.layout.width)).toBe(true)
      expect(Number.isFinite(frame.layout.height)).toBe(true)
    }
    // Scaled by a transform, the page is the device's size however thin the
    // frame it is drawn in.
    expect(
      fitDeviceFrame(tall, { width: 900, height: 100 }, 0.25, 0).layout
    ).toBe(tall)
    // Room for less than one device pixel of width: nothing to show.
    expect(
      fitDeviceFrame(
        { width: 100, height: 4000 },
        { width: 900, height: 40 },
        0.25,
        0
      )
    ).toMatchObject({ width: 0, height: 0, zoom: 1 })
  })

  it("goes as small as it has to for a frame scaled by a transform", () => {
    const huge = { width: 3840, height: 2160 }
    const frame = fitDeviceFrame(huge, { width: 700, height: 500 }, 1, 0)
    expect(frame.width).toBe(700)
    expect(frame.zoom).toBeLessThan(MIN_PAGE_ZOOM)
    expect(frame.layout).toBe(huge)
    expect(frame.height).toBeLessThanOrEqual(500)
    expect(frame.height / frame.width).toBeCloseTo(2160 / 3840, 2)
  })

  it("has nothing to show in a pane with no room", () => {
    for (const available of [
      { width: 0, height: 600 },
      { width: 800, height: 0 },
      { width: -40, height: -40 },
      { width: Number.NaN, height: 600 },
      // Room, but not for one whole pixel: no frame bigger than its room.
      { width: 0.5, height: 0.5 },
    ]) {
      expect(fitDeviceFrame(phone, available)).toEqual({
        width: 0,
        height: 0,
        scale: 0,
        zoom: 1,
        layout: { width: 0, height: 0 },
      })
    }
  })

  it("treats a nonsense pixel ratio as 1", () => {
    const sane = fitDeviceFrame(tablet, { width: 900, height: 600 }, 1)
    expect(fitDeviceFrame(tablet, { width: 900, height: 600 }, 0)).toEqual(sane)
    expect(
      fitDeviceFrame(tablet, { width: 900, height: 600 }, Number.NaN)
    ).toEqual(sane)
  })
})
