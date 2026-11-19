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
    // On a card — in a bubble, or a message of its own with none round it
    // — the card's own steps, a wash, no line.
    const onCard = css.slice(
      css.indexOf(
        ':is(.pa-agent-bubble, [data-pa-list])\n  :is([data-pa-surface], [data-slot="card"], [data-pa-bare]) {'
      )
    )
    const body = onCard.slice(0, onCard.indexOf("}"))
    expect(body).toContain("--pa-inset: color-mix(")
    expect(body).toContain("--pa-object: var(--pa-inset);")
    expect(body).toContain("--pa-object-edge: transparent;")
  })

  it("leaves a table in the conversation no colour of its own", () => {
    expect(css).not.toContain("--pa-table")
    expect(css).toMatch(
      /\[data-pa-list\] \[data-streamdown="table-body"\] \{\s*background-color: transparent;/
    )
    // Its head a see-through step over whatever it sits on.
    expect(css).toMatch(
      /\[data-pa-list\] \[data-streamdown="table-header"\] \{\s*background-color: color-mix\(in oklab, var\(--foreground\) 4%, transparent\);/
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
