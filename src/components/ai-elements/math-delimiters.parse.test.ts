import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkMath from "remark-math"
import { visit } from "unist-util-visit"
import { describe, expect, it } from "vitest"
import { normalizeMathDelimiters } from "./message"

interface MathNode {
  type: "inlineMath" | "math"
  value: string
  meta: string | null
}

function parseMath(text: string, singleDollarTextMath = false): MathNode[] {
  const tree = unified()
    .use(remarkParse)
    .use(remarkMath, { singleDollarTextMath })
    .parse(text)
  const nodes: MathNode[] = []
  visit(tree, (node) => {
    if (node.type === "inlineMath" || node.type === "math") {
      const math = node as {
        type: "inlineMath" | "math"
        value: string
        meta?: string | null
      }
      nodes.push({
        type: math.type,
        value: math.value,
        meta: math.meta ?? null,
      })
    }
  })
  return nodes
}

describe("remark-math with singleDollarTextMath: false", () => {
  it("does not parse currency pairs as inlineMath", () => {
    const text =
      "The Pro plan costs $9.99 but the Team plan costs $19.99 per month."
    expect(parseMath(normalizeMathDelimiters(text))).toEqual([])
  })

  it("normalizes tightly delimited $x$ without enabling permissive parsing", () => {
    expect(parseMath("$x$")).toEqual([])
    expect(parseMath(normalizeMathDelimiters("$x$"))).toEqual([
      { type: "inlineMath", value: "x", meta: null },
    ])
  })

  it("parses the reported single-dollar symbols and expressions inline", () => {
    const text = String.raw`令 $T$、$AV$、$A - T$、$V - T$、$\Gamma^0, \Gamma^C$ 和 $\mathcal{U}^{AV}$。`
    expect(parseMath(normalizeMathDelimiters(text))).toEqual(
      [
        "T",
        "AV",
        "A - T",
        "V - T",
        String.raw`\Gamma^0, \Gamma^C`,
        String.raw`\mathcal{U}^{AV}`,
      ].map((value) => ({ type: "inlineMath", value, meta: null }))
    )
  })

  it("does not rewrite single-dollar formulas in code", () => {
    const text = "`$T$`\n\n```tex\n$A - T$\n```\n\n~~~tex\n$AV$\n~~~"
    expect(normalizeMathDelimiters(text)).toBe(text)
    expect(parseMath(normalizeMathDelimiters(text))).toEqual([])
  })

  it("preserves double-dollar display math alongside inline formulas", () => {
    expect(parseMath(normalizeMathDelimiters("$T$\n\n$$\nx^2\n$$"))).toEqual([
      { type: "inlineMath", value: "T", meta: null },
      { type: "math", value: "x^2", meta: null },
    ])
  })

  it("preserves dollars inside existing backslash-delimited math", () => {
    expect(normalizeMathDelimiters(String.raw`\(\text{$AV$}\)`)).toBe(
      String.raw`$$\text{$AV$}$$`
    )
  })

  it("does not parse shell variables as inlineMath", () => {
    expect(parseMath("Set $HOME and $PATH before running.")).toEqual([])
    expect(parseMath("Use $1 and $2 as positional args.")).toEqual([])
  })

  it("keeps single-line \\(...\\) as inline math after normalize", () => {
    const nodes = parseMath(normalizeMathDelimiters("Also \\(x\\)."))
    expect(nodes).toEqual([{ type: "inlineMath", value: "x", meta: null }])
  })

  it("keeps multi-line \\(...\\) at the start of a block (does not drop the first line)", () => {
    const one = parseMath(normalizeMathDelimiters("\\(a\nb\\)"))
    expect(one).toHaveLength(1)
    expect(one[0]?.type).toBe("inlineMath")
    expect(one[0]?.value.replace(/[\s\u200b]+/g, "")).toBe("ab")

    const two = parseMath(normalizeMathDelimiters("\\(a\nb\n\\)"))
    expect(two).toHaveLength(1)
    expect(two[0]?.type).toBe("inlineMath")
    expect(two[0]?.value).toContain("a")
    expect(two[0]?.value).toContain("b")
  })

  it("keeps formula text when the closer sits on a continuation prefix", () => {
    const quote = parseMath(normalizeMathDelimiters("> \\(a\n> b\n> \\)"))
    expect(quote).toHaveLength(1)
    expect(quote[0]?.type).toBe("inlineMath")
    expect(quote[0]?.value.replace(/[\s\u200b]+/g, "")).toBe("ab")

    const list = parseMath(
      normalizeMathDelimiters("- Note:\n  \\(a\n  b\n  \\) holds.")
    )
    expect(list).toHaveLength(1)
    expect(list[0]?.type).toBe("inlineMath")
    expect(list[0]?.value.replace(/[\s\u200b]+/g, "")).toBe("ab")
  })

  it("keeps wrapped list-continuation math as inline, not a flow fence", () => {
    const nodes = parseMath(
      normalizeMathDelimiters("- Note that\n  \\(a + b\n  = c\\) holds.")
    )
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.type).toBe("inlineMath")
    expect(nodes[0]?.value.replace(/[\s\u200b]+/g, "")).toBe("a+b=c")
  })

  it("parses CR / CRLF multiline \\(...\\) as inline math", () => {
    const crlf = parseMath(normalizeMathDelimiters("\\(a\r\n\\)"))
    expect(crlf).toHaveLength(1)
    expect(crlf[0]?.type).toBe("inlineMath")
    expect(crlf[0]?.value.replace(/[\s\u200b]+/g, "")).toBe("a")

    const cr = parseMath(normalizeMathDelimiters("\\(a\rb\\)"))
    expect(cr).toHaveLength(1)
    expect(cr[0]?.type).toBe("inlineMath")
    expect(cr[0]?.value.replace(/[\s\u200b]+/g, "")).toBe("ab")
  })

  it("keeps every closing-line shape inside the formula", () => {
    // Each closing line is ambiguous from the line alone: a list marker,
    // one indented past the marker column, a tab-indented `>`, a `>` with no
    // enclosing blockquote. All are formula text and must survive.
    for (const [raw, keep] of [
      ["Before \\(a\n2. \\) after", "2."],
      ["Before \\(a\n    2. \\) after", "2."],
      ["paragraph\n2. \\(a\n2. \\) after", "2."],
      ["> \\(a\n\t> \\) after", ">"],
      ["> \\(a\n    > \\) after", ">"],
    ] as [string, string][]) {
      const nodes = parseMath(normalizeMathDelimiters(raw))
      expect(nodes).toHaveLength(1)
      expect(nodes[0]?.type).toBe("inlineMath")
      expect(nodes[0]?.value).toContain(keep)
    }
  })

  it("keeps container continuations inline whatever their shape", () => {
    // Uneven markers, `>>` vs `> >`, a list inside a quote, a quote inside a
    // list at content column 4, and a lazily continued quote whose opening
    // line carries no marker at all.
    for (const raw of [
      "> \\(a\n > b\n > \\)",
      ">> \\(a\n> > b\n> > \\)",
      "> - \\(a\n>   b\n>   \\)",
      "- > \\(a\n  > b\n  > \\)",
      "10. > \\(a\n    > b\n    > \\)\n    > after",
      "> intro\n\\(a\n> b\n> \\)\n> after",
      "> intro\n\\(a\n> \\)\n> after",
    ]) {
      const nodes = parseMath(normalizeMathDelimiters(raw))
      expect(nodes).toHaveLength(1)
      expect(nodes[0]?.type).toBe("inlineMath")
      expect(nodes[0]?.meta).toBeNull()
    }
  })

  it("pads container prefixes wider than three columns", () => {
    for (const raw of [
      "10. Note\n    \\(a\n    b\\)",
      "- outer\n  - inner\n    \\(a\n    b\\)",
      "- a\n  - b\n    - c\n      \\(x\n      y\\)",
    ]) {
      const nodes = parseMath(normalizeMathDelimiters(raw))
      expect(nodes).toHaveLength(1)
      expect(nodes[0]?.type).toBe("inlineMath")
      expect(nodes[0]?.meta).toBeNull()
    }
  })

  it("leaves multi-line inline code alone in LF, CRLF and CR form", () => {
    for (const eol of ["\n", "\r\n", "\r"]) {
      const text = `\`\\(a${eol}b\\)\``
      expect(parseMath(normalizeMathDelimiters(text))).toEqual([])
    }
  })
})

