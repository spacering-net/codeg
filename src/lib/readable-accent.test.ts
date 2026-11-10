import { describe, expect, it } from "vitest"

import { readableAccent } from "./readable-accent"
import { THEME_COLOR_TITLE } from "./theme-presets"

describe("readableAccent", () => {
  // Tailwind's red-500 is the red preset's primary, light and dark: the rule
  // gives the tint the preset's table spells out.
  it("holds a light page's accent to 0.5 lightness, its hue and what chroma fits", () => {
    expect(readableAccent("#ef4444", false)).toBe(THEME_COLOR_TITLE.red.light)
  })

  it("lifts a dark page's accent to 0.8", () => {
    expect(readableAccent("#ef4444", true)).toBe(THEME_COLOR_TITLE.red.dark)
  })

  it("leaves a colour that already reads alone", () => {
    // Darker than 0.5 on a light page, lighter than 0.8 on a dark one.
    expect(readableAccent("#1e3a8a", false)).toMatch(/^oklch\(0\.379 /)
    expect(readableAccent("#e0e7ff", true)).toMatch(/^oklch\(0\.93 /)
  })

  it("keeps a grey grey", () => {
    expect(readableAccent("#171717", false)).toBe("oklch(0.205 0 0)")
  })

  it("reads nothing it cannot take as a colour", () => {
    expect(readableAccent("not a colour", false)).toBeNull()
  })
})
