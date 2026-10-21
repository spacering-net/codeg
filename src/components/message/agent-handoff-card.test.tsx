import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

// Inline SVG marks carry a <title> that would duplicate the agent label in
// text queries.
vi.mock("@/components/agent-icon", () => ({ AgentIcon: () => null }))

import { AgentHandoffCard } from "./agent-handoff-card"
import enMessages from "@/i18n/messages/en.json"

function renderCard(meta: Record<string, unknown> | null) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AgentHandoffCard meta={meta} />
    </NextIntlClientProvider>
  )
}

describe("AgentHandoffCard", () => {
  it("names both agents and says the context moved natively", () => {
    renderCard({
      "codeg.handoff": {
        version: 1,
        from: "claude_code",
        to: "codex",
        path: "native",
        carried: true,
        truncated: false,
      },
    })
    expect(
      screen.getByText("Handed off from Claude Code to Codex")
    ).toBeInTheDocument()
    expect(screen.getByText("· Full context carried over")).toBeInTheDocument()
    expect(screen.queryByText("Show briefing")).not.toBeInTheDocument()
  })

  it("shows the note and folds the briefing behind a toggle", () => {
    renderCard({
      "codeg.handoff": {
        version: 1,
        from: "claude_code",
        to: "grok",
        path: "summary",
        carried: false,
        truncated: false,
        note: "finish the tests",
        briefing: "<!-- codeg:handoff-briefing -->\nthe whole story",
      },
    })
    expect(screen.getByText("· Continued from a briefing")).toBeInTheDocument()
    expect(screen.getByText("Focus: finish the tests")).toBeInTheDocument()
    // Collapsed by default: the text is in the DOM but hidden, so it never
    // takes a screen of space unasked.
    const briefing = screen.getByText(/the whole story/)
    expect(briefing).toHaveClass("hidden")
    fireEvent.click(screen.getByText("Show briefing"))
    expect(briefing).not.toHaveClass("hidden")
    expect(screen.getByText("Hide briefing")).toBeInTheDocument()
    fireEvent.click(screen.getByText("Hide briefing"))
    expect(briefing).toHaveClass("hidden")
  })

  it("says when the briefing had to be shortened", () => {
    renderCard({
      "codeg.handoff": {
        version: 1,
        from: "codex",
        to: "claude_code",
        path: "summary",
        carried: false,
        truncated: true,
      },
    })
    expect(screen.getByText("· Briefing shortened to fit")).toBeInTheDocument()
  })

  it("renders nothing for a non-handoff meta", () => {
    const { container } = renderCard({ contextCompaction: true })
    expect(container).toBeEmptyDOMElement()
  })
})
