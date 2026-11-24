import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  peekClosedTab,
  popClosedTab,
  resetClosedTabStackForTests,
} from "@/lib/closed-tab-stack"
import {
  isConversationDeleted,
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import { resetTabStore, useTabStore } from "./tab-store"
import type { FolderDetail } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

const folder = {
  id: 1,
  name: "repo",
  path: "/repo",
} as unknown as FolderDetail

function seedTabs() {
  useAppWorkspaceStore.setState({ folders: [folder], allFolders: [folder] })
  useTabStore.setState({
    rawTabs: [
      {
        id: "conv-1",
        kind: "conversation",
        folderId: 1,
        conversationId: 7,
        agentType: "claude_code",
        title: "kept",
        isPinned: false,
      },
      {
        id: "conv-2",
        kind: "conversation",
        folderId: 1,
        conversationId: 8,
        agentType: "claude_code",
        title: "closed",
        isPinned: false,
      },
    ],
    activeTabId: "conv-2",
  })
}

beforeEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
  resetClosedTabStackForTests()
  seedTabs()
})

afterEach(() => {
  resetClosedTabStackForTests()
})

describe("what reopen-last-closed-tab is allowed to remember", () => {
  it("records an ordinary close", () => {
    useTabStore.getState().closeTab("conv-2")
    expect(peekClosedTab()).toMatchObject({
      kind: "conversation",
      conversationId: 8,
    })
  })

  // Reopening these would mint a tab — and an `opened_tabs` row — pointing at a
  // conversation the user just deleted.
  it("does not record a close that follows a delete", () => {
    useTabStore.getState().closeTab("conv-2", { recordForReopen: false })
    expect(peekClosedTab()).toBeNull()
  })

  it("does not record the sidebar / manage-dialog delete path", () => {
    // `closeConversationTab` is only ever called right after
    // `deleteConversation`, so it opts out on every caller's behalf.
    useTabStore.getState().closeConversationTab(1, 8, "claude_code")
    expect(useTabStore.getState().rawTabs).toHaveLength(1)
    expect(peekClosedTab()).toBeNull()
  })

  it("does not record tabs dropped with their folder", () => {
    useTabStore.getState().closeTabsByFolder(1)
    expect(useTabStore.getState().rawTabs).toHaveLength(0)
    expect(peekClosedTab()).toBeNull()
  })
})

// Declining to record only covers a tab that is still open. A conversation
// closed BEFORE it was deleted is already on the stack, so the delete has to
// reach back and remove it. `applyConversationRemove` /`applyFolderRemove` are
// the funnels: the backend broadcasts Deleted to every client including the one
// that asked, so they cover a local delete, another window's, and a bulk delete
// where only some of the requests succeeded.
describe("what a deletion retracts from the reopen stack", () => {
  it("forgets a conversation deleted after its tab was closed", () => {
    useTabStore.getState().closeTab("conv-2")
    expect(peekClosedTab()).toMatchObject({ conversationId: 8 })

    useAppWorkspaceStore.getState().applyConversationRemove(8)
    expect(peekClosedTab()).toBeNull()
  })

  it("forgets a conversation deleted from another window", () => {
    // No tab was ever closed here for it — the entry came from an earlier close
    // in this session, and the delete arrives as a broadcast.
    useTabStore.getState().closeTab("conv-1")
    useTabStore.getState().closeTab("conv-2")
    useAppWorkspaceStore.getState().applyConversationRemove(7)

    expect(popClosedTab()).toMatchObject({ conversationId: 8 })
    expect(popClosedTab()).toBeNull()
  })

  it("leaves other conversations and drafts alone", () => {
    useTabStore.setState({
      rawTabs: [
        ...useTabStore.getState().rawTabs,
        {
          id: "draft-1",
          kind: "conversation",
          folderId: 1,
          conversationId: null,
          agentType: "claude_code",
          title: "draft",
          isPinned: false,
        },
      ],
    })
    useTabStore.getState().closeTab("draft-1")
    useTabStore.getState().closeTab("conv-1")
    useAppWorkspaceStore.getState().applyConversationRemove(8)

    expect(popClosedTab()).toMatchObject({ conversationId: 7 })
    expect(popClosedTab()).toMatchObject({ conversationId: null })
    expect(popClosedTab()).toBeNull()
  })

  // A remote delete does NOT close an open tab (only the sidebar row goes), so
  // the user can close that tab by hand afterwards and record it. The purge
  // already ran, so only the tombstone catches this one — which is why the
  // reopen handler asks `isConversationDeleted` before restoring.
  it("tombstones a conversation deleted while its tab was still open", () => {
    useAppWorkspaceStore.getState().applyConversationRemove(8)
    useTabStore.getState().closeTab("conv-2")

    expect(peekClosedTab()).toMatchObject({ conversationId: 8 })
    expect(isConversationDeleted(8)).toBe(true)
    expect(isConversationDeleted(7)).toBe(false)
  })

  it("forgets a removed folder's history, not its neighbours'", () => {
    useTabStore.setState({
      rawTabs: [
        ...useTabStore.getState().rawTabs,
        {
          id: "conv-3",
          kind: "conversation",
          folderId: 2,
          conversationId: 9,
          agentType: "claude_code",
          title: "other folder",
          isPinned: false,
        },
      ],
    })
    useTabStore.getState().closeTab("conv-2")
    useTabStore.getState().closeTab("conv-3")
    useAppWorkspaceStore.getState().applyFolderRemove(1)

    expect(popClosedTab()).toMatchObject({ folderId: 2, conversationId: 9 })
    expect(popClosedTab()).toBeNull()
  })
})
