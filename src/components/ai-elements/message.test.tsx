import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

vi.mock("streamdown", () => ({
  Streamdown: ({
    children,
    className,
    mode,
    parseIncompleteMarkdown,
    dir,
  }: {
    children: ReactNode
    className?: string
    mode?: string
    parseIncompleteMarkdown?: boolean
    dir?: string
  }) => (
    <div
      className={className}
      data-testid="streamdown-root"
      data-mode={mode}
      data-parse-incomplete={String(parseIncompleteMarkdown)}
      data-dir={dir}
    >
      {children}
    </div>
  ),
  defaultRemarkPlugins: {},
  defaultRehypePlugins: {},
}))

vi.mock("@streamdown/cjk", () => ({ cjk: {} }))
vi.mock("@streamdown/math", () => ({
  createMathPlugin: () => ({}),
}))
vi.mock("@streamdown/mermaid", () => ({ mermaid: {} }))
vi.mock("@/lib/code-highlighter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/code-highlighter")>()),
  createCodePlugin: async () => ({
    name: "shiki",
    type: "code-highlighter",
    highlight: vi.fn(),
    supportsLanguage: vi.fn(() => true),
    getSupportedLanguages: () => [],
    getThemes: () => ["github-light", "github-dark"],
  }),
}))

vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

import {
  Message,
  MessageContent,
  MessageResponse,
  normalizeMathDelimiters,
} from "./message"

describe("MessageContent", () => {
  it("rounds a user's bubble into a capsule", () => {
    render(
      <Message from="user">
        <MessageContent>Run the tests</MessageContent>
      </Message>
    )
    const bubble = screen.getByText("Run the tests")
    expect(bubble).toHaveClass("group-[.is-user]:rounded-3xl")
    expect(bubble).not.toHaveClass("group-[.is-user]:rounded-lg")
  })
})

describe("MessageResponse", () => {
  it("applies marker styles so ordered Markdown lists render as lists", () => {
    render(<MessageResponse>{"1. First\n2. Second"}</MessageResponse>)

    expect(screen.getByTestId("streamdown-root")).toHaveClass(
      "[&_ol]:list-decimal",
      "[&_ol]:ps-2",
      "[&_li]:text-start"
    )
  })

  it("reads each block in the direction of its own text", () => {
    render(<MessageResponse>{"Hello."}</MessageResponse>)

    expect(screen.getByTestId("streamdown-root")).toHaveAttribute(
      "data-dir",
      "auto"
    )
  })

  it("keeps finished replies in static mode so remend cannot append leftover * / _", () => {
    render(
      <MessageResponse>{"see `tools/dsv4-0731-c1/*` please."}</MessageResponse>
    )

    const root = screen.getByTestId("streamdown-root")
    expect(root).toHaveAttribute("data-mode", "static")
    expect(root).toHaveAttribute("data-parse-incomplete", "false")
  })

  it("opts the live stream back into remend", () => {
    render(
      <MessageResponse mode="streaming" parseIncompleteMarkdown>
        {"see `tools/dsv4-0731-c1/*` please."}
      </MessageResponse>
    )

    const root = screen.getByTestId("streamdown-root")
    expect(root).toHaveAttribute("data-mode", "streaming")
    expect(root).toHaveAttribute("data-parse-incomplete", "true")
  })

  it("re-declares the blockquote rule Streamdown's own classes lose", () => {
    // Streamdown sets `border-l-4 border-muted-foreground/30 … italic` on
    // blockquotes from inside node_modules, which Tailwind v4 does not scan — so
    // those utilities generate no CSS and a quote renders with no rule at all.
    // Declaring them here (scanned source) is what actually paints them — on
    // the quote's start side, which follows the direction of its text.
    render(<MessageResponse>{"> quoted"}</MessageResponse>)

    expect(screen.getByTestId("streamdown-root")).toHaveClass(
      "[&_blockquote]:border-s-2",
      "[&_blockquote]:border-border",
      "[&_blockquote]:ps-4",
      "[&_blockquote]:pe-0",
      "[&_blockquote]:not-italic"
    )
  })
})

