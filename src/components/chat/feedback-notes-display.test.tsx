import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { FeedbackItem } from "@/lib/types"

import { FeedbackNotesDisplay } from "./feedback-notes-display"

const LF = enMessages.LiveFeedback

function note(
  id: string,
  text: string,
  status: "pending" | "delivered" = "pending"
): FeedbackItem {
  return { id, text, created_at: `2026-06-07T00:00:0${id.length}Z`, status }
}

function renderList(
  props: Partial<React.ComponentProps<typeof FeedbackNotesDisplay>> = {}
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <FeedbackNotesDisplay notes={[note("n1", "use pnpm")]} {...props} />
    </NextIntlClientProvider>
  )
}

afterEach(cleanup)

describe("FeedbackNotesDisplay", () => {
  it("reads as waiting/received while the turn runs", () => {
    renderList({
      notes: [note("n1", "use pnpm"), note("n2", "seen it", "delivered")],
    })

    expect(screen.getByText(LF.pending)).toBeInTheDocument()
    expect(screen.getByText(LF.delivered)).toBeInTheDocument()
    // Nothing to recover mid-turn — the note may still be read.
    expect(screen.queryByText(LF.turnEndedUnread)).toBeNull()
    expect(screen.queryByText(LF.sendAsMessage)).toBeNull()
  })

  it("says the agent never read it, and offers the two ways out", async () => {
    const onResend = vi.fn()
    const onDismiss = vi.fn()
    renderList({ expired: true, onResend, onDismiss })

    expect(screen.getByText(LF.turnEndedUnread)).toBeInTheDocument()
    // The mid-turn "waiting" reading would be a lie now: nothing is waiting.
    expect(screen.queryByText(LF.pending)).toBeNull()

    await userEvent.click(screen.getByText(LF.sendAsMessage))
    expect(onResend).toHaveBeenCalledWith("n1")
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it("dismisses the row the button belongs to", async () => {
    const onResend = vi.fn()
    const onDismiss = vi.fn()
    renderList({
      notes: [note("n1", "use pnpm"), note("nn2", "and run the tests")],
      expired: true,
      onResend,
      onDismiss,
    })

    // One pair of actions per row, each bound to its own note.
    expect(screen.getAllByText(LF.sendAsMessage)).toHaveLength(2)
    const dismissButtons = screen.getAllByTitle(LF.dismiss)
    expect(dismissButtons).toHaveLength(2)

    await userEvent.click(dismissButtons[1])
    expect(onDismiss).toHaveBeenCalledWith("nn2")
    expect(onResend).not.toHaveBeenCalled()
  })

  it("renders nothing without notes", () => {
    const { container } = renderList({ notes: [], expired: true })
    expect(container).toBeEmptyDOMElement()
  })
})
