// The device a browser tab shows its page as. A desktop tab's page fills the
// pane, as it always has; a tablet, a phone or a custom device lays its page
// out in that device's viewport, shown in a frame of the device's
// proportions, so a page's responsive layout can be looked at without
// leaving the workspace.
//
// Only the viewport is emulated: the page keeps the engine's own user agent,
// pointer and touch support. That is what a responsive layout answers to —
// its media queries ask for a width — and it keeps the identity a bot check
// sees matching the engine that sent it (see `profile.rs` on the backend).

/** The kinds of device, as the device menu lists them. */
export type BrowserDevice = "desktop" | "tablet" | "phone" | "custom"

/** The devices of a fixed size, picked by name. */
export type PresetBrowserDevice = "tablet" | "phone"

/** In the order the device menu lists them. */
export const BROWSER_DEVICES: readonly BrowserDevice[] = [
  "desktop",
  "tablet",
  "phone",
  "custom",
]

export interface ViewportSize {
  width: number
  height: number
}

/**
 * The device a tab record says it emulates: a tablet or a phone by name, or a
 * custom device by its viewport — whole CSS pixels within
 * `CUSTOM_VIEWPORT_RANGE`. The desktop is the absence of one.
 */
export type EmulatedBrowserDevice = PresetBrowserDevice | ViewportSize

/**
 * The CSS viewport each preset device lays its page out in, portrait.
 *
 * The tablet is the classic iPad / iPad mini: 768 is where every CSS
 * framework's "tablet" breakpoint begins (Tailwind `md`, Bootstrap `md`), so
 * a tablet that is any narrower would show a phone layout. The phone is the
 * iPhone 12–16's, today's most common phone viewport.
 */
export const DEVICE_VIEWPORTS: Readonly<
  Record<PresetBrowserDevice, ViewportSize>
> = {
  tablet: { width: 768, height: 1024 },
  phone: { width: 390, height: 844 },
}

/** The least and the most a custom device's width or height may be, in CSS
 *  pixels: what the backend sizes a page's own window to, so a size that is
 *  framed in a pane can also be a window's. */
export const CUSTOM_VIEWPORT_RANGE = { min: 100, max: 8192 } as const

/** Where "Custom" starts before anyone has typed a size: a small laptop's
 *  viewport, the narrowest a desktop layout is usually built for (Tailwind
 *  `xl`). */
export const DEFAULT_CUSTOM_VIEWPORT: Readonly<ViewportSize> = Object.freeze({
  width: 1280,
  height: 800,
})

export function isBrowserDevice(value: unknown): value is BrowserDevice {
  return (
    value === "desktop" || value === "custom" || isPresetBrowserDevice(value)
  )
}

export function isPresetBrowserDevice(
  value: unknown
): value is PresetBrowserDevice {
  return value === "tablet" || value === "phone"
}

function isCustomLength(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= CUSTOM_VIEWPORT_RANGE.min &&
    value <= CUSTOM_VIEWPORT_RANGE.max
  )
}

/** Whether `value` is a size a custom device can have. */
export function isCustomViewport(value: unknown): value is ViewportSize {
  if (!value || typeof value !== "object") return false
  const { width, height } = value as Record<string, unknown>
  return isCustomLength(width) && isCustomLength(height)
}

/** `length` (a width or a height) as a custom device can have it: whole, and
 *  held to the range. */
export function clampCustomLength(length: number): number {
  const whole = Number.isFinite(length)
    ? Math.round(length)
    : CUSTOM_VIEWPORT_RANGE.min
  return Math.min(
    CUSTOM_VIEWPORT_RANGE.max,
    Math.max(CUSTOM_VIEWPORT_RANGE.min, whole)
  )
}

/** `value` as a tab record keeps a device — a custom one as its two lengths
 *  and nothing else — or `undefined` for anything that is not one (the
 *  desktop, a device this build does not know, a size out of range). */
