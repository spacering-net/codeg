import { describe, expect, it } from "vitest"

import { APPEARANCE_INIT_SCRIPT } from "./appearance-script"
import { DEFAULT_ZOOM_LEVEL, ZOOM_LEVELS, stepZoom } from "./theme-presets"

describe("stepZoom", () => {
  it("walks the Settings rungs and stops at the ends", () => {
    expect(stepZoom(100, 1)).toBe(110)
    expect(stepZoom(110, -1)).toBe(100)
    expect(stepZoom(80, -1)).toBe(80)
    expect(stepZoom(150, 1)).toBe(175)
    expect(stepZoom(300, 1)).toBe(300)
    expect(stepZoom(DEFAULT_ZOOM_LEVEL, 1)).toBe(110)
  })
})

describe("pre-paint zoom whitelist", () => {
  // The inline script is what applies zoom on boot, and it carries its own copy
  // of the rungs. A level listed here but not there fails quietly rather than
  // loudly: the provider reads its initial state from the font size the script
  // already set, so the saved zoom is simply ignored and the app renders at
  // 100% with nothing to explain why.
  it("keeps VALID_ZOOMS in step with ZOOM_LEVELS", () => {
    const listed = /var VALID_ZOOMS = \[([^\]]*)\]/
      .exec(APPEARANCE_INIT_SCRIPT)![1]
      .split(",")
      .map((n) => parseInt(n.trim(), 10))

    expect(listed).toEqual([...ZOOM_LEVELS])
  })
})
