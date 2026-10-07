import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  popClosedTab,
  resetClosedTabStackForTests,
  type ClosedWorkspaceTab,
} from "@/lib/closed-tab-stack"
import { saveOpenedTabs } from "@/lib/api"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import { resetTabStore, useTabStore, type TabItemInternal } from "./tab-store"
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

function tabId(conversationId: number): string {
  return `conv-1-claude_code-${conversationId}`
}

function conversationTab(
  conversationId: number,
  isPinned = true
): TabItemInternal {
  return {
    id: tabId(conversationId),
    kind: "conversation",
    folderId: 1,
    conversationId,
    agentType: "claude_code",
    title: `t${conversationId}`,
    isPinned,
  }
}

function draftTab(id: string): TabItemInternal {
  return {
    id,
    kind: "conversation",
    folderId: 1,
    conversationId: null,
    agentType: "claude_code",
    title: "draft",
    isPinned: true,
    workingDir: "/repo",
  }
}

function seedTabs(tabs: TabItemInternal[], activeTabId = tabs[0].id) {
  useAppWorkspaceStore.setState({ folders: [folder], allFolders: [folder] })
  useTabStore.setState({ rawTabs: tabs, activeTabId })
}

function ids(): string[] {
  return useTabStore.getState().rawTabs.map((tab) => tab.id)
}

/** What the reopen shortcut does with the entry it pops: hand the store the
 *  identity AND the slot the tab was closed from. */
function reopen(closed: ClosedWorkspaceTab | null) {
  if (!closed || closed.kind !== "conversation") {
    throw new Error("expected a closed conversation tab")
  }
  const store = useTabStore.getState()
  if (closed.conversationId == null) {
    store.openNewConversationTab(closed.folderId, closed.workingDir ?? "", {
      index: closed.index,
    })
    return
  }
  store.openTab(
    closed.folderId,
    closed.conversationId,
    closed.agentType,
    closed.isPinned,
    closed.title,
    { index: closed.index }
  )
}

function reopenLast() {
  reopen(popClosedTab())
}

beforeEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
  resetClosedTabStackForTests()
})

afterEach(() => {
  resetClosedTabStackForTests()
  vi.useRealTimers()
})