describe("block structure around a normalized formula", () => {
  function blockShape(text: string): string[] {
    const tree = unified()
      .use(remarkParse)
      .use(remarkMath, { singleDollarTextMath: false })
      .parse(text)
    const out: string[] = []
    visit(tree, (node) => {
      if (node.type === "paragraph") out.push("paragraph")
      if (node.type === "listItem") {
        out.push(`listItem(spread=${(node as { spread?: boolean }).spread})`)
      }
    })
    return out
  }

  // Relocating or dropping the closing line to keep `$$` off a line start
  // changes the surrounding block: a relocated prefix-only line is a BLANK
  // line, and a dropped one removes a soft break. Padding does neither.
  it("does not split the paragraph when prose follows the closer", () => {
    expect(blockShape(normalizeMathDelimiters("\\(a\nb\n\\)\nafter"))).toEqual([
      "paragraph",
    ])
    expect(
      blockShape(normalizeMathDelimiters("> \\(a\n> b\n> \\)\n> more text"))
    ).toEqual(["paragraph"])
  })

  it("keeps a list item tight when prose follows the closer", () => {
    expect(
      blockShape(normalizeMathDelimiters("- Note:\n  \\(a\n  b\n  \\)\n  more"))
    ).toEqual(["listItem(spread=false)", "paragraph"])
    expect(
      blockShape(
        normalizeMathDelimiters("- a\n  \\(x\n  y\n  \\)\n  tail\n- b")
      )
    ).toEqual([
      "listItem(spread=false)",
      "paragraph",
      "listItem(spread=false)",
      "paragraph",
    ])
  })
})
