/**
 * Shared geometry for the desktop window-chrome corner overlays.
 *
 * The sidebar toggle / search (top-left) and terminal / aux / settings
 * (top-right) clusters are pinned to fixed overlays at the window's corners so
 * they never move — and never re-mount — when the side panels open or close
 * (that re-parenting is what used to make them flicker). Because the overlays
 * float ABOVE whichever column owns that edge, the column must reserve exactly
 * the overlay's width so its tabs / content never render underneath. Keeping the
 * overlay width and the column reservation in one place guarantees they agree.
 */

/**
 * Clearance for the native macOS traffic lights, which float over the window's
 * top-left corner (nudged to Y=21 for the h-10 bar in the Rust window config).
 * The left cluster sits to their right.
 */
export const MAC_TRAFFIC_LIGHT_INSET = 76

/**
 * Windows/Linux caption buttons (min / max / close) occupy the window's
 * top-right corner. Mirrors `WINDOW_CONTROLS_WIDTH` in window-controls.tsx; the
 * right cluster sits to their left.
 */
export const WINDOW_CAPTION_WIDTH = 138

/** Left cluster: sidebar toggle + search (two icon buttons + padding). */
export const LEFT_CHROME_CLUSTER = 80

/**
 * Right cluster: terminal + aux + settings (three icon buttons + padding).
 * A full-page workbench route swaps the first two for its own controls (see
 * `WorkbenchRouteChromeActions`), so the count — and this reservation — holds.
 */
export const RIGHT_CHROME_CLUSTER = 116

/**
 * Scale a DOM button-cluster width by the app's rem-based zoom.
 *
 * The app "zoom" scales the root font-size (`documentElement.style.fontSize =
 * 16 * zoom/100`, see AppearanceProvider), so the rem-sized chrome buttons
 * (`h-6 w-6`, `gap-1`, `pl-3`/`pr-3`) grow with zoom. Their containers must grow
 * by the same factor or the buttons overflow and get clipped at high zoom. The
 * NATIVE insets do NOT scale this way — the macOS traffic lights keep a constant
 * horizontal inset (only their Y shifts with zoom, see `traffic_light_position_at`
 * in commands/windows.rs) and the Windows/Linux caption buttons are fixed 46px
 * each — so callers add those separately, outside this helper.
 */
function scaleCluster(px: number, zoom: number): number {
  return Math.round((px * zoom) / 100)
}

/**
 * Width the window's left-edge column reserves for the left overlay.
 * `macInset` adds the traffic-light clearance (desktop macOS only); `zoom` (a
 * percent, default 100) scales the rem-sized button cluster to match the buttons
 * inside it, while the native traffic-light inset stays fixed.
 */
export function leftChromeReserve(macInset: boolean, zoom = 100): number {
  return (
    (macInset ? MAC_TRAFFIC_LIGHT_INSET : 0) +
    scaleCluster(LEFT_CHROME_CLUSTER, zoom)
  )
}

/**
 * Width the window's right-edge column reserves for the right overlay.
 * `winLinuxCaption` adds the native caption-button strip (desktop Win/Linux);
 * `zoom` (a percent, default 100) scales the rem-sized button cluster, while the
 * fixed native caption strip stays constant.
 */
export function rightChromeReserve(
  winLinuxCaption: boolean,
  zoom = 100
): number {
  return (
    scaleCluster(RIGHT_CHROME_CLUSTER, zoom) +
    (winLinuxCaption ? WINDOW_CAPTION_WIDTH : 0)
  )
}

/**
 * The right-edge overlay's OWN width — just the (zoom-scaled) button cluster.
 * The native caption strip isn't part of this box; it's cleared by the overlay's
 * `right` offset (see `FolderLayoutShell`), so only the cluster is measured here.
 */
export function rightChromeClusterWidth(zoom = 100): number {
  return scaleCluster(RIGHT_CHROME_CLUSTER, zoom)
}
