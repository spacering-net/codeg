import { fromMarkdown } from "mdast-util-from-markdown"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  hasInlineDollarMathCandidate,
  normalizeInlineDollarMath,
} from "./inline-dollar-math"

vi.mock("mdast-util-from-markdown", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("mdast-util-from-markdown")>()
  return { ...actual, fromMarkdown: vi.fn(actual.fromMarkdown) }
})

beforeEach(() => {
  vi.mocked(fromMarkdown).mockClear()
})

describe("normalizeInlineDollarMath", () => {
  it.each([
    "T",
    "AV",
    "A - T",
    "V - T",
    "\\Gamma^0, \\Gamma^C",
    "\\mathcal{U}^{AV}",
    "x^2 + y^2",
    "E=mc^2",
    "f(x)",
  ])("normalizes the inline formula %s", (formula) => {
    expect(normalizeInlineDollarMath(`正文 $${formula}$。`)).toBe(
      `正文 $$${formula}$$。`
    )
  })

  it.each([
    '    echo "$AV$"',
    "```tex\n$AV$",
    "- item\n\n      $AV$",
    "Costs $25. Set $HOME and $1.",
    "$5 to $10",
    "$5-$10",
    "$HOME/$USER",
    "${HOME}/${USER}",
    "$PATH:$HOME",
    "US$5",
    "echo $A$B",
    "$FOO + $BAR",
    "\\$x^2\\$",
    "$ x$",
    "$x $",
    "$x\ny$",
    "$25$",
    "$ordinary prose$",
    "An unfinished $x^2",
    "$$x + $y$ $$",
    "$$\nx + $y$\n$$",
    "$$\nx + $y$",
    "$$$\nx + $y$\n$$$",
    "$x\0CBLK0\0y$",
    // An escaped dollar before the closer would merge into a `$$$` run.
    "$a\\$$ end",
    // Raw HTML blocks are not Markdown, so remark-math never renders them.
    "<pre>\n$x^2$\n</pre>",
    "<div>\n$AV$ text\n</div>",
    // A closer that opens another shell expansion is not a formula end.
    'echo "$prefix${suffix}"',
    "echo $A$@",
    '$(git rev-parse --show-toplevel)/$(basename "$PWD")',
    "$(a)-$(b)",
  ])("preserves literal or existing math input %s", (text) => {
    expect(normalizeInlineDollarMath(text)).toBe(text)
  })

  it("keeps prose punctuation after a closer, such as a question mark", () => {
    // `$?` / `$!` stay allowed: "is it $x$?" is far more common in replies
    // than an unquoted `echo $A$?` outside code.
    expect(normalizeInlineDollarMath("Is it $x$? Then $n$!")).toBe(
      "Is it $$x$$? Then $$n$$!"
    )
  })

  it("continues after a display fence with a longer closer", () => {
    expect(normalizeInlineDollarMath("$$\nx^2\n$$$\n\n$T$")).toBe(
      "$$\nx^2\n$$$\n\n$$T$$"
    )
  })

  it("continues after rejected currency and normalizes multiple formulas", () => {
    expect(normalizeInlineDollarMath("$5,$x^2$ and $AV$")).toBe(
      "$5,$$x^2$$ and $$AV$$"
    )
  })

  it("preserves escaped dollars inside formulas and is idempotent", () => {
    const normalized = normalizeInlineDollarMath("$x + \\$5$ and $T$")
    expect(normalized).toBe("$$x + \\$5$$ and $$T$$")
    expect(normalizeInlineDollarMath(normalized)).toBe(normalized)
  })

  it("skips the Markdown parse when no pair can be a formula", () => {
    const text = "Set `$HOME`:\n\n```bash\necho $PATH:$FOO\n```\n\nCosts $5."
    expect(normalizeInlineDollarMath(text)).toBe(text)
    expect(fromMarkdown).not.toHaveBeenCalled()
  })

  it("still parses to protect code once a candidate exists", () => {
    const text = "`$T$` and $AV$"
    expect(normalizeInlineDollarMath(text)).toBe("`$T$` and $$AV$$")
    expect(fromMarkdown).toHaveBeenCalledTimes(1)
  })
})

describe("hasInlineDollarMathCandidate", () => {
  it.each([
    "正文 $T$。",
    "$5,$x^2$ and $AV$",
    "`$T$`",
    "```tex\n$AV$",
    "$$x + $y$ $$",
  ])("is a parse-free superset of the rewrite: %s", (text) => {
    expect(hasInlineDollarMathCandidate(text)).toBe(true)
    expect(fromMarkdown).not.toHaveBeenCalled()
  })

  it.each(["Costs $25. Set $HOME and $1.", "$5-$10", "echo $A$B", "$a\\$$"])(
    "is false when no adjacent pair qualifies: %s",
    (text) => {
      expect(hasInlineDollarMathCandidate(text)).toBe(false)
      expect(normalizeInlineDollarMath(text)).toBe(text)
    }
  )
})
