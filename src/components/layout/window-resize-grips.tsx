"use client"

import { useEffect, useState, type CSSProperties } from "react"
import { isDesktop } from "@/lib/platform"
import { usePlatform } from "@/hooks/use-platform"
import { WINDOW_CONTROLS_WIDTH } from "./window-controls"

/**
 * Invisible edge/corner resize handles for undecorated Linux windows.
 *
 * Only Linux needs this: macOS keeps native resizing via the overlay title
 * bar, and Windows gets invisible resize borders from Tauri's WndProc hook.
 * Undecorated GTK windows, however, lose edge resizing entirely, so we
 * reproduce it by initiating a window-manager resize drag on mouse-down.
 *
 * Mounted once at the app root; it self-guards and renders nothing unless the
 * current window is a resizable, non-maximized Linux desktop window. Pet
 * windows (resizable: false) therefore get no grips.
 */

type ResizeDir =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthWest"
  | "SouthWest"
  | "SouthEast"

/** Edge strip thickness — matches the feel of native invisible resize borders. */
const EDGE = 4
/** Corner hit-zone size. */
const CORNER = 14
/**
 * Height of the window-controls strip — always h-8 (2rem), even when the title
 * bar itself is h-11 at narrow widths. The right edge starts below it. Uses rem
 * (not a fixed 32px) so it tracks the app zoom level (root font-size, set by
 * appearance-script); a px value would let the grip overlap the close button at
 * zoom levels above 100%.
 */
const CONTROLS_HEIGHT = "2rem"

async function beginResize(dir: ResizeDir) {
  try {
    // `ResizeDirection` is a string-union type in @tauri-apps/api; the method
    // accepts the literal directly (our `ResizeDir` values match it exactly).
    const { getCurrentWindow } = await import("@tauri-apps/api/window")
    await getCurrentWindow().startResizeDragging(dir)
  } catch (err) {
    console.error("[WindowResizeGrips] startResizeDragging failed:", err)
  }
}

const GRIPS: { dir: ResizeDir; cursor: string; style: CSSProperties }[] = [
  // Edges. The top edge stops before the controls strip so the close button
  // stays fully clickable; the right edge starts below the controls bar.
  {
    dir: "North",
    cursor: "ns-resize",
    style: { top: 0, left: 0, right: WINDOW_CONTROLS_WIDTH, height: EDGE },
  },
  {
    dir: "South",
    cursor: "ns-resize",
    style: { bottom: 0, left: 0, right: 0, height: EDGE },
  },
  {
    dir: "West",
    cursor: "ew-resize",
    style: { top: 0, bottom: 0, left: 0, width: EDGE },
  },
  {
    dir: "East",
    cursor: "ew-resize",
    style: { top: CONTROLS_HEIGHT, bottom: 0, right: 0, width: EDGE },
  },
  // Corners (NorthEast is omitted — the window controls occupy that corner).
  {
    dir: "NorthWest",
    cursor: "nwse-resize",
    style: { top: 0, left: 0, width: CORNER, height: CORNER },
  },
  {
    dir: "SouthWest",
    cursor: "nesw-resize",
    style: { bottom: 0, left: 0, width: CORNER, height: CORNER },
  },
  {
    dir: "SouthEast",
    cursor: "nwse-resize",
    style: { bottom: 0, right: 0, width: CORNER, height: CORNER },
  },
]

export function WindowResizeGrips() {
  const { isLinux } = usePlatform()
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    if (!isLinux || !isDesktop()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only isDesktop() read after mount (hydration-safe)
      setEnabled(false)
      return
    }

    let disposed = false
    let unlisten: (() => void) | null = null

    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      if (disposed) return
      const win = getCurrentWindow()

      // Non-resizable windows (pet, pet-panel) get no grips.
      let resizable = true
      try {
        resizable = await win.isResizable()
      } catch {
        resizable = true
      }
      if (disposed || !resizable) {
        setEnabled(false)
        return
      }

      const sync = async () => {
        try {
          const maximized = await win.isMaximized()
          if (!disposed) setEnabled(!maximized)
        } catch {
          if (!disposed) setEnabled(true)
        }
      }

      await sync()
      win
        .onResized(() => void sync())
        .then((u) => {
          if (disposed) u()
          else unlisten = u
        })
        .catch(() => {
          unlisten = null
        })
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [isLinux])

  if (!enabled) return null

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[100]">
      {GRIPS.map((grip) => (
        <div
          key={grip.dir}
          className="pointer-events-auto absolute"
          style={{ ...grip.style, cursor: grip.cursor }}
          onMouseDown={(e) => {
            if (e.button !== 0) return
            e.preventDefault()
            void beginResize(grip.dir)
          }}
        />
      ))}
    </div>
  )
}
