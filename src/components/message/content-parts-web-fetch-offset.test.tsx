import { type ReactNode } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

/**
 * Claude Code 2.1.290's WebFetch reads a page past its 100,000-character
 * window from an `offset`. The call is otherwise the same URL and prompt as
 * the first read, so the card has to say where it reads from.
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

function webFetch(input: Record<string, unknown>): AdaptedToolCallPart {
  return {
    type: "tool-call",
    toolCallId: "toolu_fetch",
    toolName: "WebFetch",
    input: JSON.stringify(input),
    state: "output-available",
    output: "The page continues.",
  }
}

function renderOpen(part: AdaptedContentPart) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContentPartsRenderer parts={[part]} role="assistant" />
    </NextIntlClientProvider>
  )
  // The input sits in the card body; open it if the card starts collapsed.
  if (!screen.queryByText("https://example.com/long")) {
    fireEvent.click(screen.getByText(/WebFetch/))
  }
}

describe("WebFetch card — read offset", () => {
  it("names the character offset a continued read starts from", () => {
    renderOpen(
      webFetch({
        url: "https://example.com/long",
        prompt: "Summarize",
        offset: 100000,
      })
    )
    expect(screen.getByText("https://example.com/long")).toBeInTheDocument()
    expect(screen.getByText("Offset: 100000")).toBeInTheDocument()
  })

  it("shows no offset for a first read", () => {
    renderOpen(webFetch({ url: "https://example.com/long", prompt: "Read" }))
    expect(screen.getByText("https://example.com/long")).toBeInTheDocument()
    expect(screen.queryByText(/Offset:/)).not.toBeInTheDocument()
  })

  it("shows no offset for a zero or non-numeric one", () => {
    for (const offset of [0, "100000"]) {
      const { unmount } = render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <ContentPartsRenderer
            parts={[webFetch({ url: "https://example.com/long", offset })]}
            role="assistant"
          />
        </NextIntlClientProvider>
      )
      if (!screen.queryByText("https://example.com/long")) {
        fireEvent.click(screen.getByText(/WebFetch/))
      }
      expect(screen.queryByText(/Offset:/)).not.toBeInTheDocument()
      unmount()
    }
  })
})
