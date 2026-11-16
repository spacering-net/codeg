import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TabItem } from "@/contexts/tab-context"
import en from "@/i18n/messages/en.json"
import { MobileTabSwitcher } from "./mobile-tab-switcher"

const state = vi.hoisted(() => ({
  tabs: [] as TabItem[],
  activeTabId: "one",
  activePane: "conversation",
  switchTab: vi.fn(),
  closeTab: vi.fn(),
  openConversations: vi.fn(),
  activateConversationPane: vi.fn(),
  switchFileTab: vi.fn(),
  closeFileTab: vi.fn(),
}))

vi.mock("@/components/agent-icon", () => ({ AgentIcon: () => null }))
vi.mock("@/stores/tab-store", () => ({
  useVisibleConversationTabs: () => state.tabs,
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabStore: (select: (value: { activeTabId: string }) => unknown) =>
    select(state),
  useTabActions: () => ({
    switchTab: state.switchTab,
    closeTab: state.closeTab,
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({
    isConversations: true,
    openConversations: state.openConversations,
  }),
}))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceView: () => ({ mode: "fusion", activePane: state.activePane }),
  useWorkspaceFileTabs: () => ({
    fileTabs: [{ id: "file", title: "README.md", kind: "file", isDirty: true }],
    activeFileTabId: "file",
  }),
  useWorkspaceActions: () => state,
}))

function setup() {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <MobileTabSwitcher />
    </NextIntlClientProvider>
  )
  fireEvent.click(screen.getByRole("button", { name: "Switch tabs (3)" }))
}

describe("mobile open tabs", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.activePane = "conversation"
    state.tabs = ["one", "two"].map((id) => ({
      id,
      kind: "conversation",
      folderId: 1,
      conversationId: id === "one" ? 1 : 2,
      agentType: "codex",
      title: `Chat ${id}`,
      isPinned: true,
    }))
  })

  it("switches conversations directly without closing either conversation", () => {
    setup()
    expect(screen.getByRole("button", { name: "Chat one" })).toHaveAttribute(
      "aria-current",
      "page"
    )
    fireEvent.click(screen.getByRole("button", { name: "Chat two" }))
    expect(state.openConversations).toHaveBeenCalledOnce()
    expect(state.switchTab).toHaveBeenCalledExactlyOnceWith("two")
    expect(state.activateConversationPane).toHaveBeenCalledOnce()
    expect(state.closeTab).not.toHaveBeenCalled()
  })

  it("closes an explicit tab without switching it", () => {
    setup()
    fireEvent.click(
      screen.getByRole("button", { name: "Close conversation tab: Chat two" })
    )
    expect(state.closeTab).toHaveBeenCalledExactlyOnceWith("two")
    expect(state.switchTab).not.toHaveBeenCalled()
  })

  it("opens files through the existing workspace action", () => {
    setup()
    fireEvent.click(screen.getByRole("button", { name: "README.md" }))
    expect(state.switchFileTab).toHaveBeenCalledExactlyOnceWith("file")
    expect(state.closeFileTab).not.toHaveBeenCalled()
  })

  it("marks the active file rather than the hidden conversation", () => {
    state.activePane = "files"
    setup()
    expect(screen.getByRole("button", { name: "README.md" })).toHaveAttribute(
      "aria-current",
      "page"
    )
    expect(
      screen.getByRole("button", { name: "Chat one" })
    ).not.toHaveAttribute("aria-current")
  })

  it("uses the existing file close guard instead of switching the file", () => {
    setup()
    fireEvent.click(screen.getByRole("button", { name: "Close: README.md" }))
    expect(state.closeFileTab).toHaveBeenCalledExactlyOnceWith("file")
    expect(state.switchFileTab).not.toHaveBeenCalled()
  })
})
