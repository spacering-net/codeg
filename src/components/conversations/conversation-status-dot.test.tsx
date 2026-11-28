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
    // 没有等待标记，也没有动画：已完成的会话是静止的。
    expect(dot.className).not.toContain("animate-pulse")
    expect(dot.getAttribute("data-attention")).toBeNull()
  })

  it("lets attention outrank a status that would otherwise read as busy", () => {
    // 这个标记的全部意义：等待中的会话本身就是 in_progress，用运行色会把
    // 一个被卡住的会话画成忙碌的。
    const { container } = render(
      <ConversationStatusDot status="in_progress" attention="permission" />
    )
    const dot = dotOf(container)

    expect(dot.className).toContain("bg-violet-500")
    expect(dot.className).toContain("dark:bg-violet-400")
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

      // 三种等待共用一个紫色；种类落在 data-attention 和卡片自己的图标/文案
      // 上，不由 6 像素的圆点区分。
      expect(dot.className).toContain("bg-violet-500")
      expect(dot.getAttribute("data-attention")).toBe(kind)
    }
  )

  it("stays static and box-free, so absolute callers keep their own geometry", () => {
    const { container } = render(
      <ConversationStatusDot
        attention="question"
        className="absolute right-1"
      />
    )
    const dot = dotOf(container)

    // 等待提示静态显示，保留调用方指定的绝对定位。
    expect(dot.className).not.toContain("animate-pulse")
    expect(dot.className).not.toContain("outline")
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
