import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"
import { WorkbenchRouteProvider } from "@/contexts/workbench-route-context"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import {
  resetFolderTabsStore,
  useFolderTabsStore,
} from "@/stores/folder-tabs-store"
import { resetTabStore, useTabStore } from "@/stores/tab-store"
import { ConversationHistoryMenu } from "./conversation-history-menu"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))

function conversation(
  id: number,
  folderId = 1,
  patch: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  return {
    id,
    folder_id: folderId,
    title: `Session ${id}`,
    title_locked: false,
    agent_type: "codex",
    status: "in_progress",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 1,
    child_count: 0,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    pinned_at: null,
    ...patch,
  }
}

const historyButton = () =>
  screen.getByRole("button", { name: "Conversation history" })
const items = () => screen.queryAllByRole("menuitem")

function renderHistory() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WorkbenchRouteProvider>
        <ConversationHistoryMenu />
      </WorkbenchRouteProvider>
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  resetFolderTabsStore()
  resetTabStore()
  resetAppWorkspaceStore()
  localStorage.clear()
  const folders = [1, 2, 3].map((id) => ({
    id,
    name: `repo${id}`,
    path: `/repo${id}`,
    kind: "regular",
  })) as FolderDetail[]
  useAppWorkspaceStore.setState({
    folders,
    allFolders: folders,
    foldersHydrated: true,
    conversations: [
      conversation(101),
      conversation(102),
      conversation(103),
      conversation(201, 2),
    ],
  })
  useFolderTabsStore.setState({ enabled: true, scope: 1 })
})

afterEach(() => {
  cleanup()
  resetFolderTabsStore()
  resetTabStore()
  resetAppWorkspaceStore()
})

describe("ConversationHistoryMenu", () => {
  it("shows unopened current-worktree sessions, including completed and pinned, newest first", async () => {
    useAppWorkspaceStore.setState({
      conversations: [
        conversation(101, 1, {
          status: "completed",
          updated_at: "2026-11-03T00:00:00Z",
        }),
        conversation(102, 1, {
          pinned_at: "2026-11-02T00:00:00Z",
          updated_at: "2026-11-02T00:00:00Z",
        }),
        conversation(103),
        conversation(201, 2),
        conversation(104, 1, { parent_id: 101 }),
      ],
    })
    useTabStore.getState().openTab(1, 103, "codex", false)
    renderHistory()
    await userEvent.click(historyButton())
    expect(items().map((item) => item.textContent)).toEqual([
      expect.stringContaining("Session 101"),
      expect.stringContaining("Session 102"),
    ])
    expect(screen.queryByText("Session 103")).not.toBeInTheDocument()
    expect(screen.queryByText("Session 201")).not.toBeInTheDocument()
    expect(screen.queryByText("Session 104")).not.toBeInTheDocument()
  })

  it("counts bound drafts and tabs in every split group as open", async () => {
    useTabStore.getState().openTab(1, 101, "codex", true)
    useTabStore.getState().openTab(1, 102, "codex", true)
    const tabs = useTabStore.getState().rawTabs
    useTabStore.setState({
      rawTabs: tabs.map((tab) =>
        tab.conversationId === 101 ? { ...tab, id: "new-bound" } : tab
      ),
      groupLayout: {
        type: "split",
        id: "split",
        orientation: "horizontal",
        ratios: [0.5, 0.5],
        children: [
          { type: "group", id: "left" },
          { type: "group", id: "right" },
        ],
      },
      groupOf: { "new-bound": "left", "conv-1-codex-102": "right" },
      groupSelection: { left: "new-bound", right: "conv-1-codex-102" },
    })
    renderHistory()
    await userEvent.click(historyButton())
    expect(items()).toHaveLength(1)
    expect(items()[0]).toHaveTextContent("Session 103")
  })

  it("opens a fixed tab in the active group without replacing an existing preview", async () => {
    useTabStore.getState().openTab(1, 101, "codex", false)
    useTabStore
      .getState()
      .splitTab("conv-1-codex-101", "right", { move: false })
    useTabStore.getState().openTab(1, 103, "codex", false)
    const group =
      useTabStore.getState().groupOf[useTabStore.getState().activeTabId!]
    renderHistory()
    await userEvent.click(historyButton())
    await userEvent.click(screen.getByRole("menuitem", { name: /Session 102/ }))
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(
      useTabStore.getState().rawTabs.map((tab) => tab.conversationId)
    ).toEqual(expect.arrayContaining([101, 103]))
    expect(
      useTabStore.getState().rawTabs.find((tab) => tab.conversationId === 102)
    ).toMatchObject({ isPinned: true })
    expect(useTabStore.getState().activeTabId).toBe("conv-1-codex-102")
    expect(useTabStore.getState().groupOf["conv-1-codex-102"]).toBe(group)
    await userEvent.click(historyButton())
    expect(screen.queryByText("Session 102")).not.toBeInTheDocument()
    act(() => useTabStore.getState().closeTab("conv-1-codex-102"))
    expect(screen.getByText("Session 102")).toBeInTheDocument()
  })

  it("switches history with the worktree and dismisses an old open menu", async () => {
    renderHistory()
    await userEvent.click(historyButton())
    expect(screen.getByText("Session 101")).toBeInTheDocument()
    act(() => useFolderTabsStore.getState().activateScope(2))
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    await userEvent.click(historyButton())
    expect(items()).toHaveLength(1)
    expect(items()[0]).toHaveTextContent("Session 201")
  })

  it("keeps history available with no tabs and reflects deletion events", async () => {
    renderHistory()
    expect(useTabStore.getState().rawTabs).toEqual([])
    await userEvent.click(historyButton())
    act(() => useAppWorkspaceStore.getState().applyConversationRemove(102))
    expect(screen.queryByText("Session 102")).not.toBeInTheDocument()
    expect(screen.getByText("Session 101")).toBeInTheDocument()
  })

  it("does not open a conversation deleted during selection", async () => {
    renderHistory()
    await userEvent.click(historyButton())
    const row = screen.getByRole("menuitem", { name: /Session 102/ })
    row.addEventListener(
      "click",
      () => useAppWorkspaceStore.getState().applyConversationRemove(102),
      { capture: true }
    )
    await userEvent.click(row)
    expect(useTabStore.getState().rawTabs).toEqual([])
  })

  it("distinguishes loading, failure and an empty history", async () => {
    useAppWorkspaceStore.setState({
      conversations: [],
      conversationsLoading: true,
    })
    renderHistory()
    await userEvent.click(historyButton())
    expect(screen.getByText("Loading...")).toBeInTheDocument()
    expect(
      screen.queryByText("No unopened conversations")
    ).not.toBeInTheDocument()
    act(() =>
      useAppWorkspaceStore.setState({
        conversationsLoading: false,
        conversationsError: "offline",
      })
    )
    expect(
      screen.getByText("Could not load conversation history")
    ).toBeInTheDocument()
    expect(
      screen.queryByText("No unopened conversations")
    ).not.toBeInTheDocument()
    act(() => useAppWorkspaceStore.setState({ conversationsError: null }))
    expect(screen.getByText("No unopened conversations")).toBeInTheDocument()
  })
})
