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
    settings: null,
    botPage: { tab: "notify" },
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
    // The primary is the page's `null`, its conversation shown: no page
    // over it.
    expect(ui.viewBot).toBeNull()
    expect(ui.settings).toBeNull()
    expect(ui.botPage).toBeNull()
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

describe("a page asked for in the address (`?pa=`)", () => {
  afterEach(() => window.history.replaceState(null, "", "/"))

  it("opens a tab of the assistant's own page, or a page of the settings", () => {
    usePersonalAgentUi.setState({ settings: null, botPage: null })
    window.history.replaceState(null, "", "/workspace?pa=persona&x=1")
    render(<PersonalAgentOpenBridge />)
    // The page's assistant's own page, its conversation stays the same one.
    expect(usePersonalAgentUi.getState().botPage).toEqual({ tab: "persona" })
    expect(usePersonalAgentUi.getState().viewBot).toBe(5)
    expect(usePersonalAgentUi.getState().settings).toBeNull()
    expect(window.location.search).toBe("?x=1")
    expect(h.setRoute).toHaveBeenCalledWith("personalAgent")
    cleanup()
    // An old link to a team page that is gone: the settings' first page.
    window.history.replaceState(null, "", "/workspace?pa=executors")
    render(<PersonalAgentOpenBridge />)
    expect(usePersonalAgentUi.getState().settings).toEqual({
      page: "communication",
    })
    expect(usePersonalAgentUi.getState().botPage).toBeNull()
    cleanup()
    window.history.replaceState(null, "", "/workspace?pa=projects")
    render(<PersonalAgentOpenBridge />)
    expect(usePersonalAgentUi.getState().settings).toEqual({
      page: "projects",
    })
  })

  it("opens the assistants: the primary's conversation, and the sidebar's group of them", () => {
    const shown = vi.fn()
    window.addEventListener("codeg:sidebar-show-assistants", shown)
    try {
      window.history.replaceState(null, "", "/workspace?pa=assistants")
      render(<PersonalAgentOpenBridge />)
      const ui = usePersonalAgentUi.getState()
      expect(ui.viewBot).toBeNull()
      expect(ui.botPage).toBeNull()
      expect(ui.settings).toBeNull()
      expect(shown).toHaveBeenCalledTimes(1)
      expect(window.location.search).toBe("")
      expect(h.setRoute).toHaveBeenCalledWith("personalAgent")
    } finally {
      window.removeEventListener("codeg:sidebar-show-assistants", shown)
    }
  })

  it("leaves one it does not know", () => {
    usePersonalAgentUi.setState({ settings: null, botPage: null })
    window.history.replaceState(null, "", "/workspace?pa=elsewhere")
    render(<PersonalAgentOpenBridge />)
    expect(usePersonalAgentUi.getState().settings).toBeNull()
    expect(usePersonalAgentUi.getState().botPage).toBeNull()
    expect(h.setRoute).not.toHaveBeenCalled()
  })
})
