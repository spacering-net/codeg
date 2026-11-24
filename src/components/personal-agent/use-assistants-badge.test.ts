import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const roster = vi.hoisted(() => ({ entries: null as unknown[] | null }))
vi.mock("@/stores/personal-agent-roster-store", () => ({
  useRoster: () => roster.entries,
}))

import { useAssistantsBadge } from "./use-assistants-badge"

function bot(
  id: number,
  live: { attention?: string; unread?: number },
  flags: { hidden?: boolean; muted?: boolean; unread_mark?: boolean } = {}
) {
  return {
    id,
    kind: id === 1 ? "primary" : "worker",
    roster: { hidden: false, muted: false, unread_mark: false, ...flags },
    live: { attention: "none", unread: 0, ...live },
  }
}

const badge = (unseen = 0, needs = false) =>
  renderHook(() => useAssistantsBadge(1, unseen, needs)).result.current

describe("the assistants' badge", () => {
  beforeEach(() => {
    roster.entries = null
    usePersonalAgentUi.setState({ watching: false, viewBot: null })
  })

  it("counts the assistants with something unseen — not a muted or hidden one", () => {
    roster.entries = [
      bot(1, { attention: "unread", unread: 4 }),
      bot(2, { attention: "needs_you", unread: 1 }),
      bot(3, {}, { unread_mark: true }),
      bot(4, { attention: "unread", unread: 2 }, { muted: true }),
      bot(5, { attention: "unread", unread: 2 }, { hidden: true }),
    ]
    expect(badge()).toEqual({ unreadBots: 3, needsOwner: true })
    // Not the one the page is showing the owner right now.
    usePersonalAgentUi.setState({ watching: true, viewBot: 2 })
    expect(badge().unreadBots).toBe(2)
  })

  it("says one waits on the owner unless it is hidden, muted or not", () => {
    roster.entries = [bot(9, { attention: "needs_you" }, { hidden: true })]
    expect(badge().needsOwner).toBe(false)
    roster.entries = [bot(9, { attention: "needs_you" }, { muted: true })]
    expect(badge().needsOwner).toBe(true)
  })

  it("goes by the primary until the roster is read", () => {
    expect(badge(2, true)).toEqual({ unreadBots: 1, needsOwner: true })
    // Not while the page shows the owner the newest.
    usePersonalAgentUi.setState({ watching: true })
    expect(badge(2).unreadBots).toBe(0)
  })
})
