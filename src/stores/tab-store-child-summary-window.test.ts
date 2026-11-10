/**
 * `reconcileChildSummaries` seeds a child tab's label and status from
 * `detail.summary` — nothing else in the response is read. It must therefore
 * ask for the SMALLEST window the backend accepts instead of the legacy full
 * detail: without a window the response carries every turn of the child
 * session, so a long child costs megabytes of transcript transferred and
 * re-parsed just to read a title.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DbConversationDetail, DbConversationSummary } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import { resetTabStore, useTabStore } from "./tab-store"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

const { getFolderConversation } = await import("@/lib/api")
const mockGet = vi.mocked(getFolderConversation)

const CHILD_ID = 7

const childSummary = {
  id: CHILD_ID,
  folder_id: 1,
  title: "child session",
  status: "completed",
} as unknown as DbConversationSummary

const summaryOnlyDetail = {
  summary: childSummary,
  turns: [],
} as unknown as DbConversationDetail

beforeEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
  mockGet.mockReset()
})

afterEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
})

describe("child-tab summary seeding", () => {
  it("requests the smallest window instead of the full transcript", async () => {
    // A child tab is one that carries a conversationId but is absent from the
    // workspace's conversation list — that absence is what marks it a child.
    useTabStore.setState({
      rawTabs: [
        {
          id: "child-1",
          kind: "conversation",
          folderId: 1,
          conversationId: CHILD_ID,
          agentType: "claude_code",
          title: "loading",
          isPinned: false,
        },
      ],
      activeTabId: "child-1",
    })
    useAppWorkspaceStore.setState({
      conversations: [],
      conversationsLoading: false,
    })
    mockGet.mockResolvedValue(summaryOnlyDetail)

    useTabStore.getState().reconcileChildSummaries()

    await vi.waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1))
    expect(mockGet).toHaveBeenCalledWith(CHILD_ID, { tailTurns: 1 })
    // …and the windowed response still seeds the tab from its summary.
    await vi.waitFor(() =>
      expect(useTabStore.getState().childSummaries.get(CHILD_ID)).toBe(
        childSummary
      )
    )
    expect(
      useTabStore.getState().tabs.find((tab) => tab.id === "child-1")?.title
    ).toBe("child session")
  })
})
