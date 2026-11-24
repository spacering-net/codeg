/**
 * A label carries one colour, picked by whoever made it against a white page.
 * The job here is to keep that colour recognizable in both themes without ever
 * letting the text on it become unreadable — which is why the same input yields
 * two different treatments and the stylesheet, not this function, chooses.
 */
import type { CSSProperties } from "react"
import { describe, expect, it } from "vitest"

import { labelSwatch } from "./forge-label-color"

/** The six custom properties, as the DOM would see them. */
function vars(color: string | null): Record<string, string> {
  const style = labelSwatch(color)
  expect(style, `expected a swatch for ${color}`).toBeDefined()
  return style as unknown as Record<string, string>
}

/** `hsl(353.9deg 66.2% 77.2% / 0.3)` → its parts. Parsed rather than compared
 *  as a string: what matters is the geometry, not the spelling. */
function hsl(value: string): { h: number; s: number; l: number; a: number } {
  const m = /^hsl\((-?[\d.]+)deg ([\d.]+)% ([\d.]+)%(?: \/ ([\d.]+))?\)$/.exec(
    value
  )
  expect(m, `unparseable hsl(): ${value}`).not.toBeNull()
  const [, h, s, l, a] = m as RegExpExecArray
  return {
    h: Number(h),
    s: Number(s),
    l: Number(l),
    a: a == null ? 1 : Number(a),
  }
}

describe("labelSwatch", () => {
  /** GitHub's own `bug` red: dark enough that black text on it would not read,
   *  and dark enough that painting it flat on a dark surface would not either. */
  it("fills with the colour in light mode and tints it in dark mode", () => {
    const s = vars("#d73a4a")
    expect(s["--fl-bg"]).toBe("#d73a4a")
    // Perceived lightness 0.36, below the threshold — white text.
    expect(s["--fl-fg"]).toBe("#ffffff")
    // Dark mode inverts the relationship: the colour becomes an 18% wash and
    // the TEXT carries the hue.
    expect(s["--fl-bg-dark"]).toBe("rgb(215 58 74 / 0.18)")

    const text = hsl(s["--fl-fg-dark"])
    expect(text.h).toBeCloseTo(353.9, 1)
    // Lifted well clear of the colour's own 53.5% lightness, or it would be a
    // dark red smudge on a dark red wash.
    expect(text.l).toBeGreaterThan(70)
    // The rim tracks the text, so the chip reads as one object.
    expect(hsl(s["--fl-border-dark"])).toMatchObject({ l: text.l, a: 0.3 })
  })

  /** The other end: a colour light enough to vanish into the page. */
  it("flips to black text on a pale label and gives it a rim to sit in", () => {
    const s = vars("#ffffff")
    expect(s["--fl-fg"]).toBe("#000000")
    // Fully opaque rim — without it a white chip on a white page is invisible.
    expect(hsl(s["--fl-border"]).a).toBe(1)

    // A mid-tone needs no rim: its own fill already separates it.
    expect(hsl(vars("#d73a4a")["--fl-border"]).a).toBe(0)
  })

  /** Lightening is a rescue, not a policy: a colour already bright enough on a
   *  dark surface keeps exactly the lightness the project chose. */
  it("leaves an already-bright colour alone in dark mode", () => {
    // Perceived lightness 0.78, above the dark threshold.
    const s = vars("#fbca04")
    expect(hsl(s["--fl-fg-dark"]).l).toBeCloseTo(50, 1)
    expect(s["--fl-fg"]).toBe("#000000")
  })

  /** Greys have no hue to preserve, and the saturation maths divides by a span
   *  of zero if that is not handled. */
  it("survives a colour with no saturation", () => {
    const s = vars("#808080")
    expect(hsl(s["--fl-fg-dark"])).toMatchObject({ h: 0, s: 0 })
  })

  /** The backend already normalizes to `#rrggbb` (see `normalize_hex_color`),
   *  so anything else reaching here is a label with no usable colour — it keeps
   *  the neutral chip rather than being painted something invented. */
  it("has nothing to paint without a normalized colour", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "rebeccapurple",
      "#fff",
      "d73a4a",
    ]) {
      expect(labelSwatch(bad), String(bad)).toBeUndefined()
    }
  })

  /** Every value goes into a `style` attribute; a stray `NaN` there kills the
   *  whole declaration silently. */
  it("emits six finite, well-formed values", () => {
    const s = vars("#0e8a16")
    expect(Object.keys(s)).toHaveLength(6)
    for (const value of Object.values(s)) {
      expect(value).not.toMatch(/NaN|undefined/)
    }
    // Typed as CSSProperties so callers can spread it straight onto `style`.
    const style: CSSProperties = labelSwatch("#0e8a16") as CSSProperties
    expect(style).toBeDefined()
  })
})
