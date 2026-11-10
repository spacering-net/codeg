import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

const captured = vi.hoisted(() => ({
  remarkPlugins: [] as unknown[],
}))

vi.mock("streamdown", () => ({
  Streamdown: ({
    children,
    className,
    mode,
    parseIncompleteMarkdown,
    remarkPlugins,
  }: {
    children: ReactNode
    className?: string
    mode?: string
    parseIncompleteMarkdown?: boolean
    remarkPlugins?: unknown[]
  }) => {
    captured.remarkPlugins = remarkPlugins ?? []
    return (
      <div
        data-testid="streamdown-root"
        className={className}
        data-mode={mode}
        data-parse-incomplete={String(parseIncompleteMarkdown)}
      >
        {children}
      </div>
    )
  },
  defaultRemarkPlugins: {},
  defaultRehypePlugins: {},
}))

vi.mock("@streamdown/cjk", () => ({ cjk: {} }))
vi.mock("@streamdown/math", () => ({ createMathPlugin: () => ({}) }))
vi.mock("@streamdown/mermaid", () => ({ mermaid: {} }))
vi.mock("@streamdown/code", () => ({
  code: { highlight: vi.fn(), supportsLanguage: vi.fn(() => true) },
}))

vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

import { ReasoningMarkdown } from "./reasoning"

function tree(isStreaming: boolean) {
  return (
    <ReasoningMarkdown isStreaming={isStreaming}>
      {"see `tools/dsv4-c1/*` please."}
    </ReasoningMarkdown>
  )
}

describe("ReasoningMarkdown", () => {
  // A reader who opens a thought mid-turn keeps it mounted across every delta,
  // so its body is still on the streaming hot path: pinning it static would
  // re-parse the whole block on every delta instead of only its tail.
  it("keeps the live block in streaming mode", () => {
    render(tree(true))

    const root = screen.getByTestId("streamdown-root")
    expect(root).toHaveAttribute("data-mode", "streaming")
    expect(root).toHaveAttribute("data-parse-incomplete", "true")
  })

  it("drops to static once thinking has settled, so remend cannot append leftover * / _", () => {
    render(tree(false))

    const root = screen.getByTestId("streamdown-root")
    expect(root).toHaveAttribute("data-mode", "static")
    expect(root).toHaveAttribute("data-parse-incomplete", "false")
  })

  // Numbered and bulleted, the marker inside the text column: outside it, a
  // bullet would sit on the timeline's rail beside the thought.
  it("draws a thought's lists the way a reply's draw", () => {
    render(tree(false))

    expect(screen.getByTestId("streamdown-root")).toHaveClass(
      "[&_ol]:list-decimal",
      "[&_ul]:list-disc",
      "[&_ol]:list-inside",
      "[&_ul]:list-inside",
      "[&_ol]:ps-2",
      "[&_ul]:ps-2"
    )
  })

  // The transition is the case that matters: the text does not change on the
  // last delta, only whether it is still streaming.
  it("repaints when thinking ends even though its text did not change", () => {
    const { rerender } = render(tree(true))
    expect(screen.getByTestId("streamdown-root")).toHaveAttribute(
      "data-mode",
      "streaming"
    )

    rerender(tree(false))

    const root = screen.getByTestId("streamdown-root")
    expect(root).toHaveAttribute("data-mode", "static")
    expect(root).toHaveAttribute("data-parse-incomplete", "false")
  })

  // Reasoning is written a line at a time. Streamdown caches its processors
  // by the plugins' function names, which a minified build shortens — so the
  // breaks plugin carries a name of its own, or the reply's processor (a list
  // just as long, without it) gets reused and the breaks are lost.
  it("keeps a line break a line break, under a name a minified build keeps", () => {
    render(tree(false))
    const breaks = captured.remarkPlugins.find(
      (plugin) =>
        typeof plugin === "function" && plugin.name === "remarkReasoningBreaks"
    ) as (() => (tree: unknown) => void) | undefined
    expect(breaks).toBeDefined()
    const paragraph = {
      type: "paragraph",
      children: [{ type: "text", value: "list the files\nthen read them" }],
    }
    breaks!()({ type: "root", children: [paragraph] })
    expect(paragraph.children.map((node) => node.type)).toEqual([
      "text",
      "break",
      "text",
    ])
  })
})
