import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { create } from "zustand"

const tabs = create<{ activeTabId: string | null; tabsHydrated: boolean }>(
  () => ({ activeTabId: null, tabsHydrated: false })
)
const h = vi.hoisted(() => ({
  openConversations: vi.fn(),
  consumeRemoteActivation: vi.fn(() => false),
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabStore: <T,>(
    selector: (s: { activeTabId: string | null; tabsHydrated: boolean }) => T
  ) => tabs(selector),
  useTabActions: () => ({
    consumeRemoteActivation: h.consumeRemoteActivation,
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: h.openConversations }),
}))

import { WorkbenchRouteConversationSync } from "./workbench-route-conversation-sync"

beforeEach(() => {
  tabs.setState({ activeTabId: null, tabsHydrated: false })
  h.openConversations.mockClear()
  h.consumeRemoteActivation.mockReset()
  h.consumeRemoteActivation.mockReturnValue(false)
})
afterEach(cleanup)

describe("WorkbenchRouteConversationSync", () => {
  it("leaves the view the window opened on while the last session's tabs come back", () => {
    render(<WorkbenchRouteConversationSync />)
    // The restore: the focus it had, and hydrated, in one pass.
    act(() => tabs.setState({ activeTabId: "a", tabsHydrated: true }))
    expect(h.openConversations).not.toHaveBeenCalled()
    // A remote snapshot's mark left in that pass is taken, not kept for
    // the next activation.
    expect(h.consumeRemoteActivation).toHaveBeenCalledTimes(1)
    // The owner's own activation, after: the conversations.
    act(() => tabs.setState({ activeTabId: "b" }))
    expect(h.openConversations).toHaveBeenCalledTimes(1)
  })

  it("leaves it too when the focus comes back before the tabs are marked hydrated", () => {
    render(<WorkbenchRouteConversationSync />)
    act(() => tabs.setState({ activeTabId: "a" }))
    act(() => tabs.setState({ tabsHydrated: true }))
    expect(h.openConversations).not.toHaveBeenCalled()
    act(() => tabs.setState({ activeTabId: "b" }))
    expect(h.openConversations).toHaveBeenCalledTimes(1)
  })

  it("does not follow another client's focus", () => {
    tabs.setState({ activeTabId: "a", tabsHydrated: true })
    render(<WorkbenchRouteConversationSync />)
    h.consumeRemoteActivation.mockReturnValueOnce(true)
    act(() => tabs.setState({ activeTabId: "b" }))
    expect(h.openConversations).not.toHaveBeenCalled()
    act(() => tabs.setState({ activeTabId: "c" }))
    expect(h.openConversations).toHaveBeenCalledTimes(1)
  })
})
