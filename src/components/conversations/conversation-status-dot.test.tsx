/**
 * The dot's colour contract. `unread` is an OVERLAY, not a fifth status: it
 * wins over the status colour while set, and clearing it reveals the status
 * colour again — which is what makes "purple → open the tab → blue" work.
 *
 * The other eight call sites pass no `unread` prop at all, so these tests also
 * pin that omitting it changes nothing.
 */
import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { ConversationStatusDot } from "./conversation-status-dot"

const dotClass = (ui: React.ReactElement) => {
  const { container } = render(ui)
  return container.querySelector("span")?.className ?? ""
}

describe("ConversationStatusDot", () => {
  it("paints an unread pending_review conversation purple", () => {
    const cls = dotClass(<ConversationStatusDot status="pending_review" unread />)
    expect(cls).toContain("bg-purple-500")
    expect(cls).not.toContain("bg-blue-500")
  })

  it("falls back to the status colour once unread is cleared", () => {
    const cls = dotClass(<ConversationStatusDot status="pending_review" />)
    expect(cls).toContain("bg-blue-500")
    expect(cls).not.toContain("bg-purple-500")
  })

  it("keeps the status colour when unread is explicitly false", () => {
    const cls = dotClass(
      <ConversationStatusDot status="in_progress" unread={false} />
    )
    expect(cls).toContain("bg-yellow-400")
    expect(cls).not.toContain("bg-purple-500")
  })

  it("overrides whatever status it is layered on", () => {
    for (const status of ["in_progress", "completed", "cancelled"] as const) {
      expect(dotClass(<ConversationStatusDot status={status} unread />)).toContain(
        "bg-purple-500"
      )
    }
  })

  it("leaves every other call site untouched — no status, no unread", () => {
    const cls = dotClass(<ConversationStatusDot />)
    expect(cls).toContain("bg-gray-400")
    expect(cls).not.toContain("bg-purple-500")
  })
})
