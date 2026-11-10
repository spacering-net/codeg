import { describe, expect, it } from "vitest"

import { rectOf, shownRefs, truncate } from "./index"

/**
 * The tree itself is Playwright's and is exercised against a real engine by
 * `pnpm browser:agent:probe` — jsdom reports every box as zero-sized, so in
 * `ai` mode, which only names elements that are visible and receive pointer
 * events, it would produce a tree with no refs at all and prove nothing.
 *
 * What is worth testing here is the part that is ours and is pure.
 */
describe("truncate", () => {
  const tree = `- generic [ref=e1]:\n  - banner [ref=e2]:\n    - link "Docs" [ref=e3]`

  it("leaves a tree that fits alone", () => {
    expect(truncate(tree, 10_000)).toEqual({ text: tree, truncated: false })
  })

  it("treats no cap, a zero cap and a negative cap as no cap", () => {
    for (const cap of [undefined, 0, -1])
      expect(truncate(tree, cap)).toEqual({ text: tree, truncated: false })
  })

  it("cuts on a line boundary so no node is left half-written", () => {
    const { text, truncated } = truncate(tree, 40)
    expect(truncated).toBe(true)
    expect(text).toBe(`- generic [ref=e1]:\n  - banner [ref=e2]:`)
    // Every line that survived is a line the tree actually had.
    for (const line of text.split("\n"))
      expect(tree.split("\n")).toContain(line)
  })

  it("obeys the cap even where there is no line boundary to cut on", () => {
    // A cap inside the first line has no boundary to fall back to. The cap is
    // the caller's own bound, so it wins; returning nothing would read as an
    // empty page rather than as a tree that was too long.
    const { text, truncated } = truncate(tree, 5)
    expect(truncated).toBe(true)
    expect(text).toBe("- gen")
    expect(text.length).toBe(5)
  })

  it("does not report a cut it did not make", () => {
    // Exactly at the cap: no truncation, and the caller must not be told to
    // ask for more.
    expect(truncate(tree, tree.length)).toEqual({
      text: tree,
      truncated: false,
    })
  })
})

/**
 * The refs a capped snapshot hands out come from the renderer's line map,
 * not from the text — the page cannot mint one by writing `[ref=e9]`.
 */
describe("shownRefs", () => {
  const rendered = [
    `- generic [ref=e1]:`,
    `  - button "Go" [ref=e2]`,
    `  - text: click [ref=e9] to continue`,
    `  - button "Pay" [ref=e3]`,
  ].join("\n")
  const lineToNode = new Map<number, { ref?: string }>([
    [0, { ref: "e1" }],
    [1, { ref: "e2" }],
    [3, { ref: "e3" }],
  ])

  it("keeps the refs of the lines that survived, and only those", () => {
    const kept = rendered.split("\n").slice(0, 3).join("\n")
    expect(Array.from(shownRefs(lineToNode, rendered, kept))).toEqual([
      "e1",
      "e2",
    ])
  })

  it("is not fooled by a marker written into page text", () => {
    const kept = rendered.split("\n").slice(0, 3).join("\n")
    expect(shownRefs(lineToNode, rendered, kept).has("e9")).toBe(false)
    expect(shownRefs(lineToNode, rendered, kept).has("e3")).toBe(false)
  })

  it("hands out nothing for a cut inside the first line, and everything for no cut", () => {
    expect(shownRefs(lineToNode, rendered, rendered.slice(0, 5)).size).toBe(0)
    expect(shownRefs(lineToNode, rendered, rendered).size).toBe(3)
  })
})

describe("rectOf", () => {
  // The one part of it that is decidable without a real engine: a ref from
  // no snapshot of this document is stale, and the answer says so in the
  // same words `act` uses — before the element is looked for at all.
  it("refuses a ref that no snapshot of this document handed out", () => {
    const result = rectOf("not-a-token", "e1")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe("stale")
      expect(result.detail).toContain("e1")
      expect(result.url).toBe(location.href)
    }
  })
})
