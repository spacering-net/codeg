import { type ReactElement } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it } from "vitest"

import { CollapsibleSystemMessage } from "./collapsible-system-message"
import enMessages from "@/i18n/messages/en.json"
import { mockClampLayout } from "@/test-layout"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

// The shape Claude Code writes after `/compact`: a `user` record whose text
// starts with the continuation preamble, retagged to the system role by
// `is_context_continuation` in `parsers/claude.rs`.
const SUMMARY_PART: AdaptedContentPart[] = [
  {
    type: "text",
    text: "This session is being continued from a previous conversation",
  },
]

describe("CollapsibleSystemMessage", () => {
  let restoreMetrics: (() => void) | null = null

  afterEach(() => {
    restoreMetrics?.()
    restoreMetrics = null
  })

  it("shows the body up-front instead of hiding it behind a shut accordion", () => {
    renderWithIntl(<CollapsibleSystemMessage parts={SUMMARY_PART} />)

    expect(screen.getByText("System message")).toBeInTheDocument()
    expect(
      screen.getByText(
        "This session is being continued from a previous conversation"
      )
    ).toBeInTheDocument()
    // Short content: no toggle, no clamp fade.
    expect(
      screen.queryByTestId("collapsible-system-message-toggle")
    ).not.toBeInTheDocument()
    expect(
      screen.getByTestId("collapsible-system-message-content")
    ).not.toHaveClass("collapsed-content-fade")
  })

  it("clamps and offers Show more once the summary overflows", () => {
    restoreMetrics = mockClampLayout(900, 288)

    renderWithIntl(<CollapsibleSystemMessage parts={SUMMARY_PART} />)

    const content = screen.getByTestId("collapsible-system-message-content")
    const toggle = screen.getByTestId("collapsible-system-message-toggle")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(toggle).toHaveTextContent("Show more")
    expect(toggle).toHaveAttribute("aria-controls", content.id)
    expect(content).toHaveClass("max-h-72", "collapsed-content-fade")
    // Still readable while clipped — the preview is the point.
    expect(
      screen.getByText(
        "This session is being continued from a previous conversation"
      )
    ).toBeInTheDocument()
  })

  it("expands to Show less on click and collapses again", () => {
    restoreMetrics = mockClampLayout(900, 288)

    renderWithIntl(<CollapsibleSystemMessage parts={SUMMARY_PART} />)

    fireEvent.click(screen.getByTestId("collapsible-system-message-toggle"))

    const toggle = screen.getByTestId("collapsible-system-message-toggle")
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(toggle).toHaveTextContent("Show less")
    const content = screen.getByTestId("collapsible-system-message-content")
    expect(content).not.toHaveClass("max-h-72")
    expect(content).not.toHaveClass("collapsed-content-fade")

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(toggle).toHaveTextContent("Show more")
    expect(
      screen.getByTestId("collapsible-system-message-content")
    ).toHaveClass("max-h-72", "collapsed-content-fade")
  })
})
