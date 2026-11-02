import { describe, expect, it } from "vitest"
import { normalizeInlineDollarMath } from "./inline-dollar-math"

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
  ])("preserves literal or existing math input %s", (text) => {
    expect(normalizeInlineDollarMath(text)).toBe(text)
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
})
