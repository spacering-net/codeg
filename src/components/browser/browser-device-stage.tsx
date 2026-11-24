"use client"

import { TriangleAlert } from "lucide-react"
import { useTranslations } from "next-intl"
import { useLayoutEffect, useRef, useState, type ReactNode } from "react"

import {
  MIN_PAGE_ZOOM,
  browserDeviceKind,
  emulatedViewport,
  fitDeviceFrame,
  type DeviceFrame,
  type EmulatedBrowserDevice,
  type ViewportSize,
} from "@/lib/browser/browser-device"
import { cn } from "@/lib/utils"

import { viewportLabel } from "./browser-device-menu"
import { BrowserDeviceSize } from "./browser-device-size"

// The stage's insets in CSS pixels, mirrored by the classes below. Pixels,
// not rems: the app zooms by its root font size, and the frame is fitted
// with these numbers — a stage whose padding grew with the zoom while the
// sums here did not would push the frame past its edge.
const STAGE_PADDING_PX = 16
const LABEL_HEIGHT_PX = 20
const LABEL_GAP_PX = 8

/** What the stage hands the page it frames. */
export interface DeviceStageFit {
  /** The viewport the page lays out in, while a device is emulated. */
  viewport: ViewportSize | null
  /** The frame on screen, while a device is emulated and the stage has been
   *  measured. */
  frame: DeviceFrame | null
  /** The page zoom a native surface in the frame needs while a device is
   *  emulated; `null` on the desktop, whose page zoom is not ours to set. */
  zoom: number | null
  /** Changes whenever the frame may have moved — see
   *  `NativeSurfaceHostProps.layoutKey`. */
  layoutKey: string
}

interface StageMetrics {
  width: number
  height: number
  devicePixelRatio: number
}

/**
 * The slot a browser tab shows its page in, as the device the tab emulates.
 *
 * The desktop is the slot itself: the page fills it, exactly as it did before
 * there were devices. A tablet, a phone or a custom device is a frame of that
 * device's proportions centred in the slot, under a line saying its size (and
 * how far it is shrunk, when the slot is smaller than the device) — at the
 * device's own size where it fits, shrunk whole where it does not. The page
 * inside is laid out at the device's width either way: a native surface by
 * the zoom this hands it, a frame element by being that size and scaled. A
 * native surface cannot be zoomed out without end (`minZoom`); a device too
 * large for the slot even then lays its page out smaller, and the line says
 * at what size.
 *
 * A custom device's size is edited on that line, given `onCustomSize`.
 *
 * The child is rendered at the same place in the tree whatever the device,
 * so switching devices resizes the page rather than building it again.
 * Emulating one, it waits for the stage's first measurement (one layout pass,
 * before anything is painted): a native surface created before that would be
 * created at the size of the whole slot, then shrink.
 */
export function BrowserDeviceStage({
  device,
  onCustomSize,
  minZoom = MIN_PAGE_ZOOM,
  children,
}: {
  device: "desktop" | EmulatedBrowserDevice
  onCustomSize?: (size: ViewportSize) => void
  /** The least zoom the page can be shown at: an engine's for a native
   *  surface (the default), none for a frame element scaled by a transform. */
  minZoom?: number
  children: (fit: DeviceStageFit) => ReactNode
}) {
  const t = useTranslations("Browser.toolbar")
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [metrics, setMetrics] = useState<StageMetrics | null>(null)

  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    let density: MediaQueryList | null = null
    function read() {
      if (!el) return
      const rect = el.getBoundingClientRect()
      const devicePixelRatio = window.devicePixelRatio || 1
      setMetrics((prev) =>
        prev &&
        prev.width === rect.width &&
        prev.height === rect.height &&
        prev.devicePixelRatio === devicePixelRatio
          ? prev
          : { width: rect.width, height: rect.height, devicePixelRatio }
      )
    }
    // A window moved to a screen of another density keeps every CSS size,
    // so the observer below never hears of it — but the frame is snapped to
    // device pixels, and a resolution query does hear of that.
    function watchDensity() {
      density?.removeEventListener?.("change", onDensityChange)
      density =
        typeof window.matchMedia === "function"
          ? window.matchMedia(
              `(resolution: ${window.devicePixelRatio || 1}dppx)`
            )
          : null
      density?.addEventListener?.("change", onDensityChange)
    }
    function onDensityChange() {
      read()
      watchDensity()
    }
    read()
    watchDensity()
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(read) : null
    observer?.observe(el)
    return () => {
      observer?.disconnect()
      density?.removeEventListener?.("change", onDensityChange)
    }
  }, [])

  const emulated = device === "desktop" ? undefined : device
  const kind = browserDeviceKind(emulated)
  const viewport = emulatedViewport(emulated)
  const frame =
    viewport && metrics
      ? fitDeviceFrame(
          viewport,
          {
            width: metrics.width - 2 * STAGE_PADDING_PX,
            height:
              metrics.height -
              2 * STAGE_PADDING_PX -
              LABEL_HEIGHT_PX -
              LABEL_GAP_PX,
          },
          metrics.devicePixelRatio,
          minZoom
        )
      : null
  const fit: DeviceStageFit = {
    viewport,
    frame,
    zoom: frame ? frame.zoom : null,
    layoutKey: metrics
      ? `${Math.round(metrics.width)}x${Math.round(metrics.height)}:${frame?.width ?? 0}x${frame?.height ?? 0}`
      : "",
  }
  const percent = frame ? Math.round(frame.scale * 100) : 100
  // Laid out at a size other than the device's own: the slot is too small
  // to show the device even at the least zoom there is.
  const shortOf =
    viewport &&
    frame &&
    frame.width > 0 &&
    (frame.layout.width !== viewport.width ||
      frame.layout.height !== viewport.height)
      ? frame.layout
      : null

  return (
    <div
      ref={stageRef}
      data-browser-device-stage={kind}
      className={cn(
        "absolute inset-0",
        viewport &&
          "flex flex-col items-center justify-center gap-[8px] overflow-hidden bg-muted/40 p-[16px]"
      )}
    >
      {emulated && viewport ? (
        <div
          dir="ltr"
          data-browser-device-label=""
          className="flex h-[20px] max-w-full shrink-0 select-none items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums"
        >
          <BrowserDeviceSize device={emulated} onCustomSize={onCustomSize} />
          {frame && percent < 100 ? (
            <span className="shrink-0 text-muted-foreground/70">
              · {percent}%
            </span>
          ) : null}
          {shortOf ? (
            <span
              data-browser-device-short=""
              className="flex min-w-0 items-center gap-1 text-amber-600 dark:text-amber-500"
            >
              <TriangleAlert className="h-3 w-3 shrink-0" />
              {/* A sentence of the person's language, which may read right
                  to left — with the size in it isolated left to right. */}
              <span dir="auto" className="truncate">
                {t("deviceLaidOut", {
                  size: `\u2066${viewportLabel(shortOf)}\u2069`,
                })}
              </span>
            </span>
          ) : null}
        </div>
      ) : null}
      <div
        data-browser-device-frame=""
        className={
          viewport
            ? // A shadow, not a border: the native view covers the frame's
              // whole box, so anything drawn inside it would be painted over.
              "relative shrink-0 shadow-lg ring-1 ring-border"
            : "absolute inset-0"
        }
        style={
          viewport
            ? { width: frame?.width ?? 0, height: frame?.height ?? 0 }
            : undefined
        }
      >
        {viewport && !frame ? null : children(fit)}
      </div>
    </div>
  )
}
