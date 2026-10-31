import { describe, expect, it } from "vitest"

import {
  LEFT_CHROME_CLUSTER,
  MAC_TRAFFIC_LIGHT_INSET,
  RIGHT_CHROME_CLUSTER,
  WINDOW_CAPTION_WIDTH,
  leftChromeReserve,
  rightChromeClusterWidth,
  rightChromeReserve,
} from "./window-chrome"

// The app "zoom" scales the root font-size (rem), so the rem-sized chrome buttons
// grow with zoom. Their fixed-px containers must grow by the same factor or the
// buttons overflow/clip at high zoom (the 150% bug). These guard that only the
// DOM button CLUSTER scales, while the native insets (macOS traffic-light
// clearance, Windows/Linux caption strip) stay fixed.
describe("window-chrome zoom scaling", () => {
  it("defaults to 100% (no scaling) and matches the pre-zoom baseline", () => {
    // Baseline the aux-panel collapse test also hard-codes: 144 (mac/web) and
    // 144 + 138 = 282 (win/linux caption reserved).
    expect(rightChromeReserve(false)).toBe(RIGHT_CHROME_CLUSTER)
    expect(rightChromeReserve(true)).toBe(
      RIGHT_CHROME_CLUSTER + WINDOW_CAPTION_WIDTH
    )
    expect(rightChromeClusterWidth()).toBe(RIGHT_CHROME_CLUSTER)
    expect(leftChromeReserve(false)).toBe(LEFT_CHROME_CLUSTER)
    expect(leftChromeReserve(true)).toBe(
      MAC_TRAFFIC_LIGHT_INSET + LEFT_CHROME_CLUSTER
    )
  })

  it("scales only the button cluster at 150%, leaving native insets fixed", () => {
    // 144 → 216, 80 → 120.
    expect(rightChromeClusterWidth(150)).toBe(216)
    expect(rightChromeReserve(false, 150)).toBe(216)
    // Native caption strip stays 138.
    expect(rightChromeReserve(true, 150)).toBe(216 + WINDOW_CAPTION_WIDTH)
    // Native traffic-light inset stays 76; only the 80 cluster scales to 120.
    expect(leftChromeReserve(false, 150)).toBe(120)
    expect(leftChromeReserve(true, 150)).toBe(MAC_TRAFFIC_LIGHT_INSET + 120)
  })

  it("scales the cluster down below 100% too and rounds to whole pixels", () => {
    // 144 * 0.9 = 129.6 → 130 (rounded).
    expect(rightChromeClusterWidth(90)).toBe(130)
    // 80 * 0.5 = 40, plus the fixed 76 inset.
    expect(leftChromeReserve(true, 50)).toBe(MAC_TRAFFIC_LIGHT_INSET + 40)
  })
})