export function parseEmulatedBrowserDevice(
  value: unknown
): EmulatedBrowserDevice | undefined {
  if (isPresetBrowserDevice(value)) return value
  if (isCustomViewport(value)) {
    return { width: value.width, height: value.height }
  }
  return undefined
}

/** The kind of device `device` is: the desktop when there is none. */
export function browserDeviceKind(
  device: EmulatedBrowserDevice | undefined
): BrowserDevice {
  if (isPresetBrowserDevice(device)) return device
  return isCustomViewport(device) ? "custom" : "desktop"
}

/** The device a tab record says it emulates: the desktop when it says none,
 *  which is every tab until someone picks another. */
export function browserTabDevice(seed: {
  device?: EmulatedBrowserDevice
}): BrowserDevice {
  return browserDeviceKind(seed.device)
}

/** The viewport `device` lays a page out in; `null` for the desktop, whose
 *  page simply fills the pane. */
export function emulatedViewport(
  device: EmulatedBrowserDevice | undefined
): ViewportSize | null {
  if (isPresetBrowserDevice(device)) return DEVICE_VIEWPORTS[device]
  return isCustomViewport(device) ? device : null
}

/** A string that changes exactly when the device does: "" for the desktop,
 *  the name of a preset, `1280x800` for a custom device. */
export function browserDeviceKey(
  device: EmulatedBrowserDevice | undefined
): string {
  if (isPresetBrowserDevice(device)) return device
  return isCustomViewport(device) ? `${device.width}x${device.height}` : ""
}

export function sameBrowserDevice(
  a: EmulatedBrowserDevice | undefined,
  b: EmulatedBrowserDevice | undefined
): boolean {
  return browserDeviceKey(a) === browserDeviceKey(b)
}

/** The least page zoom an engine takes: Chromium (WebView2) holds its zoom to
 *  25%–500%, and the backend holds WebKit to the same. */
export const MIN_PAGE_ZOOM = 0.25

/**
 * How far past the device's width a zoomed page is meant to land, in CSS
 * pixels. Engines keep their zoom in single-precision floats, so a page
 * zoomed to exactly 768 can come out at 767.9999 — and then `min-width:
 * 768px` is false and a tablet shows its phone layout. A sliver over is read
 * as the device's width by everything that rounds (`innerWidth`, layout
 * units) and never trips a `min-width` breakpoint the device itself meets.
 */
const VIEWPORT_WIDTH_SLACK = 0.01

/** A device's frame as fitted into the space a pane has for it. */
export interface DeviceFrame {
  /** The frame's size on screen, in this document's CSS pixels. */
  width: number
  height: number
  /** Frame width over the device's: how far the frame is shrunk (≤ 1). */
  scale: number
  /** The page zoom that makes a native surface of `width` lay its page out
   *  at the device's width (1 while the device fits as it is). */
  zoom: number
  /** The viewport the page is laid out in: the device's own, unless the
   *  frame is shrunk past the least zoom allowed — then a smaller one, of the
   *  device's proportions. */
  layout: ViewportSize
}

const NO_FRAME: DeviceFrame = Object.freeze({
  width: 0,
  height: 0,
  scale: 0,
  zoom: 1,
  layout: Object.freeze({ width: 0, height: 0 }),
})

