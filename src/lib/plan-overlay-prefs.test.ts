import { afterEach, describe, expect, it } from "vitest"

import {
  DEFAULT_PLAN_OVERLAY_AUTO_EXPAND,
  STORAGE_KEY_PLAN_OVERLAY_AUTO_EXPAND,
  readPlanOverlayAutoExpand,
  writePlanOverlayAutoExpand,
} from "./plan-overlay-prefs"

describe("plan overlay auto-expand preference", () => {
  afterEach(() => {
    window.localStorage.removeItem(STORAGE_KEY_PLAN_OVERLAY_AUTO_EXPAND)
  })

  it("defaults to auto-expand (historical behavior)", () => {
    expect(readPlanOverlayAutoExpand()).toBe(DEFAULT_PLAN_OVERLAY_AUTO_EXPAND)
    expect(readPlanOverlayAutoExpand()).toBe(true)
  })

  it("round-trips off and on", () => {
    writePlanOverlayAutoExpand(false)
    expect(readPlanOverlayAutoExpand()).toBe(false)
    writePlanOverlayAutoExpand(true)
    expect(readPlanOverlayAutoExpand()).toBe(true)
  })
})
