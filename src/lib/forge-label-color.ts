/**
 * A forge label's colour, turned into a chip that stays readable in both
 * themes.
 *
 * A label carries ONE colour, chosen by whoever made it against a white page.
 * Painted as-is on a dark surface, half of them become unreadable and the
 * bright ones glare. GitHub solves this with a pair of treatments driven by the
 * colour's PERCEIVED lightness, and this is that algorithm (Primer's
 * `.IssueLabel`) computed up front rather than in CSS `calc()`:
 *
 * - light: the colour itself as the fill, black or white text over it, and a
 *   darker rim only for the near-white labels that would otherwise dissolve
 *   into the page;
 * - dark: the colour at 18% as the fill with the colour ITSELF lightened for
 *   the text, so a dark navy label stays legible instead of turning into a
 *   black-on-black smudge.
 *
 * Both sets are emitted together as custom properties and the stylesheet picks
 * (see `.forge-label` in globals.css) — the theme is a class on the root, which
 * an inline style cannot read.
 */
import type { CSSProperties } from "react"

/** Above this perceived lightness a label takes black text, below it white. */
const LIGHT_TEXT_THRESHOLD = 0.453
/** Below this, a dark-theme label's own colour is lightened for the text. */
const DARK_TEXT_THRESHOLD = 0.6
/** Above this, a light-theme label is pale enough to need a rim of its own. */
const LIGHT_BORDER_THRESHOLD = 0.96
const DARK_BACKGROUND_ALPHA = 0.18
const DARK_BORDER_ALPHA = 0.3

/** ITU-R BT.709 weights — the same ones Primer uses. */
function perceivedLightness(r: number, g: number, b: number): number {
  return (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255
}

/** `#rrggbb` → channels. Anything else is not a colour this can work with;
 *  the backend already normalizes, so this is the last line rather than the
 *  first. */
function channels(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (match == null) return null
  const n = Number.parseInt(match[1], 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

/** Hue in degrees, saturation and lightness in percent. */
function toHsl(r: number, g: number, b: number): [number, number, number] {
  const [rf, gf, bf] = [r / 255, g / 255, b / 255]
  const max = Math.max(rf, gf, bf)
  const min = Math.min(rf, gf, bf)
  const l = (max + min) / 2
  const span = max - min
  if (span === 0) return [0, 0, l * 100]
  const s = span / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === rf) h = ((gf - bf) / span) % 6
  else if (max === gf) h = (bf - rf) / span + 2
  else h = (rf - gf) / span + 4
  return [(((h * 60) % 360) + 360) % 360, s * 100, l * 100]
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Trim the float noise `toHsl` leaves behind — these go into a style
 *  attribute, and `hsl(0.20000000000000018deg …)` helps nobody read it. */
function round(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * The six custom properties `.forge-label` reads, or `undefined` for a label
 * the forge gave no usable colour — those keep the neutral chip rather than
 * being painted some invented default.
 */
export function labelSwatch(
  color: string | null | undefined
): CSSProperties | undefined {
  if (color == null) return undefined
  const rgb = channels(color)
  if (rgb == null) return undefined

  const [r, g, b] = rgb
  const [h, s, l] = toHsl(r, g, b).map(round)
  const perceived = perceivedLightness(r, g, b)

  // Near-white labels only: elsewhere the fill already separates the chip from
  // the page, and a rim on every one of them would clutter the row.
  const lightBorderAlpha = round(
    clamp((perceived - LIGHT_BORDER_THRESHOLD) * 100, 0, 1)
  )
  // Dark theme: lift the text off the floor by however far the colour sits
  // below the threshold. A colour already light enough is left alone.
  const lightenBy =
    perceived < DARK_TEXT_THRESHOLD
      ? (DARK_TEXT_THRESHOLD - perceived) * 100
      : 0
  const darkTextL = round(clamp(l + lightenBy, 0, 100))

  return {
    "--fl-bg": color,
    "--fl-fg": perceived < LIGHT_TEXT_THRESHOLD ? "#ffffff" : "#000000",
    "--fl-border": `hsl(${h}deg ${s}% ${round(clamp(l - 25, 0, 100))}% / ${lightBorderAlpha})`,
    "--fl-bg-dark": `rgb(${r} ${g} ${b} / ${DARK_BACKGROUND_ALPHA})`,
    "--fl-fg-dark": `hsl(${h}deg ${s}% ${darkTextL}%)`,
    "--fl-border-dark": `hsl(${h}deg ${s}% ${darkTextL}% / ${DARK_BORDER_ALPHA})`,
  } as CSSProperties
}