/**
 * Fit `viewport` into `available`, never enlarged: at its own size when it
 * fits, otherwise shrunk whole to the largest size that does.
 *
 * A shrunk frame shows its page zoomed out by the same factor, which is what
 * keeps the page laid out at the device's width rather than the frame's. That
 * width has to come out exact, so the frame is snapped to what the engine
 * will really be given: a whole number of CSS pixels (WebKit sizes its view
 * in whole points), and the zoom worked out from the width in device pixels
 * the platform rounds it to (`devicePixelRatio` — a Windows display at 125%
 * turns 309 pixels into 386.25 and draws 386). A frame at the device's own
 * size is no exception: at 140% a 768-pixel tablet is drawn 1075 pixels wide,
 * 767.86 CSS pixels, and needs the same correction to stay a tablet.
 *
 * The height follows from the zoom: the fewest whole CSS pixels the platform
 * still draws at least the device's height tall. Rounded up to device
 * pixels, the width can come out a sliver wider than the slot's height leaves
 * room for at the zoom it then needs; the frame is made a pixel narrower
 * until it fits, which the zoom makes up for. Only where that would take the
 * zoom past what the engines allow is the page left a little shorter than
 * the device.
 *
 * `minZoom` is the least zoom the page can be given: an engine's
 * (`MIN_PAGE_ZOOM`) for a native surface, none (0) for a frame element
 * scaled by a transform — which is laid out at the device's own size
 * whatever its frame, so its `layout` is always the device's.
 */
export function fitDeviceFrame(
  viewport: ViewportSize,
  available: ViewportSize,
  devicePixelRatio = 1,
  minZoom = MIN_PAGE_ZOOM
): DeviceFrame {
  // No room for even one pixel (a pane that is collapsed, or not laid out
  // yet): nothing to show, rather than a frame larger than its room.
  if (!(available.width >= 1) || !(available.height >= 1)) return NO_FRAME
  const fit = Math.min(
    1,
    available.width / viewport.width,
    available.height / viewport.height
  )
  if (!(fit > 0)) return NO_FRAME
  const dpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1
  const floor = Math.max(0, minZoom)
  const room = Math.floor(available.height)
  // What a frame `width` wide needs to lay its page out at the device's
  // width; a device drawn whole at its own size needs nothing.
  const zoomFor = (width: number) => {
    const drawnWidth = Math.round(width * dpr) / dpr
    return fit >= 1 && drawnWidth >= viewport.width
      ? 1
      : Math.min(1, drawnWidth / (viewport.width + VIEWPORT_WIDTH_SLACK))
  }
  const heightFor = (zoom: number) => {
    const height = Math.ceil(viewport.height * zoom - 1e-9)
    return laidOut(height, dpr, zoom) < viewport.height ? height + 1 : height
  }
  let width =
    fit >= 1 ? viewport.width : Math.max(1, Math.floor(viewport.width * fit))
  let needed = zoomFor(width)
  // Narrower than one device pixel (a page zoomed far out in a browser has a
  // ratio well under 1): nothing would be drawn at all.
  if (!(needed > 0)) return NO_FRAME
  while (needed >= floor && heightFor(needed) > room && width > 1) {
    const narrower = zoomFor(width - 1)
    if (!(narrower > 0) || narrower < floor) break
    width -= 1
    needed = narrower
  }
  const zoom = Math.max(floor, needed)
  const tooSmall = needed < floor
  const height = Math.max(
    1,
    Math.min(
      // Shrunk past what an engine will zoom: the page lays out narrower
      // than the device whatever happens, so the frame at least keeps its
      // shape.
      tooSmall
        ? Math.round((viewport.height * width) / viewport.width)
        : heightFor(zoom),
      room
    )
  )
  let layout = viewport
  if (floor > 0) {
    // Rounded down: a page a fraction of a pixel short of a length does not
    // meet a `min-width` (or `min-height`) of it, so it is not that long.
    const laidOutHeight = Math.floor(laidOut(height, dpr, zoom) + 1e-6)
    if (tooSmall) {
      layout = {
        width: Math.floor(laidOut(width, dpr, zoom) + 1e-6),
        height: laidOutHeight,
      }
    } else if (laidOutHeight < viewport.height) {
      layout = { width: viewport.width, height: laidOutHeight }
    }
  }
  return { width, height, scale: width / viewport.width, zoom, layout }
}

/** The CSS pixels a page zoomed by `zoom` gets from `length` CSS pixels of
 *  this document, once the platform has rounded them to device pixels. */
function laidOut(length: number, dpr: number, zoom: number): number {
  return Math.round(length * dpr) / (dpr * zoom)
}
