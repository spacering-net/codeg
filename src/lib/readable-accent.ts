/**
 * The theme's colour held to a lightness it reads at as text and thin lines
 * on the page: the primary's hue and chroma, its lightness at most 0.5 on a
 * light page and at least 0.8 on a dark one, the chroma then brought down
 * until the colour fits sRGB. The sidebar's folder-title tints
 * (`THEME_COLOR_TITLE` in theme-presets.ts) follow this rule, and so does the
 * activity timeline's `--activity-accent` (globals.css) for each preset;
 * this works it out for a primary the user set themselves.
 */

import { toHexColor } from "@/lib/custom-style"

type Oklch = [l: number, c: number, h: number]

function toLinear(channel: number): number {
  const v = channel / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function hexToOklch(hex: string): Oklch {
  const r = toLinear(Number.parseInt(hex.slice(1, 3), 16))
  const g = toLinear(Number.parseInt(hex.slice(3, 5), 16))
  const b = toLinear(Number.parseInt(hex.slice(5, 7), 16))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const hue = (Math.atan2(B, A) * 180) / Math.PI
  return [L, Math.hypot(A, B), hue < 0 ? hue + 360 : hue]
}

function inSrgb(L: number, C: number, h: number): boolean {
  const A = C * Math.cos((h * Math.PI) / 180)
  const B = C * Math.sin((h * Math.PI) / 180)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  return rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4)
}

const round = (value: number) => Math.round(value * 1000) / 1000

/** `color` (any CSS colour) as the readable accent, as `oklch(…)`; null when
 *  it cannot be read as an opaque colour. */
export function readableAccent(color: string, dark: boolean): string | null {
  const hex = toHexColor(color)
  if (!hex) return null
  const [L, C, h] = hexToOklch(hex)
  const l = dark ? Math.max(L, 0.8) : Math.min(L, 0.5)
  let low = 0
  let high = C
  if (inSrgb(l, C, h)) {
    low = C
  } else {
    for (let step = 0; step < 24; step++) {
      const mid = (low + high) / 2
      if (inSrgb(l, mid, h)) low = mid
      else high = mid
    }
  }
  // A grey keeps no hue to speak of.
  return low < 0.0005
    ? `oklch(${round(l)} 0 0)`
    : `oklch(${round(l)} ${round(low)} ${round(h)})`
}
