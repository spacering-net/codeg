/**
 * Springs as CSS `linear()` curves (10.8): no animation library, the curve is
 * solved once, sampled and committed into `app/globals.css`. The test solves
 * it again and checks the stylesheet still says the same; after changing a
 * spring, `node scripts/gen-spring-linear.mjs` prints the new strings.
 *
 * A spring from 0 to 1, starting at rest: mass `m`, stiffness `k`, damping
 * `c`. Its shape is sampled over the time it takes to settle (within
 * `SETTLE_EPSILON` of 1, for good); how long it plays is the token's own
 * duration, so the same shape can be played faster (reduced motion).
 *
 * Pure and dependency-free, with only erasable TypeScript, so Node runs it
 * as it is (the script imports this file).
 */

export interface SpringParams {
  mass: number
  stiffness: number
  damping: number
  /** Points sampled, both ends included. */
  points: number
}

/** "Fast": mass 1, stiffness 175, damping 26 — played in 300 ms (120 ms
 *  under reduced motion). */
export const SPRING_FAST: SpringParams = {
  mass: 1,
  stiffness: 175,
  damping: 26,
  points: 41,
}

/** "Pop": an overshoot of about 7.8 % — the reaction's 500 ms pop. */
export const SPRING_POP: SpringParams = {
  mass: 1,
  stiffness: 300,
  damping: 21.8,
  points: 51,
}

/** The CSS custom properties that hold them. */
export const SPRING_TOKENS: ReadonlyArray<readonly [string, SpringParams]> = [
  ["--motion-spring-fast", SPRING_FAST],
  ["--motion-spring-pop", SPRING_POP],
]

/** A spring has settled once it stays this close to its end. */
export const SETTLE_EPSILON = 0.001

/** Where the spring is `t` seconds after it was let go. */
export function springAt(s: SpringParams, t: number): number {
  const w0 = Math.sqrt(s.stiffness / s.mass)
  const zeta = s.damping / (2 * Math.sqrt(s.stiffness * s.mass))
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta)
    return (
      1 -
      Math.exp(-zeta * w0 * t) *
        (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t))
    )
  }
  if (zeta === 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t)
  const root = Math.sqrt(zeta * zeta - 1)
  const r1 = -w0 * (zeta - root)
  const r2 = -w0 * (zeta + root)
  return 1 + (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r1 - r2)
}

/** How long the spring takes to settle, in seconds (1 ms steps, at most
 *  10 s). */
export function settleTime(s: SpringParams): number {
  const step = 0.001
  let last = 0
  for (let t = 0; t <= 10; t += step) {
    if (Math.abs(springAt(s, t) - 1) > SETTLE_EPSILON) last = t
  }
  return last + step
}

/** The highest it goes past its end, as a fraction (0 when it never does). */
export function overshoot(s: SpringParams): number {
  const end = settleTime(s)
  let peak = 1
  for (let t = 0; t <= end; t += 0.0005) peak = Math.max(peak, springAt(s, t))
  return peak - 1
}

function fmt(v: number): string {
  const r = Math.round(v * 1000) / 1000
  return Object.is(r, -0) ? "0" : String(r)
}

/** The spring's shape as a CSS easing: `linear(0, …, 1)`. */
export function springLinear(s: SpringParams): string {
  const end = settleTime(s)
  const n = Math.max(2, s.points) - 1
  const values: string[] = []
  for (let i = 0; i <= n; i++) {
    values.push(i === n ? "1" : fmt(springAt(s, (i / n) * end)))
  }
  return `linear(${values.join(", ")})`
}
