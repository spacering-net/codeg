import { cn } from "@/lib/utils"

/**
 * The blank, window-draggable slot a top strip keeps under one of the fixed
 * corner overlays (LeftEdgeChrome / RightEdgeChrome, plus the Win/Linux caption
 * buttons on the right).
 *
 * A strip MOUNTS it while its column holds that window corner — a structural
 * fact (workspace mode, files maximized, split geometry) whose changes snap the
 * layout — and SIZES it by the side panel over the corner: 0 while the sidebar
 * / aux panel covers it, the overlay's width while that panel is collapsed. So
 * a sidebar/aux toggle can ANIMATE it: the owning column slides over 240ms
 * (`.panel-slide-animating`), and a reserve that popped in or out at once made
 * the tabs jump by its full width and then slide back — a squeeze-and-stretch
 * most visible on desktop Win/Linux, where the right reserve also covers the
 * 138px caption buttons. Under that class the width transitions with the same
 * timing as the panels (globals.css), so the space the tabs get changes in one
 * smooth, monotonic motion.
 *
 * `line` draws the tab strips' hairline (`ws-strip-line`) under the slot; the
 * workbench-route band turns it off, since it draws its own border.
 */
export function ChromeReserve({
  width,
  line = true,
}: {
  width: number
  line?: boolean
}) {
  return (
    <div
      data-tauri-drag-region
      aria-hidden
      className={cn("chrome-reserve h-full shrink-0", line && "ws-strip-line")}
      style={{ width }}
    />
  )
}
