import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  SPRING_FAST,
  SPRING_POP,
  SPRING_TOKENS,
  overshoot,
  settleTime,
  springAt,
  springLinear,
} from "./spring"

const css = readFileSync(
  path.resolve(__dirname, "../../app/globals.css"),
  "utf8"
)

/** The value a custom property is given inside `@supports (… linear …)`,
 *  whitespace folded. */
function committed(name: string): string | null {
  const supports = css.indexOf("@supports (transition-timing-function: linear(")
  if (supports < 0) return null
  const from = css.indexOf(`${name}:`, supports)
  if (from < 0) return null
  const end = css.indexOf(";", from)
  return css
    .slice(from + name.length + 1, end)
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")")
    .trim()
}

describe("the springs of the motion tokens", () => {
  it("are committed as the curves they solve to", () => {
    for (const [name, params] of SPRING_TOKENS) {
      expect(committed(name), name).toBe(springLinear(params))
    }
  })

  it("start at rest, end at one, and the pop goes about 7.8 % past it", () => {
    for (const s of [SPRING_FAST, SPRING_POP]) {
      expect(springAt(s, 0)).toBeCloseTo(0, 9)
      expect(springAt(s, settleTime(s))).toBeCloseTo(1, 2)
      const curve = springLinear(s)
      expect(curve.startsWith("linear(0, ")).toBe(true)
      expect(curve.endsWith(", 1)")).toBe(true)
    }
    expect(overshoot(SPRING_FAST)).toBeLessThan(0.001)
    expect(overshoot(SPRING_POP)).toBeGreaterThan(0.075)
    expect(overshoot(SPRING_POP)).toBeLessThan(0.081)
  })

  it("solve the damped cases too", () => {
    const critical = { mass: 1, stiffness: 100, damping: 20, points: 11 }
    const over = { mass: 1, stiffness: 100, damping: 40, points: 11 }
    for (const s of [critical, over]) {
      expect(springAt(s, 0)).toBeCloseTo(0, 9)
      expect(overshoot(s)).toBe(0)
      expect(springAt(s, 0.1)).toBeLessThan(springAt(s, 0.2))
    }
  })
})
