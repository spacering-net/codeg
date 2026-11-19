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

  it("draws a thing on the bubble white with a hairline, and on a card a wash", () => {
    const bubble = css.indexOf(
      ".pa-agent-bubble {\n  --pa-object: var(--card);"
    )
    expect(bubble).toBeGreaterThan(-1)
    const onCard = css.slice(
      css.indexOf(
        '.pa-agent-bubble :is([data-pa-surface], [data-slot="card"]) {'
      )
    )
    const body = onCard.slice(0, onCard.indexOf("}"))
    expect(body).toContain("--pa-object: var(--pa-inset);")
    expect(body).toContain("--pa-object-edge: transparent;")
    expect(body).toContain("--pa-table: transparent;")
    expect(css).toMatch(
      /\.pa-agent-bubble \[data-streamdown="table-body"\] \{\s*background-color: var\(--pa-table\);/
    )
  })

  it("keeps a quote in the owner's bubble its wash, no line", () => {
    const own = css.slice(css.indexOf(".pa-owner-bubble {"))
    const body = own.slice(0, own.indexOf("}"))
    expect(body).toContain("--pa-object: var(--pa-inset);")
    expect(body).toContain("--pa-object-hover: var(--pa-inset-hover);")
    expect(body).toContain("--pa-object-edge: transparent;")
  })
})
