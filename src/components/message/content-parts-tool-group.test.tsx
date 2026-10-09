import { type ReactNode } from "react"
import { render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

/**
 * A collapsed tool-group pill exists to summarize a RUN of calls. When a
 * reasoning block splits a turn into runs of one, the pill adds nothing but a
 * click — "Ran 1 command" hiding the very card the user wants to read. The
 * adapter still wraps every run uniformly; the renderer unwraps a one-item
 * group back into the direct tool card.
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

type ToolCallPartType = Extract<AdaptedContentPart, { type: "tool-call" }>

function settledBash(toolCallId: string, command: string): ToolCallPartType {
  return {
    type: "tool-call",
    toolCallId,
    toolName: "bash",
    displayTitle: command,
    input: JSON.stringify({ command, cwd: "/tmp/work" }),
    state: "output-available",
    output: "done",
    toolStatus: "completed",
    meta: null,
  }
}

function groupOf(...items: ToolCallPartType[]): AdaptedContentPart {
  return { type: "tool-group", items, isStreaming: false }
}

function renderParts(parts: AdaptedContentPart[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContentPartsRenderer parts={parts} role="assistant" />
    </NextIntlClientProvider>
  )
}

describe("tool-group renderer — lone call unwrapping", () => {
  it("renders a single call directly instead of a collapsed pill", () => {
    const { container } = renderParts([groupOf(settledBash("tc-1", "ls -la"))])
    expect(container.textContent).not.toContain("Ran 1 command")
    // The card itself is on screen without the click the pill would require.
    expect(container.textContent).toContain("ls -la")
  })

  it("keeps the collapsed pill once a run has two or more calls", () => {
    const { container } = renderParts([
      groupOf(settledBash("tc-1", "ls -la"), settledBash("tc-2", "pwd")),
    ])
    expect(container.textContent).toContain("Ran 2 commands")
  })

  it("still renders nothing for an empty group", () => {
    const { container } = renderParts([groupOf()])
    expect(container.textContent).toBe("")
  })
})
