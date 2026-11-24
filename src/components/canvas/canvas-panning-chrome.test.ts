import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * The pan gesture is ours, not ReactFlow's (`use-canvas-right-drag-pan`), and
 * everything it changes about the board's appearance hangs off one attribute it
 * sets for the duration: `data-canvas-panning`. The attribute and the rules that
 * read it live in different files and nothing but this test connects them —
 * rename it on one side and the cursor silently stops changing, the minimap
 * silently stops getting out of the way, and both look like "it just does that
 * now" rather than a break.
 */

function css(): string {
  return readFileSync(
    resolve(process.cwd(), "src/app/globals.css"),
    "utf8"
  ).replace(/\/\*[\s\S]*?\*\//g, "")
}

/** A rule's declaration block, by the selector that opens it. */
function ruleBody(selector: RegExp): string {
  const match = css().match(selector)
  expect(match, `no rule matching ${selector} in globals.css`).not.toBeNull()
  return match![1]
}

describe("what a pan does to the board's chrome", () => {
  it("takes the minimap out of the way", () => {
    // It is an orientation aid for a board standing still. During a drag it is
    // a bright rectangle redrawing itself in the corner being dragged towards.
    expect(
      ruleBody(
        /\.canvas-surface\[data-canvas-panning\]\s+\.canvas-minimap\s*\{([^}]*)\}/
      )
    ).toMatch(/opacity:\s*0/)
  })

  it("fades it rather than dropping it out of layout", () => {
    // `display: none` would relayout the panel and pop it back mid-gesture.
    expect(
      ruleBody(/\.canvas-surface\s+\.canvas-minimap\s*\{([^}]*)\}/)
    ).toMatch(/transition:\s*opacity/)
  })

  it("leaves the map's positioning to the component", () => {
    // What takes the map out of its own Panel's absolute positioning is an
    // inline style (see `canvas-viewport-panel.test`), because a stylesheet
    // rule only wins if it arrives — the dev server served a stale chunk of
    // this very rule once, and the map landed on the buttons. Two owners of one
    // layout decision is how that gets missed, so this file asserts the rule
    // does NOT try to own it.
    const body = ruleBody(/\.canvas-surface\s+\.canvas-minimap\s*\{([^}]*)\}/)
    expect(body).not.toMatch(/position:/)
    expect(body).not.toMatch(/margin:/)
  })

  it("still forces the grabbing cursor everywhere", () => {
    // Every element on the board declares its own cursor (a card's text, the
    // composer), so this one has to beat all of them — it is what makes the
    // gesture feel like one drag instead of a hover tour.
    expect(
      ruleBody(
        /\.canvas-surface\[data-canvas-panning\],\s*\.canvas-surface\[data-canvas-panning\]\s*\*\s*\{([^}]*)\}/
      )
    ).toMatch(/cursor:\s*grabbing\s*!important/)
  })

  it("is driven by the attribute the pan controller sets", () => {
    const hook = readFileSync(
      resolve(
        process.cwd(),
        "src/components/canvas/use-canvas-right-drag-pan.ts"
      ),
      "utf8"
    )
    expect(hook).toContain('setAttribute("data-canvas-panning"')
    expect(hook).toContain('removeAttribute("data-canvas-panning")')
  })
})
