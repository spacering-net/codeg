/**
 * Per-device preference for the floating Agent Plan overlay.
 *
 * When a plan is created mid-turn, the overlay auto-expands into the full
 * card. That is useful the first few times and noisy once you already know
 * the chip is there. Default stays the historical auto-expand.
 */

export const STORAGE_KEY_PLAN_OVERLAY_AUTO_EXPAND =
  "codeg-plan-overlay-auto-expand"
export const PLAN_OVERLAY_AUTO_EXPAND_EVENT = "codeg:plan-overlay-auto-expand"
export const DEFAULT_PLAN_OVERLAY_AUTO_EXPAND = true

export function readPlanOverlayAutoExpand(): boolean {
  if (typeof window === "undefined") return DEFAULT_PLAN_OVERLAY_AUTO_EXPAND
  try {
    const raw = window.localStorage.getItem(
      STORAGE_KEY_PLAN_OVERLAY_AUTO_EXPAND
    )
    if (raw === "0") return false
    if (raw === "1") return true
    return DEFAULT_PLAN_OVERLAY_AUTO_EXPAND
  } catch {
    return DEFAULT_PLAN_OVERLAY_AUTO_EXPAND
  }
}

export function writePlanOverlayAutoExpand(on: boolean): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(
      STORAGE_KEY_PLAN_OVERLAY_AUTO_EXPAND,
      on ? "1" : "0"
    )
    window.dispatchEvent(new Event(PLAN_OVERLAY_AUTO_EXPAND_EVENT))
  } catch {
    // Privacy mode / locked storage: the in-memory hook still updates.
  }
}
