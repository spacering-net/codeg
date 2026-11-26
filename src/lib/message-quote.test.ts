import { describe, expect, it } from "vitest"

import {
  buildQuotedMarkdown,
  parseQuoteBlocks,
  quoteMarkerLength,
} from "./message-quote"

describe("buildQuotedMarkdown", () => {
  it("prefixes a single line", () => {
    expect(buildQuotedMarkdown("hello world")).toBe("> hello world")
  })

  it("prefixes every line of a multi-line selection", () => {
    expect(buildQuotedMarkdown("first\nsecond\nthird")).toBe(
      "> first\n> second\n> third"
    )
  })

  it("keeps interior blank lines inside the same blockquote", () => {
    // A bare `>` continues the quote; an empty line would end it and leave the
    // rest as unquoted prose.
    expect(buildQuotedMarkdown("para one\n\npara two")).toBe(
      "> para one\n>\n> para two"
    )
  })

  it("drops leading and trailing blank lines", () => {
    expect(buildQuotedMarkdown("\n\n  \nkept\n \n\n")).toBe("> kept")
  })

  it("normalizes CRLF and CR newlines", () => {
    expect(buildQuotedMarkdown("a\r\nb\rc")).toBe("> a\n> b\n> c")
  })

  it("drops per-line trailing whitespace so it can't become a hard break", () => {
    expect(buildQuotedMarkdown("a  \nb\t")).toBe("> a\n> b")
  })

  it("preserves leading indentation inside the quote", () => {
    expect(buildQuotedMarkdown("fn main() {\n    let x = 1;\n}")).toBe(
      "> fn main() {\n>     let x = 1;\n> }"
    )
  })

  it("leaves Markdown markers in the selection literal", () => {
    expect(buildQuotedMarkdown("# Title\n- item")).toBe("> # Title\n> - item")
  })

  it("returns an empty string for a blank selection", () => {
    expect(buildQuotedMarkdown("")).toBe("")
    expect(buildQuotedMarkdown("   \n\t\n")).toBe("")
  })
})

describe("quoteMarkerLength", () => {
  it("measures a marker with and without its trailing space", () => {
    expect(quoteMarkerLength("> quoted")).toBe(2)
    expect(quoteMarkerLength(">quoted")).toBe(1)
    // A bare `>` is how buildQuotedMarkdown keeps an interior blank line inside
    // one quote, so it has to count.
    expect(quoteMarkerLength(">")).toBe(1)
  })

  it("allows up to three leading spaces, and no more", () => {
    // 3 spaces + `>` + its trailing space.
    expect(quoteMarkerLength("   > quoted")).toBe(5)
    // Four spaces is an indented code block in CommonMark, never a quote.
    expect(quoteMarkerLength("    > not a quote")).toBe(0)
  })

  it("takes only one level, and only one space after it", () => {
    // The caller strips a level and re-measures, so `> > x` nests.
    expect(quoteMarkerLength("> > x")).toBe(2)
    expect(quoteMarkerLength(">>x")).toBe(1)
    // A second space belongs to the quoted content (indentation), not the marker.
    expect(quoteMarkerLength(">  indented")).toBe(2)
  })

  it("does not accept a tab after the marker", () => {
    // Swallowing a tab would hide a wide, visible indent behind the rule.
    expect(quoteMarkerLength(">\tquoted")).toBe(1)
  })

  it("rejects a `>` that is not line-leading", () => {
    expect(quoteMarkerLength("x > y")).toBe(0)
    expect(quoteMarkerLength("")).toBe(0)
  })
})

describe("parseQuoteBlocks", () => {
  it("returns unquoted text as a single verbatim block", () => {
    // The fast path the bubble renderer relies on.
    expect(parseQuoteBlocks("just some text")).toEqual([
      { kind: "text", text: "just some text" },
    ])
    expect(parseQuoteBlocks("# Heading\n**bold**\n- item")).toEqual([
      { kind: "text", text: "# Heading\n**bold**\n- item" },
    ])
  })

  it("groups consecutive quoted lines into one block, markers stripped", () => {
    expect(parseQuoteBlocks("> first\n> second")).toEqual([
      { kind: "quote", children: [{ kind: "text", text: "first\nsecond" }] },
    ])
  })

  it("keeps a bare `>` as a blank line inside the same quote", () => {
    expect(parseQuoteBlocks("> a\n>\n> b")).toEqual([
      { kind: "quote", children: [{ kind: "text", text: "a\n\nb" }] },
    ])
  })

  it("nests a doubly-marked line", () => {
    expect(parseQuoteBlocks("> > x")).toEqual([
      {
        kind: "quote",
        children: [{ kind: "quote", children: [{ kind: "text", text: "x" }] }],
      },
    ])
  })

  it("ends the quote at the first unmarked line (no lazy continuation)", () => {
    // CommonMark would absorb the second line into the quote. Being stricter
    // keeps prose that merely follows a quote from being swallowed.
    expect(parseQuoteBlocks("> quoted\ntrailing prose")).toEqual([
      { kind: "quote", children: [{ kind: "text", text: "quoted" }] },
      { kind: "text", text: "trailing prose" },
    ])
  })

  it("swallows exactly one blank line at each quote boundary", () => {
    // This is the shape the quote action produces: quote, blank separator, then
    // whatever the user types. The blank line is structure, not content.
    expect(parseQuoteBlocks("> quoted\n\nmy question")).toEqual([
      { kind: "quote", children: [{ kind: "text", text: "quoted" }] },
      { kind: "text", text: "my question" },
    ])
    expect(parseQuoteBlocks("lead-in\n\n> quoted")).toEqual([
      { kind: "text", text: "lead-in" },
      { kind: "quote", children: [{ kind: "text", text: "quoted" }] },
    ])
    // A second blank line is deliberate spacing and survives.
    expect(parseQuoteBlocks("> quoted\n\n\nmy question")).toEqual([
      { kind: "quote", children: [{ kind: "text", text: "quoted" }] },
      { kind: "text", text: "\nmy question" },
    ])
  })

  it("splits two quotes separated by a blank line, consuming it once", () => {
    expect(parseQuoteBlocks("> a\n\n> b")).toEqual([
      { kind: "quote", children: [{ kind: "text", text: "a" }] },
      { kind: "quote", children: [{ kind: "text", text: "b" }] },
    ])
  })

  it("round-trips what buildQuotedMarkdown produces", () => {
    const selection = "para one\n\npara two"
    expect(parseQuoteBlocks(buildQuotedMarkdown(selection))).toEqual([
      { kind: "quote", children: [{ kind: "text", text: selection }] },
    ])
  })

  it("keeps indentation inside a quoted code selection", () => {
    expect(
      parseQuoteBlocks(buildQuotedMarkdown("fn main() {\n    let x = 1;\n}"))
    ).toEqual([
      {
        kind: "quote",
        children: [{ kind: "text", text: "fn main() {\n    let x = 1;\n}" }],
      },
    ])
  })
})
