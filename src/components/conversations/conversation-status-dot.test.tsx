import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { ConversationStatusDot } from "./conversation-status-dot"
import { STATUS_COLORS } from "@/lib/types"

afterEach(cleanup)

/** The dot's own element is the first span; callers often pass a `title`, which
 *  is what the accessibility tree exposes, so tests reach it by class instead. */
function dotOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector("span")
  if (!el) throw new Error("dot did not render a span")
  return el as HTMLElement
}

describe("ConversationStatusDot", () => {
  it("colours a plain dot from the conversation status", () => {
    const { container } = render(<ConversationStatusDot status="completed" />)
    const dot = dotOf(container)

    expect(dot.className).toContain(STATUS_COLORS.completed)
    // No attention mark, no pulse: a finished session sits still.
    expect(dot.className).not.toContain("animate-pulse")
    expect(dot.getAttribute("data-attention")).toBeNull()
  })

  it("lets attention outrank a status that would otherwise read as busy", () => {
    // The whole point of the mark: an awaiting session IS in_progress, so the
    // running colour would make a blocked session look like a busy one.
    const { container } = render(
      <ConversationStatusDot status="in_progress" attention="permission" />
    )
    const dot = dotOf(container)

    expect(dot.className).toContain("bg-violet-500")
    expect(dot.className).not.toContain(STATUS_COLORS.in_progress)
    expect(dot.getAttribute("data-attention")).toBe("permission")
  })

  it.each(["permission", "question", "plan"] as const)(
    "marks %s the same way, so the dot never claims which prompt it is",
    (kind) => {
      const { container } = render(
        <ConversationStatusDot status="in_progress" attention={kind} />
      )
      const dot = dotOf(container)

      // One hue for all three kinds; the kind travels in data-attention and the
      // card's own wording, not in a colour a 6px dot cannot deliver.
      expect(dot.className).toContain("bg-violet-500")
      expect(dot.getAttribute("data-attention")).toBe(kind)
    }
  )

  it("keeps the motion safe for callers that place the dot absolutely", () => {
    const { container } = render(
      <ConversationStatusDot
        attention="question"
        className="absolute right-1"
      />
    )
    const dot = dotOf(container)

    // `outline` takes no box and `animate-pulse` only touches opacity, so the
    // caller's own offsets survive and the sidebar virtualizer's row height
    // never changes mid-scroll.
    expect(dot.className).toContain("outline")
    expect(dot.className).toContain("animate-pulse")
    expect(dot.className).toContain("motion-reduce:animate-none")
    expect(dot.className).toContain("absolute right-1")
    expect(dot.className).not.toContain("relative")
  })

  it("hides itself from screen readers only when the caller supplies no title", () => {
    const withoutTitle = render(<ConversationStatusDot status="completed" />)
    expect(dotOf(withoutTitle.container).getAttribute("aria-hidden")).toBe(
      "true"
    )
    withoutTitle.unmount()

    // With a title the dot carries meaning, so it must stay in the tree.
    const withTitle = render(
      <ConversationStatusDot status="completed" title="Completed" />
    )
    const dot = dotOf(withTitle.container)
    expect(dot.getAttribute("aria-hidden")).toBeNull()
    expect(dot.getAttribute("title")).toBe("Completed")
  })

  it("applies the requested size and keeps caller classes last", () => {
    const { container } = render(
      <ConversationStatusDot size="xs" className="ring-0" />
    )
    expect(dotOf(container).className).toContain("h-1 w-1")
    expect(dotOf(container).className).toContain("ring-0")
  })
})
