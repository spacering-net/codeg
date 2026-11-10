import { type ReactElement } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it } from "vitest"

import { CollapsibleUserMessage } from "./collapsible-user-message"
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

const TEXT_PART: AdaptedContentPart[] = [{ type: "text", text: "hello world" }]

describe("CollapsibleUserMessage", () => {
  let restoreMetrics: (() => void) | null = null

  afterEach(() => {
    restoreMetrics?.()
    restoreMetrics = null
  })

  it("renders short content with no toggle", () => {
    renderWithIntl(<CollapsibleUserMessage parts={TEXT_PART} />)

    expect(screen.getByText("hello world")).toBeInTheDocument()
    expect(
      screen.queryByTestId("collapsible-user-message-toggle")
    ).not.toBeInTheDocument()
    expect(
      screen.getByTestId("collapsible-user-message-content")
    ).not.toHaveClass("collapsed-content-fade")
  })

  it("shows a Show more toggle when content overflows the collapsed height", () => {
    restoreMetrics = mockClampLayout(600, 240)

    renderWithIntl(<CollapsibleUserMessage parts={TEXT_PART} />)

    const content = screen.getByTestId("collapsible-user-message-content")
    const toggle = screen.getByTestId("collapsible-user-message-toggle")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(toggle).toHaveTextContent("Show more")
    expect(toggle).toHaveAttribute("aria-controls", content.id)
    expect(content).toHaveClass("max-h-60", "collapsed-content-fade")
  })

  it("comes back with its toggle when it mounts again", () => {
    // The thread is virtualized: scrolled away and back, a message mounts
    // again, and drawing it without its toggle until it is measured would
    // change its height under the list.
    const parts: AdaptedContentPart[] = [{ type: "text", text: "a long ask" }]
    restoreMetrics = mockClampLayout(600, 240)
    const first = renderWithIntl(<CollapsibleUserMessage parts={parts} />)
    expect(screen.getByTestId("collapsible-user-message-toggle")).toBeTruthy()
    first.unmount()
    restoreMetrics()
    // No layout this time (the observer has not reported yet).
    restoreMetrics = null

    renderWithIntl(<CollapsibleUserMessage parts={parts} />)
    expect(screen.getByTestId("collapsible-user-message-toggle")).toBeTruthy()
    expect(screen.getByTestId("collapsible-user-message-content")).toHaveClass(
      "collapsed-content-fade"
    )
  })

  it("starts other content unmeasured", () => {
    renderWithIntl(
      <CollapsibleUserMessage parts={[{ type: "text", text: "another" }]} />
    )
    expect(
      screen.queryByTestId("collapsible-user-message-toggle")
    ).not.toBeInTheDocument()
  })

  it("expands to Show less on click and removes the clamp", () => {
    restoreMetrics = mockClampLayout(600, 240)

    renderWithIntl(<CollapsibleUserMessage parts={TEXT_PART} />)

    fireEvent.click(screen.getByTestId("collapsible-user-message-toggle"))

    const toggle = screen.getByTestId("collapsible-user-message-toggle")
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(toggle).toHaveTextContent("Show less")
    const content = screen.getByTestId("collapsible-user-message-content")
    expect(content).not.toHaveClass("max-h-60")
    expect(content).not.toHaveClass("collapsed-content-fade")

    // Clicking again re-collapses.
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(toggle).toHaveTextContent("Show more")
  })
})
