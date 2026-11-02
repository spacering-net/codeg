import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkMath from "remark-math"
import katex from "katex"
import { describe, expect, it } from "vitest"
import { normalizeMathDelimiters } from "./message"
import {
  MATH_FENCE_PAD,
  stripMathFencePad,
  type MdastNodeLike,
} from "./streamdown-plugins"

const Z = MATH_FENCE_PAD

/**
 * The string `rehype-katex` will hand to KaTeX: it reads the pre-rendered
 * `data.hChildren` that `mdast-util-math` attaches, not `node.value`.
 */
function katexInput(markdown: string, strip: boolean): string {
  const proc = unified()
    .use(remarkParse)
    .use(remarkMath, { singleDollarTextMath: false })
  const tree = proc.runSync(proc.parse(markdown)) as unknown as MdastNodeLike
  if (strip) stripMathFencePad(tree)
  let found = "<no math node>"
  const walk = (node: MdastNodeLike) => {
    if (node.type === "inlineMath" || node.type === "math") {
      const hChildren = node.data?.hChildren
      found = Array.isArray(hChildren)
        ? (hChildren as { value?: string }[]).map((c) => c.value ?? "").join("")
        : String(node.value)
      return
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children as MdastNodeLike[]) walk(child)
    }
  }
  walk(tree)
  return found
}

const render = (tex: string) =>
  katex.renderToString(tex, { throwOnError: false })

// U+200B is not whitespace to KaTeX — it lexes as a `textord`, which changes
// the spacing class of a terminal operator or punctuation. The pad only has to
// survive micromark's block tokenizer, so it is stripped from the tree before
// rehype-katex reads it.
describe("the math fence pad never reaches KaTeX", () => {
  const bodies = [
    "a,",
    "a+",
    "a=",
    "x^2",
    "\\alpha",
    "\\frac{1}{2}",
    "\\text{hi}",
    "\\begin{aligned} a &= b \\end{aligned}",
    "\\verb|x|",
  ]

  it("renders spacing-sensitive bodies identically to an unpadded source", () => {
    for (const body of bodies) {
      expect(render(katexInput(`x ${Z}$$${body}${Z}$$ y`, true))).toBe(
        render(katexInput(`x $$${body}$$ y`, false))
      )
    }
  })

  it("would differ without the strip — the check above is not vacuous", () => {
    expect(render(katexInput(`x ${Z}$$a,${Z}$$ y`, false))).not.toBe(
      render(katexInput("x $$a,$$ y", false))
    )
  })

  it("strips only the pad the normalizer appended", () => {
    expect(normalizeMathDelimiters("\\(a\nb\\)")).toBe(`${Z}$$a\nb${Z}$$`)
    const node: MdastNodeLike = {
      type: "inlineMath",
      value: `a${Z}b${Z}`,
      data: { hChildren: [{ type: "text", value: `a${Z}b${Z}` }] },
    }
    stripMathFencePad(node)
    expect(node.value).toBe(`a${Z}b`)
  })
})

describe("single-dollar formulas reach KaTeX", () => {
  it.each([
    "T",
    "AV",
    "A - T",
    String.raw`\Gamma^0, \Gamma^C`,
    String.raw`\mathcal{U}^{AV}`,
  ])("renders %s exactly like double-dollar inline math", (body) => {
    const actual = katexInput(normalizeMathDelimiters(`正文 $${body}$。`), true)
    expect(actual).toBe(body)
    expect(render(actual)).toBe(render(katexInput(`正文 $$${body}$$。`, true)))
    expect(render(actual)).toContain('class="katex"')
  })
})
