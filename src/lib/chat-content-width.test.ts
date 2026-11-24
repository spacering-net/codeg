import { beforeEach, describe, expect, it } from "vitest"

import { STORAGE_KEY_CHAT_CONTENT_WIDTH } from "./appearance-script"
import {
  CHAT_CONTENT_DEFAULT,
  CHAT_CONTENT_GUTTER,
  CHAT_CONTENT_MIN,
  CHAT_CONTENT_WIDTH_VAR,
  applyChatContentWidth,
  chatContentWidthCeiling,
  chatContentWidthCss,
  chatZoomFactor,
  commitChatContentWidth,
  maxChatContentWidth,
  readChatContentWidth,
  resizedChatContentWidth,
} from "./chat-content-width"

const rootVar = () =>
  document.documentElement.style.getPropertyValue(CHAT_CONTENT_WIDTH_VAR)

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute("style")
})

describe("readChatContentWidth", () => {
  it("is null when nothing is stored", () => {
    expect(readChatContentWidth()).toBeNull()
  })

  it.each(["abc", "0", "-5", "NaN", "99999"])("rejects %s", (raw) => {
    localStorage.setItem(STORAGE_KEY_CHAT_CONTENT_WIDTH, raw)
    expect(readChatContentWidth()).toBeNull()
  })

  it("returns a valid stored width", () => {
    localStorage.setItem(STORAGE_KEY_CHAT_CONTENT_WIDTH, "900")
    expect(readChatContentWidth()).toBe(900)
  })
})

describe("commitChatContentWidth", () => {
  it("applies (in rem, so it follows the zoom) and persists a width; null resets both", () => {
    commitChatContentWidth(960)
    expect(rootVar()).toBe("60rem")
    expect(localStorage.getItem(STORAGE_KEY_CHAT_CONTENT_WIDTH)).toBe("960")

    commitChatContentWidth(null)
    expect(rootVar()).toBe("")
    expect(localStorage.getItem(STORAGE_KEY_CHAT_CONTENT_WIDTH)).toBeNull()
  })

  it("applyChatContentWidth does not touch storage", () => {
    applyChatContentWidth(800)
    expect(rootVar()).toBe("50rem")
    expect(localStorage.getItem(STORAGE_KEY_CHAT_CONTENT_WIDTH)).toBeNull()
  })
})

describe("zoom", () => {
  it("writes px at 100% zoom as rem, like the 48rem default", () => {
    expect(chatContentWidthCss(CHAT_CONTENT_DEFAULT)).toBe("48rem")
    expect(chatContentWidthCss(900)).toBe("56.25rem")
  })

  it("reads the app zoom off the root font size", () => {
    expect(chatZoomFactor()).toBe(1)
    document.documentElement.style.fontSize = "32px" // 200%
    expect(chatZoomFactor()).toBe(2)
    document.documentElement.style.fontSize = "12.8px" // 80%
    expect(chatZoomFactor()).toBeCloseTo(0.8)
  })
})

describe("maxChatContentWidth", () => {
  it("is the host minus a gutter on both sides", () => {
    expect(maxChatContentWidth(1600)).toBe(1600 - 2 * CHAT_CONTENT_GUTTER)
  })

  it("is in px at 100% zoom (the gutter itself does not scale)", () => {
    expect(maxChatContentWidth(1600, 2)).toBe(
      (1600 - 2 * CHAT_CONTENT_GUTTER) / 2
    )
  })
})

describe("resizedChatContentWidth", () => {
  it("floors at the minimum", () => {
    expect(resizedChatContentWidth(768, 100, 1600)).toBe(CHAT_CONTENT_MIN)
  })

  it("caps at the host minus the gutter on both sides", () => {
    expect(resizedChatContentWidth(768, 5000, 1600)).toBe(
      1600 - 2 * CHAT_CONTENT_GUTTER
    )
  })

  it("scales the ceiling with the host, not a fixed px cap", () => {
    expect(resizedChatContentWidth(768, 5000, 3000)).toBe(
      3000 - 2 * CHAT_CONTENT_GUTTER
    )
  })

  it("passes an in-range width through", () => {
    expect(resizedChatContentWidth(768, 900, 1600)).toBe(900)
  })

  it("stores nothing in a host too narrow for the floor", () => {
    // A 500px host shows at most 476px. Lifting a drag there to the 640 floor
    // would store a width nobody saw, narrower than the 768 default.
    expect(resizedChatContentWidth(476, 900, 500)).toBeNull()
    expect(resizedChatContentWidth(476, 300, 500)).toBeNull()
    // Nor does it ever store below the floor there, even from a stored width
    // narrower still (hand-edited storage) that the host could widen.
    expect(resizedChatContentWidth(300, 310, 500)).toBeNull()
  })

  it("keeps the preference when pushing outward at the cap", () => {
    // The column is capped at 976 by a 1000px host (the preference may be
    // wider); widening further changes nothing on screen.
    expect(resizedChatContentWidth(976, 1100, 1000)).toBeNull()
  })

  it("narrows from the cap", () => {
    expect(resizedChatContentWidth(976, 900, 1000)).toBe(900)
  })

  it("keeps the preference at a cap that falls on a half", () => {
    // A 1601px host at 200% shows at most 788.5. Rounding that up to 789
    // must not read as widening and replace a wider stored preference.
    expect(resizedChatContentWidth(788.5, 900, 1601, 2)).toBeNull()
    expect(resizedChatContentWidth(788.5, 700, 1601, 2)).toBe(700)
  })

  it("stores nothing when the width would not change", () => {
    expect(resizedChatContentWidth(900, 900.3, 1600)).toBeNull()
    expect(resizedChatContentWidth(767.8, 767.8, 1600)).toBeNull()
  })

  it("bounds by the host in px at 100% zoom", () => {
    // 1600 CSS px at 200% zoom shows at most (1600 - 24) / 2 = 788.
    expect(resizedChatContentWidth(768, 5000, 1600, 2)).toBe(788)
    // ... and a host of 1200 CSS px at 200% (588) cannot reach the floor.
    expect(resizedChatContentWidth(588, 900, 1200, 2)).toBeNull()
  })
})

describe("chatContentWidthCeiling", () => {
  it("is the widest a screen-filling window shows, on the 8px grid", () => {
    expect(chatContentWidthCeiling(1920)).toBe(1896)
    expect(chatContentWidthCeiling(1920, 2)).toBe(944)
  })

  it("never drops below the default", () => {
    expect(chatContentWidthCeiling(1366, 3)).toBe(CHAT_CONTENT_DEFAULT)
    expect(chatContentWidthCeiling(0)).toBe(CHAT_CONTENT_DEFAULT)
  })
})
