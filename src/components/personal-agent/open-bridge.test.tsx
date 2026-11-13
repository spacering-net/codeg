import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const h = vi.hoisted(() => ({
  setRoute: vi.fn(),
  openSession: vi.fn(),
  upload: vi.fn(),
  roster: null as unknown[] | null,
}))

vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ setRoute: h.setRoute }),
}))
vi.mock("@/contexts/personal-agent-context", () => ({
  usePrimaryAgent: () => ({ snapshot: { agent: { id: 1 } } }),
}))
vi.mock("@/stores/personal-agent-roster-store", () => ({
  useRoster: () => h.roster,
}))
vi.mock("@/lib/personal-agent-avatar-png", () => ({
  uploadAvatarPngs: h.upload,
}))
vi.mock("./session-link", () => ({
  useSessionLinkOpener: () => h.openSession,
}))

import { followPersonalAgentLink } from "@/lib/personal-agent-notify"

import { PersonalAgentOpenBridge } from "./open-bridge"

beforeEach(() => {
  h.roster = [
    { id: 1, kind: "primary", avatar: { kind: "face" } },
    { id: 5, kind: "worker", avatar: { kind: "face" } },
  ]
  usePersonalAgentUi.setState({
    viewBot: 5,
    settings: { page: "proactive", bot: null },
    pendingJump: null,
  })
})

afterEach(() => {
  cleanup()
  h.setRoute.mockClear()
  h.openSession.mockClear()
  h.upload.mockClear()
})

describe("following a notification in the workspace", () => {
  it("opens the assistant on its card", () => {
    render(<PersonalAgentOpenBridge />)
    act(() => followPersonalAgentLink({ kind: "bot", bot_id: 1, row_id: 40 }))
    const ui = usePersonalAgentUi.getState()
    // The primary is the page's `null`.
    expect(ui.viewBot).toBeNull()
    expect(ui.settings).toBeNull()
    expect(ui.pendingJump).toEqual({ bot: 1, row: 40 })
    expect(h.setRoute).toHaveBeenCalledWith("personalAgent")
    act(() => followPersonalAgentLink({ kind: "bot", bot_id: 5, row_id: null }))
    expect(usePersonalAgentUi.getState().viewBot).toBe(5)
    expect(usePersonalAgentUi.getState().pendingJump).toBeNull()
  })

  it("opens the conversation it points at", () => {
    render(<PersonalAgentOpenBridge />)
    act(() =>
      followPersonalAgentLink({
        kind: "conversation",
        conversation_id: 8,
        folder_id: 2,
      })
    )
    expect(h.openSession).toHaveBeenCalledWith(8)
    expect(h.setRoute).not.toHaveBeenCalled()
  })

  it("hands the roster's avatars over for the notifications' icons", () => {
    render(<PersonalAgentOpenBridge />)
    expect(h.upload).toHaveBeenCalledWith(h.roster, false)
  })
})
