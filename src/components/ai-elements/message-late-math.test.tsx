import { render, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

import { MessageResponse } from "./message"

// KaTeX is imported lazily (useStreamdownPlugins → ensure("math")), so a reply
// already on screen renders once without the math plugin and again when the
// plugin arrives. Streamdown memoizes paragraphs, list items and headings, and
// before 2.6 their comparators only looked at the source position — so those
// kept the first, math-less render: the display block (its own element) turned
// into KaTeX while inline `$$…$$` in the prose around it stayed literal dollar
// signs until the text itself changed. This drives the REAL Streamdown and
// KaTeX; message.test.tsx mocks both away.
const REPLY = [
  "## Heading with $$h_1$$",
  "",
  "Inline $$a^2+b^2=c^2$$ in a sentence.",
  "",
  "- a list item with $$x_1$$",
  "",
  "$$",
  "\\frac{1}{n}",
  "$$",
].join("\n")

describe("MessageResponse math that loads after the first render", () => {
  it("renders inline math in headings, prose and list items too", async () => {
    const { container } = render(<MessageResponse>{REPLY}</MessageResponse>)

    // The engine has not resolved yet: this is the render the memoized
    // elements used to keep.
    expect(container.querySelector(".katex")).toBeNull()

    await waitFor(
      () => expect(container.querySelector(".katex-display")).not.toBeNull(),
      { timeout: 10_000 }
    )

    // Query inside the callback: a repaint may swap the element itself.
    await waitFor(() => {
      const heading = container.querySelector("h2")
      const paragraph = [...container.querySelectorAll("p")].find((p) =>
        p.textContent?.includes("in a sentence")
      )
      const item = container.querySelector("li")
      for (const el of [heading, paragraph, item]) {
        expect(el).toBeInstanceOf(HTMLElement)
        expect(el!.querySelector(".katex")).not.toBeNull()
        expect(el!.textContent).not.toContain("$$")
      }
    })
  })
})
