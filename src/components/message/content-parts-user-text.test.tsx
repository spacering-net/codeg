import { type ReactNode } from "react"
import { render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

/**
 * A user turn reopened from history can arrive with an EMPTY text part: the
 * `@`-mention routing frame travels as its own prompt block, and the parsers
 * that keep one block per recorded text item hand back `[prose, ""]` once the
 * backend has stripped it. The empty part renders nothing, but the renderer
 * stacks parts in `space-y-4`, so it still took a full gap — a blank band under
 * the bubble text that was absent when the message was first sent.
 */

vi.mock("@/components/ai-elements/link-safety", () => ({
  FilePathLink: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

vi.mock("@/components/ai-elements/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}))

vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div>{children}</div>
  ),
}))

import { ContentPartsRenderer } from "./content-parts-renderer"
import enMessages from "@/i18n/messages/en.json"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"

function renderParts(parts: AdaptedContentPart[], role: "user" | "assistant") {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContentPartsRenderer parts={parts} role={role} />
    </NextIntlClientProvider>
  )
}

/** Direct children of the `space-y-4` stack — one per part that rendered. */
function stackedChildren(container: HTMLElement): number {
  const stack = container.querySelector(".space-y-4")
  return stack?.children.length ?? -1
}

describe("ContentPartsRenderer — empty user text parts", () => {
  const PROSE = "ask [@Codex CLI](codeg://agent/codex) to build a test page"

  it("renders one stack child for one text part", () => {
    const { container } = renderParts([{ type: "text", text: PROSE }], "user")
    expect(stackedChildren(container)).toBe(1)
  })

  it("does not stack a residual empty part below the prose", () => {
    const { container } = renderParts(
      [
        { type: "text", text: PROSE },
        { type: "text", text: "" },
      ],
      "user"
    )
    expect(stackedChildren(container)).toBe(1)
    expect(container.textContent).toContain("to build a test page")
  })

  it("drops a whitespace-only part too", () => {
    const { container } = renderParts(
      [
        { type: "text", text: PROSE },
        { type: "text", text: "\n" },
      ],
      "user"
    )
    expect(stackedChildren(container)).toBe(1)
  })

  it("leaves assistant text alone — an empty part there can be a live stream", () => {
    const { container } = renderParts(
      [
        { type: "text", text: "on it" },
        { type: "text", text: "" },
      ],
      "assistant"
    )
    expect(stackedChildren(container)).toBe(2)
  })
})