describe("where reopen-last-closed-tab puts the tab back", () => {
  it("restores the tab at the slot it was closed from", () => {
    seedTabs([conversationTab(1), conversationTab(2), conversationTab(3)])
    useTabStore.getState().closeTab(tabId(2))
    expect(ids()).toEqual([tabId(1), tabId(3)])

    reopenLast()
    expect(ids()).toEqual([tabId(1), tabId(2), tabId(3)])
    expect(useTabStore.getState().activeTabId).toBe(tabId(2))
  })

  it("clamps the slot to the strip when it has shrunk since", () => {
    seedTabs([
      conversationTab(1),
      conversationTab(2),
      conversationTab(3),
      conversationTab(4),
    ])
    useTabStore.getState().closeTab(tabId(4))
    useTabStore.getState().closeTab(tabId(2), { recordForReopen: false })
    useTabStore.getState().closeTab(tabId(3), { recordForReopen: false })
    expect(ids()).toEqual([tabId(1)])

    reopenLast()
    expect(ids()).toEqual([tabId(1), tabId(4)])
  })

  it("puts tabs closed one at a time back in reverse, each where it was", () => {
    seedTabs([
      conversationTab(1),
      conversationTab(2),
      conversationTab(3),
      conversationTab(4),
      conversationTab(5),
    ])
    useTabStore.getState().closeTab(tabId(2))
    useTabStore.getState().closeTab(tabId(4))
    expect(ids()).toEqual([tabId(1), tabId(3), tabId(5)])

    reopenLast()
    expect(ids()).toEqual([tabId(1), tabId(3), tabId(4), tabId(5)])
    reopenLast()
    expect(ids()).toEqual([tabId(1), tabId(2), tabId(3), tabId(4), tabId(5)])
  })

  // "Close other tabs" records every tab against the same strip. Reopening
  // walks the stack newest-first, so each entry has to carry the slot the tab
  // would have had if the batch had closed one tab at a time.
  it("walks a close-others batch back into its original order", () => {
    seedTabs(
      [
        conversationTab(1),
        conversationTab(2),
        conversationTab(3),
        conversationTab(4),
      ],
      tabId(2)
    )
    useTabStore.getState().closeOtherTabs(tabId(2))
    expect(ids()).toEqual([tabId(2)])

    reopenLast()
    expect(ids()).toEqual([tabId(2), tabId(4)])
    reopenLast()
    expect(ids()).toEqual([tabId(2), tabId(3), tabId(4)])
    reopenLast()
    expect(ids()).toEqual([tabId(1), tabId(2), tabId(3), tabId(4)])
  })

  it("rebuilds a closed-all strip ahead of the draft that replaced it", () => {
    seedTabs([conversationTab(1), conversationTab(2), conversationTab(3)])
    useTabStore.getState().closeAllTabs()
    const [draft] = ids()
    expect(useTabStore.getState().rawTabs[0].conversationId).toBeNull()

    reopenLast()
    reopenLast()
    reopenLast()
    expect(ids()).toEqual([tabId(1), tabId(2), tabId(3), draft])
  })

  // The replacement draft a close-all spawns IS what a reopened draft entry
  // resolves to (per-group draft singleton), so it has to take the closed
  // draft's slot — otherwise the strip comes back with the draft shunted to
  // the end.
  it("rebuilds a closed-all strip that held a draft", () => {
    seedTabs([conversationTab(1), draftTab("new-1"), conversationTab(3)])
    useTabStore.getState().closeAllTabs()
    const [draft] = ids()

    reopenLast()
    reopenLast()
    reopenLast()
    expect(ids()).toEqual([tabId(1), draft, tabId(3)])
  })

  it("restores a closed draft at its slot", () => {
    seedTabs([conversationTab(1), draftTab("new-1"), conversationTab(3)])
    useTabStore.getState().closeTab("new-1")
    expect(ids()).toEqual([tabId(1), tabId(3)])

    reopenLast()
    const { rawTabs, activeTabId } = useTabStore.getState()
    expect(rawTabs.map((tab) => tab.conversationId)).toEqual([1, null, 3])
    expect(rawTabs[1].workingDir).toBe("/repo")
    expect(activeTabId).toBe(rawTabs[1].id)
  })

  it("keeps a reopened kept tab out of the group's preview slot", () => {
    seedTabs(
      [conversationTab(1), conversationTab(2), conversationTab(3, false)],
      tabId(2)
    )
    useTabStore.getState().closeTab(tabId(2))

    reopenLast()
    const { rawTabs, previewReplacedTabIds } = useTabStore.getState()
    expect(rawTabs.map((tab) => [tab.id, tab.isPinned])).toEqual([
      [tabId(1), true],
      [tabId(2), true],
      [tabId(3), false],
    ])
    expect(previewReplacedTabIds).toEqual([])
  })

  it("lands a reopened preview at its slot when the group has no preview", () => {
    seedTabs(
      [conversationTab(1), conversationTab(2, false), conversationTab(3)],
      tabId(2)
    )
    useTabStore.getState().closeTab(tabId(2))

    reopenLast()
    expect(
      useTabStore.getState().rawTabs.map((tab) => [tab.id, tab.isPinned])
    ).toEqual([
      [tabId(1), true],
      [tabId(2), false],
      [tabId(3), true],
    ])
  })

  // A group holds one preview. A reopened preview still takes that slot when
  // another preview opened in the meantime; the slot only decides where a tab
  // that needs a NEW slot goes.
  it("lets a reopened preview replace the preview that took its place", () => {
    seedTabs(
      [conversationTab(1), conversationTab(2, false), conversationTab(3)],
      tabId(2)
    )
    useTabStore.getState().closeTab(tabId(2))
    useTabStore.getState().openTab(1, 4, "claude_code", false)
    expect(ids()).toEqual([tabId(1), tabId(3), tabId(4)])

    reopenLast()
    const { rawTabs, previewReplacedTabIds } = useTabStore.getState()
    expect(rawTabs.map((tab) => [tab.id, tab.isPinned])).toEqual([
      [tabId(1), true],
      [tabId(3), true],
      [tabId(2), false],
    ])
    expect(previewReplacedTabIds).toEqual([tabId(4)])
  })

  it("focuses a conversation that is open again rather than adding a tab", () => {
    seedTabs([conversationTab(1), conversationTab(2), conversationTab(3)])
    useTabStore.getState().closeTab(tabId(2))
    // Reopened from the sidebar in the meantime (which does not pop).
    useTabStore.getState().openTab(1, 2, "claude_code", true)
    useTabStore.getState().switchTab(tabId(1))
    expect(ids()).toEqual([tabId(1), tabId(3), tabId(2)])

    reopenLast()
    expect(ids()).toEqual([tabId(1), tabId(3), tabId(2)])
    expect(useTabStore.getState().activeTabId).toBe(tabId(2))
  })

  it("saves the restored order as the persisted positions", async () => {
    vi.useFakeTimers()
    vi.mocked(saveOpenedTabs).mockResolvedValue({
      accepted: true,
      version: 1,
      tabs: [],
    })
    seedTabs([conversationTab(1), conversationTab(2), conversationTab(3)])
    useTabStore.setState({ tabsHydrated: true })
    useTabStore.getState().closeTab(tabId(2))
    reopenLast()

    useTabStore.getState().runSaveEffect()
    await vi.advanceTimersByTimeAsync(500)

    expect(saveOpenedTabs).toHaveBeenCalledTimes(1)
    const [items] = vi.mocked(saveOpenedTabs).mock.calls[0]
    expect(items.map((it) => [it.conversation_id, it.position])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ])
  })
})
