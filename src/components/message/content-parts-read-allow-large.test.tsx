import { type ReactNode } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

/**
 * Claude Code 2.1.296's Read takes `allow_large` to read a text file, or a
 * line range of one, past the usual size limits. The call is otherwise an
 * ordinary read of the path, so the row has to say why it is so large.
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

type AdaptedToolCallPart = Extract<AdaptedContentPart, { type: "tool-call" }>

const PATH = "/w/logs/build.log"

function fileTool(
  toolName: string,
  input: Record<string, unknown>
): AdaptedToolCallPart {
  return {
    type: "tool-call",
    toolCallId: `toolu_${toolName}`,
    toolName,
    input: JSON.stringify(input),
    state: "output-available",
    output: "line one\nline two",
  }
}

function renderRow(part: AdaptedContentPart) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContentPartsRenderer parts={[part]} role="assistant" />
    </NextIntlClientProvider>
  )
}

describe("Read row — allow_large", () => {
  it("says the read went past the usual size limits", () => {
    for (const allowLarge of [true, "true"]) {
      const { unmount } = renderRow(
        fileTool("Read", { file_path: PATH, allow_large: allowLarge })
      )
      expect(screen.getByText(PATH)).toBeInTheDocument()
      expect(screen.getByText("Over size limit")).toBeInTheDocument()
      unmount()
    }
  })

  it("says nothing for an ordinary read", () => {
    for (const input of [
      { file_path: PATH },
      { file_path: PATH, allow_large: false },
      { file_path: PATH, allow_large: "false" },
    ]) {
      const { unmount } = renderRow(fileTool("Read", input))
      expect(screen.getByText(PATH)).toBeInTheDocument()
      expect(screen.queryByText("Over size limit")).not.toBeInTheDocument()
      unmount()
    }
  })

  it("is Read's own argument, not a Write's", () => {
    renderRow(
      fileTool("Write", { file_path: PATH, content: "x", allow_large: true })
    )
    // The write's row names the file it wrote…
    expect(screen.getByText("build.log")).toBeInTheDocument()
    // …opened or not, with no size-limit note.
    expect(screen.queryByText("Over size limit")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button"))
    expect(screen.queryByText("Over size limit")).not.toBeInTheDocument()
  })
})