describe("normalizeMathDelimiters", () => {
  const Z = "\u200b"

  it("normalizes \\[...\\] to $$...$$", () => {
    expect(normalizeMathDelimiters("\\[ x^2 \\]")).toBe("$$ x^2 $$")
  })

  it("normalizes \\(...\\) to $$...$$", () => {
    expect(normalizeMathDelimiters("\\( y \\)")).toBe("$$ y $$")
  })

  it("does not rewrite currency or shell $ tokens", () => {
    // Currency and unpaired shell variables must stay literal.
    const text = "Costs $25. Set $HOME and $1."
    expect(normalizeMathDelimiters(text)).toBe(text)
  })

  it("leaves a single-line formula unpadded", () => {
    expect(normalizeMathDelimiters("Also \\(x\\).")).toBe("Also $$x$$.")
  })

  it("pads a multi-line closer so it cannot open a flow fence", () => {
    // The closing pad sits INSIDE the formula, where KaTeX ignores it, so it
    // is emitted unconditionally rather than trying to decide whether the
    // last line is container prefix or TeX.
    expect(normalizeMathDelimiters("\\(a\nb\\)")).toBe(`${Z}$$a\nb${Z}$$`)
    expect(normalizeMathDelimiters("\\(a\nb\n\\)")).toBe(`${Z}$$a\nb\n${Z}$$`)
    expect(normalizeMathDelimiters("> \\(a\n> b\n> \\)")).toBe(
      `> ${Z}$$a\n> b\n> ${Z}$$`
    )
  })

  it("pads a multi-line opener only at block content start", () => {
    expect(normalizeMathDelimiters("text \\(a\nb\\) tail")).toBe(
      `text $$a\nb${Z}$$ tail`
    )
    expect(normalizeMathDelimiters("+ \\(a\n  b\\)")).toBe(
      `+ ${Z}$$a\n  b${Z}$$`
    )
    expect(normalizeMathDelimiters(" \\(a\nb\\)")).toBe(` ${Z}$$a\nb${Z}$$`)
    expect(normalizeMathDelimiters("   \\(a\nb\\)")).toBe(`   ${Z}$$a\nb${Z}$$`)
    expect(normalizeMathDelimiters("-  \\(a\n   b\\)")).toBe(
      `-  ${Z}$$a\n   b${Z}$$`
    )
    expect(normalizeMathDelimiters(">  \\(a\n>  b\\)")).toBe(
      `>  ${Z}$$a\n>  b${Z}$$`
    )
  })

  it("pads a container prefix wider than three columns", () => {
    expect(normalizeMathDelimiters("10. Note\n    \\(a\n    b\\)")).toBe(
      `10. Note\n    ${Z}$$a\n    b${Z}$$`
    )
    expect(
      normalizeMathDelimiters("- outer\n  - inner\n    \\(a\n    b\\)")
    ).toBe(`- outer\n  - inner\n    ${Z}$$a\n    b${Z}$$`)
  })

  it("never removes formula text, whatever the closing line looks like", () => {
    // Each of these closing lines is ambiguous from the line alone — a list
    // marker, a tab-indented `>`, a `>` outside any blockquote. Padding
    // instead of classifying keeps them all.
    expect(normalizeMathDelimiters("Before \\(a\n2. \\) after")).toBe(
      `Before $$a\n2. ${Z}$$ after`
    )
    expect(normalizeMathDelimiters("> \\(a\n\t> \\) after")).toBe(
      `> ${Z}$$a\n\t> ${Z}$$ after`
    )
    expect(normalizeMathDelimiters("\\(a\n> \\)")).toBe(`${Z}$$a\n> ${Z}$$`)
  })

  it("does not collapse newlines inside \\(...\\) (TeX % comments)", () => {
    expect(normalizeMathDelimiters("\\(a % comment\nb + c\\)")).toBe(
      `${Z}$$a % comment\nb + c${Z}$$`
    )
  })

  it("canonicalizes CR / CRLF outside code", () => {
    expect(normalizeMathDelimiters("\\(a\r\n\\)")).toBe(`${Z}$$a\n${Z}$$`)
    expect(normalizeMathDelimiters("\\(a\rb\\)")).toBe(`${Z}$$a\nb${Z}$$`)
    expect(normalizeMathDelimiters("\\(a\r\nb\\)")).toBe(`${Z}$$a\nb${Z}$$`)
  })

  it("masks inline code before folding line endings", () => {
    // The inline-code pattern tolerates a bare CR. Folding first would
    // un-mask this span and rewrite the delimiters inside it.
    const text = "`\\(a\rb\\)`"
    expect(normalizeMathDelimiters(text)).toBe(text)
  })

  it("scans container prefixes in one pass, without backtracking", () => {
    // The predecessor regex was exponential here: ~910ms at 26 markers.
    // Compare scaling rather than wall-clock, so a loaded machine cannot
    // flake this — a quadratic scan blows the ratio long before any budget.
    const run = (n: number) => {
      const text = `${"> ".repeat(n)}x \\(a\nb\\)`
      const start = performance.now()
      const out = normalizeMathDelimiters(text)
      expect(out).toContain("$$a\nb")
      expect(out.startsWith(Z)).toBe(false)
      return performance.now() - start
    }
    run(200) // warm up, so the ratio below is not measuring first-call JIT
    const small = Math.max(run(200), 0.05)
    const large = run(4000)
    expect(large / small).toBeLessThan(20 * 5)
  })

  it("preserves inline and fenced code blocks", () => {
    expect(normalizeMathDelimiters("Use `$x` in `\\(y\\)`")).toBe(
      "Use `$x` in `\\(y\\)`"
    )
    expect(normalizeMathDelimiters("```\n\\(a\\)\n```")).toBe(
      "```\n\\(a\\)\n```"
    )
  })

  it("normalizes mixed LaTeX and currency correctly", () => {
    const input = "Costs $25 and the equation \\(x^2 + y^2\\)."
    const expected = "Costs $25 and the equation $$x^2 + y^2$$."
    expect(normalizeMathDelimiters(input)).toBe(expected)
  })
})
