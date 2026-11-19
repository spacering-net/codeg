import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/** A button on an assistant's bubble is raised off its grey, a ghost one a
 *  tonal patch — not on a card of its own inside it: a json-render card,
 *  or a card codeg draws (`data-pa-surface`: the tidy-ups, the promises'
 *  groups and actions), whose buttons keep their own colours. */
const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8")

describe("the bubble's buttons", () => {
  it("leave a card codeg draws in a bubble to its buttons' own colours", () => {
    const guards = [
      ...css.matchAll(/:not\(\s*\[data-slot="card"\] \*([^)]*)\)/g),
    ]
    expect(guards.length).toBeGreaterThanOrEqual(10)
    for (const g of guards) expect(g[1]).toMatch(/\[data-pa-surface\] \*/)
  })
})
