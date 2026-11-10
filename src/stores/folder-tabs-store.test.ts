import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  useFolderTabsStore,
  resetFolderTabsStore,
  shouldSeedConversation,
} from "./folder-tabs-store"
import {
  dropParkedFolderGroupViews,
  resetTabStore,
  shellGroupOfTab,
  useTabStore,
} from "./tab-store"
import { leafIds, type SplitNode } from "@/lib/tab-group-layout"
import {
  buildNewConversationDraftStorageKey,
  saveMessageInputDraftV2,
  setLiveComposerContent,
} from "@/lib/message-input-draft"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import * as api from "@/lib/api"
import type { FolderDetail, TabsChanged } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))

beforeEach(() => {
  resetFolderTabsStore()
  resetTabStore()
  resetAppWorkspaceStore()
  localStorage.clear()
  const folders = [1, 2, 3].map((id) => ({
    id,
    path: `/repo${id}`,
    name: `repo${id}`,
  })) as FolderDetail[]
  useAppWorkspaceStore.setState({
    folders,
    allFolders: folders,
    foldersHydrated: true,
  })
})

function open(folderId: number, id: number, pin = true) {
  useTabStore.getState().openTab(folderId, id, "claude_code", pin)
  return useTabStore.getState().activeTabId!
}

function visibleIds() {
  const { enabled, scope } = useFolderTabsStore.getState()
  return useTabStore
    .getState()
    .rawTabs.filter((tab) => !enabled || tab.folderId === scope)
    .map((tab) => tab.id)
}

describe("Folder-tabs conversation scope", () => {
  it.each([0, 1, 2, 99])(
    "maps a cross-group drop at visible index %s without counting hidden members",
    (index) => {
      const a1 = open(1, 11)
      const b1 = open(2, 21)
      const a2 = open(1, 12)
      const b2 = open(2, 22)
      const a3 = open(1, 13)
      const b0 = open(2, 20)
      const sourceSibling = open(2, 23)
      useTabStore.setState({
        groupLayout: {
          type: "split",
          id: "split",
          orientation: "horizontal",
          ratios: [0.5, 0.5],
          children: [
            { type: "group", id: "source" },
            { type: "group", id: "target" },
          ],
        },
        groupOf: {
          [a1]: "target",
          [b1]: "target",
          [a2]: "target",
          [b2]: "target",
          [a3]: "target",
          [b0]: "source",
          [sourceSibling]: "source",
        },
      })
      useFolderTabsStore.getState().setEnabled(true)
      useFolderTabsStore.getState().activateScope(2)
      useTabStore.getState().moveTabToGroup(b0, "target", { index })
      const state = useTabStore.getState()
      // Hidden tabs keep their group in their own (here: normal-mode) view.
      const target = state.rawTabs.filter(
        (tab) => shellGroupOfTab(state, tab.id) === "target"
      )
      const visible = [b1, b2]
      visible.splice(Math.min(index, 2), 0, b0)
      expect(
        target.filter((tab) => tab.folderId === 2).map((tab) => tab.id)
      ).toEqual(visible)
      expect(
        target.filter((tab) => tab.folderId === 1).map((tab) => tab.id)
      ).toEqual([a1, a2, a3])
      expect(
        state.rawTabs
          .filter((tab) => state.groupOf[tab.id] === "source")
          .map((tab) => tab.id)
      ).toEqual([sourceSibling])
    }
  )

  it("restores A → B → A selection, including an empty folder, and exposes all tabs on disable", () => {
    const a1 = open(1, 11)
    const a2 = open(1, 12)
    const b1 = open(2, 21)
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(1)
    useTabStore.getState().switchTab(a2)
    useFolderTabsStore.getState().activateScope(2)
    expect(useTabStore.getState().activeTabId).toBe(b1)
    useFolderTabsStore.getState().activateScope(3)
    expect(useTabStore.getState().activeTabId).toBeNull()
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(3)
    expect(useTabStore.getState().rawTabs).toHaveLength(3)
    useFolderTabsStore.getState().activateScope(1)
    expect(useTabStore.getState().activeTabId).toBe(a2)
    expect(visibleIds()).toEqual([a1, a2])
    useFolderTabsStore.getState().setEnabled(false)
    expect(visibleIds()).toEqual([a1, a2, b1])
  })

  it("keeps inactive previews and drafts when opening, reordering and closing visible tabs", () => {
    useFolderTabsStore.getState().setEnabled(true)
    const a = open(1, 11, false)
    const draftA = useTabStore.getState().openNewConversationTab(1, "/repo1")
    const b = open(2, 21, false)
    const draftB = useTabStore.getState().openNewConversationTab(2, "/repo2")
    expect(draftA.tabId).not.toBe(draftB.tabId)
    expect(
      useTabStore.getState().rawTabs.find((tab) => tab.id === draftA.tabId)
        ?.folderId
    ).toBe(1)
    expect(useTabStore.getState().rawTabs.some((tab) => tab.id === a)).toBe(
      true
    )
    const visible = useTabStore
      .getState()
      .tabs.filter((tab) => tab.folderId === 2)
    useTabStore.getState().reorderTabs([...visible].reverse())
    expect(
      useTabStore
        .getState()
        .rawTabs.slice(0, 2)
        .map((tab) => tab.id)
    ).toEqual([a, draftA.tabId])
    useTabStore.getState().closeOtherTabs(b)
    expect(useTabStore.getState().rawTabs.map((tab) => tab.id)).toEqual([
      a,
      draftA.tabId,
      b,
    ])
    useTabStore.getState().closeAllTabs()
    expect(useTabStore.getState().rawTabs.map((tab) => tab.id)).toEqual([
      a,
      draftA.tabId,
    ])
    expect(useTabStore.getState().activeTabId).toBeNull()
    expect(useFolderTabsStore.getState().scope).toBe(2)
  })

  it("opening or focusing a session activates its own worktree", () => {
    const a = open(1, 11)
    useFolderTabsStore.getState().setEnabled(true)
    open(2, 21)
    expect(useFolderTabsStore.getState().scope).toBe(2)
    useTabStore.getState().switchTab(a)
    expect(useFolderTabsStore.getState().scope).toBe(1)
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(1)
  })

  it("preserves local scope and selection while reconciling complete server snapshots", async () => {
    const a = open(1, 11)
    open(2, 21)
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(1)
    const items = [
      {
        folder_id: 1,
        conversation_id: 11,
        agent_type: "claude_code",
        is_pinned: true,
        is_active: false,
        position: 0,
      },
      {
        folder_id: 2,
        conversation_id: 21,
        agent_type: "claude_code",
        is_pinned: true,
        is_active: true,
        position: 1,
      },
    ]
    items.push({
      folder_id: 3,
      conversation_id: 31,
      agent_type: "claude_code",
      is_pinned: true,
      is_active: false,
      position: 2,
    })
    useTabStore.setState({ tabsHydrated: true })
    vi.mocked(api.listOpenedTabs).mockResolvedValue({
      version: 1,
      items,
    } as never)
    await useTabStore.getState().refetchTabs()
    expect(useFolderTabsStore.getState().scope).toBe(1)
    expect(useTabStore.getState().activeTabId).toBe(a)
    expect(useTabStore.getState().rawTabs).toHaveLength(3)
    // A subsequent remote activation must also leave this client's scope alone.
    useTabStore
      .getState()
      .handleTabsChanged({ version: 2, tabs: items } as TabsChanged)
    expect(useTabStore.getState().activeTabId).toBe(a)
    expect(useTabStore.getState().rawTabs).toHaveLength(3)
  })

  it("persists the complete conversation set while a worktree is hidden", async () => {
    vi.useFakeTimers()
    try {
      open(1, 11)
      open(2, 21)
      useFolderTabsStore.getState().setEnabled(true)
      useFolderTabsStore.getState().activateScope(1)
      useTabStore.setState({ tabsHydrated: true })
      vi.mocked(api.saveOpenedTabs).mockResolvedValue({
        accepted: true,
        version: 1,
        tabs: [],
      })
      useTabStore.getState().runSaveEffect()
      await vi.advanceTimersByTimeAsync(500)
      expect(
        vi
          .mocked(api.saveOpenedTabs)
          .mock.lastCall?.[0].map((item) => item.folder_id)
      ).toEqual([1, 2])
    } finally {
      useTabStore.getState().clearSaveTimer()
      vi.useRealTimers()
    }
  })

  it("keeps an empty selected worktree empty through remote snapshots and refetch", async () => {
    open(1, 11)
    useTabStore.setState({ tabsHydrated: true })
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(1)
    useTabStore.getState().closeAllTabs()
    useFolderTabsStore.getState().activateScope(3)
    useTabStore
      .getState()
      .handleTabsChanged({ version: 1, origin: "remote", tabs: [] })
    expect(useTabStore.getState().rawTabs).toEqual([])
    vi.mocked(api.listOpenedTabs).mockResolvedValue({ version: 2, items: [] })
    await useTabStore.getState().refetchTabs()
    expect(useTabStore.getState().rawTabs).toEqual([])
    expect(useTabStore.getState().activeTabId).toBeNull()
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(3)
  })

  it("allows automatic empty-state drafts only in ordinary mode", () => {
    expect(shouldSeedConversation(true, true)).toBe(false)
    expect(shouldSeedConversation(true, false)).toBe(false)
    expect(shouldSeedConversation(false, true)).toBe(true)
    expect(shouldSeedConversation(false, false)).toBe(false)
  })

  it("defaults off and tolerates denied preference storage", () => {
    expect(useFolderTabsStore.getState().enabled).toBe(false)
    const get = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("denied")
      })
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("denied")
      })
    expect(() =>
      useFolderTabsStore.getState().hydratePreference()
    ).not.toThrow()
    expect(() => useFolderTabsStore.getState().setEnabled(true)).not.toThrow()
    expect(useFolderTabsStore.getState().enabled).toBe(true)
    get.mockRestore()
    set.mockRestore()
  })
})

describe("Folder-tabs scope repairs", () => {
  function setFolders(
    list: Array<{ id: number; parent_id?: number; kind?: string }>
  ) {
    const all = list.map(({ id, parent_id = null, kind = "folder" }) => ({
      id,
      path: `/repo${id}`,
      name: `repo${id}`,
      parent_id,
      kind,
    })) as unknown as FolderDetail[]
    useAppWorkspaceStore.setState({
      folders: all.filter((f) => f.kind !== "chat"),
      allFolders: all,
      foldersHydrated: true,
    })
  }
  // TabProvider re-syncs the active folder after every tab write.
  function sync() {
    useTabStore.getState().syncActiveFolderId()
  }
  const draftIds = () =>
    useTabStore
      .getState()
      .rawTabs.filter((tab) => tab.conversationId == null)
      .map((tab) => tab.id)
  /** What the composer saves once the user has typed in a draft. */
  function typeInto(draftId: string) {
    saveMessageInputDraftV2(buildNewConversationDraftStorageKey(draftId), {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "keep me" }] },
      ],
    })
  }

  it("turning the mode back on keeps the tab the user is on", () => {
    const a1 = open(1, 11)
    const a2 = open(1, 12)
    open(2, 21)
    useTabStore.getState().switchTab(a1)
    sync()
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(2)
    useFolderTabsStore.getState().setEnabled(false)
    useTabStore.getState().switchTab(a2)
    sync()
    useFolderTabsStore.getState().setEnabled(true)
    expect(useFolderTabsStore.getState().scope).toBe(1)
    expect(useTabStore.getState().activeTabId).toBe(a2)
  })

  it("turning the mode on keeps each split group's pick", () => {
    const a1 = open(1, 11)
    const a2 = open(1, 12)
    const a3 = open(1, 13)
    useTabStore.setState({
      groupLayout: {
        type: "split",
        id: "split",
        orientation: "horizontal",
        ratios: [0.5, 0.5],
        children: [
          { type: "group", id: "g1" },
          { type: "group", id: "g2" },
        ],
      },
      groupOf: { [a1]: "g1", [a2]: "g2", [a3]: "g2" },
      groupSelection: { g1: a1, g2: a3 },
      activeTabId: a1,
    })
    sync()
    useFolderTabsStore.getState().setEnabled(true)
    expect(useTabStore.getState().activeTabId).toBe(a1)
    expect(useTabStore.getState().groupSelection).toEqual({ g1: a1, g2: a3 })
  })

  it("keeps a chat conversation's hidden chat folder active in the global scope", () => {
    setFolders([{ id: 1 }, { id: 9, kind: "chat" }])
    open(1, 11)
    useFolderTabsStore.getState().setEnabled(true)
    open(9, 91)
    sync()
    expect(useFolderTabsStore.getState().scope).toBe("global")
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(9)
    // Re-selecting the already-active chat changes no tab, so nothing would
    // re-sync a wrong value: the scope switch itself must not clear it.
    open(9, 91)
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(9)
    useFolderTabsStore.getState().activateScope(1)
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(1)
  })

  it("an empty scope still owns the folder chrome", () => {
    open(1, 11)
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(2)
    expect(useTabStore.getState().activeTabId).toBeNull()
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(2)
  })

  it("closing the active tab focuses its neighbour in the scope", () => {
    open(1, 11)
    open(2, 21)
    const a2 = open(1, 12)
    open(2, 22)
    const a3 = open(1, 13)
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(1)
    useTabStore.getState().switchTab(a3)
    useTabStore.getState().closeTab(a3)
    expect(useTabStore.getState().activeTabId).toBe(a2)
  })

  it("an emptied group falls to the nearest group shown in the scope", () => {
    const a1 = open(1, 11)
    const a2 = open(1, 12)
    const b1 = open(2, 21)
    const a3 = open(1, 13)
    useTabStore.setState({
      groupLayout: {
        type: "split",
        id: "split",
        orientation: "horizontal",
        ratios: [1 / 3, 1 / 3, 1 / 3],
        children: [
          { type: "group", id: "g1" },
          { type: "group", id: "g2" },
          { type: "group", id: "g3" },
        ],
      },
      groupOf: { [a1]: "g1", [a2]: "g1", [b1]: "g2", [a3]: "g3" },
      groupSelection: { g1: a2, g2: b1, g3: a3 },
      activeTabId: a3,
    })
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(1)
    useTabStore.getState().switchTab(a2)
    useTabStore.getState().switchTab(a3)
    expect(useTabStore.getState().groupSelection.g1).toBe(a2)
    useTabStore.getState().closeTab(a3)
    // g2 sits between, but holds only the other worktree's tab.
    expect(useTabStore.getState().activeTabId).toBe(a2)
  })

  it("removing the scoped worktree moves to its parent repo", () => {
    setFolders([{ id: 1 }, { id: 2 }, { id: 3, parent_id: 1 }])
    open(2, 21)
    open(3, 31)
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(3)
    useTabStore.getState().closeTabsByFolder(3)
    useAppWorkspaceStore.getState().applyFolderRemove(3)
    expect(useFolderTabsStore.getState().scope).toBe(1)
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(1)
  })

  it("removing a scoped folder without tabs or parent moves to a remaining tab's scope", () => {
    setFolders([{ id: 1 }, { id: 2 }, { id: 3 }])
    const b1 = open(2, 21)
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(3)
    useAppWorkspaceStore.setState({
      folders: useAppWorkspaceStore
        .getState()
        .folders.filter((folder) => folder.id !== 3),
    })
    expect(useFolderTabsStore.getState().scope).toBe(2)
    expect(useTabStore.getState().activeTabId).toBe(b1)
  })

  it("falls back to the first open folder when no tab is left", () => {
    setFolders([{ id: 1 }, { id: 2 }])
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(2)
    useAppWorkspaceStore.getState().applyFolderRemove(2)
    expect(useFolderTabsStore.getState().scope).toBe(1)
  })

  it("inherits the agent of the tab the user is on, not the target scope's", () => {
    useTabStore.getState().openTab(2, 21, "claude_code", true)
    useTabStore.getState().openTab(1, 11, "codex", true)
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(1)
    const draft = useTabStore
      .getState()
      .openNewConversationTab(2, "/repo2", { inheritFromActive: true })
    expect(useFolderTabsStore.getState().scope).toBe(2)
    expect(draft.agentType).toBe("codex")
  })

  it("switching a draft to chat mode moves that draft into the global scope", () => {
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope("global")
    const globalDraft = useTabStore.getState().openChatModeTab().tabId
    useFolderTabsStore.getState().activateScope(1)
    const draftA = useTabStore
      .getState()
      .openNewConversationTab(1, "/repo1").tabId
    expect(draftA).not.toBe(globalDraft)

    const moved = useTabStore
      .getState()
      .openChatModeTab({ retargetTabId: draftA })
    expect(moved.tabId).toBe(draftA)
    expect(useFolderTabsStore.getState().scope).toBe("global")
    expect(useTabStore.getState().activeTabId).toBe(draftA)
    expect(
      useTabStore.getState().rawTabs.find((tab) => tab.id === draftA)
    ).toMatchObject({ isChat: true, folderId: 0 })
    // The chat view's own blank draft would sit beside it: one is enough.
    expect(draftIds()).toEqual([draftA])
  })

  it("keeps the chat view's own draft when it holds text", () => {
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope("global")
    const globalDraft = useTabStore.getState().openChatModeTab().tabId
    typeInto(globalDraft)
    useFolderTabsStore.getState().activateScope(1)
    const draftA = useTabStore
      .getState()
      .openNewConversationTab(1, "/repo1").tabId
    useTabStore.getState().openChatModeTab({ retargetTabId: draftA })
    expect(draftIds().sort()).toEqual([draftA, globalDraft].sort())
  })

  it("a new chat inherits the agent of the tab the user is on", () => {
    useTabStore.getState().openTab(1, 11, "open_code", true)
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(1)
    const chat = useTabStore.getState().openChatModeTab()
    expect(useFolderTabsStore.getState().scope).toBe("global")
    expect(chat.agentType).toBe("open_code")
  })

  it("the folder picker moves its own draft, and the scope follows it", async () => {
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(2)
    const draftB = useTabStore
      .getState()
      .openNewConversationTab(2, "/repo2").tabId
    useFolderTabsStore.getState().activateScope(1)
    const draftA = useTabStore
      .getState()
      .openNewConversationTab(1, "/repo1").tabId
    expect(draftA).not.toBe(draftB)

    useTabStore.getState().openNewConversationTab(2, "/repo2", {
      inheritFromActive: true,
      retargetTabId: draftA,
    })
    // Still on screen in its own worktree while the retarget is queued.
    expect(useFolderTabsStore.getState().scope).toBe(1)
    expect(useTabStore.getState().activeTabId).toBe(draftA)
    expect(useTabStore.getState().draftRetargetRequests).toMatchObject([
      { tabId: draftA, folderId: 2 },
    ])

    useTabStore.getState().consumeDraftRetargets()
    await vi.waitFor(() =>
      expect(
        useTabStore.getState().rawTabs.find((tab) => tab.id === draftA)
          ?.folderId
      ).toBe(2)
    )
    expect(useFolderTabsStore.getState().scope).toBe(2)
    expect(useTabStore.getState().activeTabId).toBe(draftA)
    // Folder 2's own blank draft would sit beside it: one is enough.
    expect(draftIds()).toEqual([draftA])
  })

  async function moveDraftIntoFolder2(
    prepareTarget: (draftB: string) => void,
    beforeLanding: () => void = () => {}
  ) {
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(2)
    const draftB = useTabStore
      .getState()
      .openNewConversationTab(2, "/repo2").tabId
    prepareTarget(draftB)
    useFolderTabsStore.getState().activateScope(1)
    const draftA = useTabStore
      .getState()
      .openNewConversationTab(1, "/repo1").tabId
    useTabStore.getState().openNewConversationTab(2, "/repo2", {
      inheritFromActive: true,
      retargetTabId: draftA,
    })
    beforeLanding()
    useTabStore.getState().consumeDraftRetargets()
    await vi.waitFor(() =>
      expect(
        useTabStore.getState().rawTabs.find((tab) => tab.id === draftA)
          ?.folderId
      ).toBe(2)
    )
    return { draftA, draftB }
  }

  it("keeps the target folder's own draft when it holds text", async () => {
    const { draftA, draftB } = await moveDraftIntoFolder2(typeInto)
    expect(draftIds().sort()).toEqual([draftA, draftB].sort())
  })

  // Typing still inside the composer's save debounce, or an image attachment
  // (never saved), is content the saved draft does not show yet.
  it("keeps the target folder's own draft while its composer holds unsaved content", async () => {
    const live = (draftId: string) =>
      buildNewConversationDraftStorageKey(draftId)
    let liveKey = ""
    try {
      const { draftA, draftB } = await moveDraftIntoFolder2((draft) => {
        liveKey = live(draft)
        setLiveComposerContent(liveKey, "composer", true)
      })
      expect(draftIds().sort()).toEqual([draftA, draftB].sort())
    } finally {
      setLiveComposerContent(liveKey, "composer", false)
    }
  })

  it("keeps the target folder's draft the user switched to while the move was pending", async () => {
    let target = ""
    const { draftA, draftB } = await moveDraftIntoFolder2(
      (draft) => {
        target = draft
      },
      () => useTabStore.getState().switchTab(target)
    )
    expect(useFolderTabsStore.getState().scope).toBe(2)
    expect(useTabStore.getState().activeTabId).toBe(draftB)
    expect(draftIds().sort()).toEqual([draftA, draftB].sort())
  })

  it("closes the target folder's blank draft even when the user moved on", async () => {
    const { draftA } = await moveDraftIntoFolder2(
      () => {},
      // Off to another folder before the move lands: nothing follows it.
      () => useFolderTabsStore.getState().activateScope(3)
    )
    expect(useFolderTabsStore.getState().scope).toBe(3)
    expect(draftIds()).toEqual([draftA])
  })

  it("turning the mode off leaves one blank draft per group, plus every draft with text", () => {
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(1)
    const draftA = useTabStore
      .getState()
      .openNewConversationTab(1, "/repo1").tabId
    useFolderTabsStore.getState().activateScope(2)
    const draftB = useTabStore
      .getState()
      .openNewConversationTab(2, "/repo2").tabId
    typeInto(draftB)
    useFolderTabsStore.getState().activateScope(3)
    useTabStore.getState().openNewConversationTab(3, "/repo3")
    useFolderTabsStore.getState().activateScope(1)
    expect(useTabStore.getState().activeTabId).toBe(draftA)

    useFolderTabsStore.getState().setEnabled(false)
    expect(draftIds().sort()).toEqual([draftA, draftB].sort())
    expect(useTabStore.getState().activeTabId).toBe(draftA)
  })

  it("turning the mode off tidies each group on its own", () => {
    // Normal mode: a conversation, and a split whose new group got a draft.
    const a1 = open(1, 11)
    useTabStore.getState().splitTab(a1, "right", { move: false })
    const splitDraft = useTabStore.getState().activeTabId!
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(2)
    const draft2 = useTabStore
      .getState()
      .openNewConversationTab(2, "/repo2").tabId
    useFolderTabsStore.getState().activateScope(3)
    const draft3 = useTabStore
      .getState()
      .openNewConversationTab(3, "/repo3").tabId

    useFolderTabsStore.getState().setEnabled(false)
    // Both new drafts land in the first group, which keeps the active one;
    // the split group's own draft is alone in its group and stays.
    expect(draftIds().sort()).toEqual([splitDraft, draft3].sort())
    expect(draftIds()).not.toContain(draft2)
  })
})

describe("Folder-tabs split layouts per folder", () => {
  /** The tab set the server reports, so the invariant pass trusts it. */
  async function markTabSetKnown() {
    const st = useTabStore.getState()
    useTabStore.setState({ tabsHydrated: true })
    vi.mocked(api.listOpenedTabs).mockResolvedValue({
      version: 1,
      items: st.rawTabs.flatMap((tab, position) =>
        tab.conversationId == null
          ? []
          : [
              {
                folder_id: tab.folderId,
                conversation_id: tab.conversationId,
                agent_type: tab.agentType,
                is_pinned: true,
                is_active: tab.id === st.activeTabId,
                position,
              },
            ]
      ),
    } as never)
    await useTabStore.getState().refetchTabs()
  }
  const layout = () => useTabStore.getState().groupLayout
  const leaves = () => leafIds(layout())
  const shellOf = (tabId: string) =>
    shellGroupOfTab(useTabStore.getState(), tabId)

  async function twoFolders() {
    const a1 = open(1, 11)
    const a2 = open(1, 12)
    const b1 = open(2, 21)
    const b2 = open(2, 22)
    await markTabSetKnown()
    // TabProvider keeps the active folder in step with the active tab.
    useTabStore.getState().syncActiveFolderId()
    useFolderTabsStore.getState().setEnabled(true)
    return { a1, a2, b1, b2 }
  }

  /** A fresh start: both stores rebuilt from storage, the mode still off. */
  function restart() {
    const blob = localStorage.getItem("workspace:tab-groups:v1")!
    resetFolderTabsStore()
    localStorage.setItem("workspace:tab-groups:v1", blob)
    resetTabStore()
  }

  it("splits, resizes and unsplits one folder without touching another's layout", async () => {
    const { a2, b2 } = await twoFolders()
    useFolderTabsStore.getState().activateScope(1)
    useTabStore.getState().splitTab(a2, "right", { move: true })
    const folderA = layout()
    expect(leaves()).toHaveLength(2)

    // Folder B was never split, so it shows one group — not A's pair.
    useFolderTabsStore.getState().activateScope(2)
    expect(leaves()).toHaveLength(1)
    useTabStore.getState().splitTab(b2, "down", { move: true })
    const split = layout() as SplitNode
    expect(split.orientation).toBe("vertical")
    useTabStore.getState().resizeGroupSplit(split.id, 0, 0.7)
    expect((layout() as SplitNode).ratios[0]).toBeCloseTo(0.7)

    useFolderTabsStore.getState().activateScope(1)
    expect(layout()).toEqual(folderA)
    useTabStore.getState().unsplitAll()
    expect(leaves()).toHaveLength(1)

    useFolderTabsStore.getState().activateScope(2)
    expect(leaves()).toHaveLength(2)
    expect((layout() as SplitNode).orientation).toBe("vertical")
    expect((layout() as SplitNode).ratios[0]).toBeCloseTo(0.7)
  })

  it("flips orientation and dissolves groups inside the folder on screen only", async () => {
    const { a2, b2 } = await twoFolders()
    useFolderTabsStore.getState().activateScope(1)
    useTabStore.getState().splitTab(a2, "right", { move: true })
    useFolderTabsStore.getState().activateScope(2)
    useTabStore.getState().splitTab(b2, "right", { move: true })
    const bGroup = leaves()[1]

    useTabStore.getState().toggleGroupOrientation(bGroup)
    expect((layout() as SplitNode).orientation).toBe("vertical")
    useFolderTabsStore.getState().activateScope(1)
    expect((layout() as SplitNode).orientation).toBe("horizontal")

    useFolderTabsStore.getState().activateScope(2)
    useTabStore.getState().dissolveGroup(bGroup)
    expect(leaves()).toHaveLength(1)
    useFolderTabsStore.getState().activateScope(1)
    expect(leaves()).toHaveLength(2)
  })

  it("closes a folder's emptied first group while other folders still have tabs", async () => {
    const { a1, a2 } = await twoFolders()
    useFolderTabsStore.getState().activateScope(1)
    useTabStore.getState().splitTab(a2, "right", { move: true })
    useTabStore.getState().closeTab(a1)
    expect(leaves()).toEqual([shellOf(a2)])
  })

  it("counts only the folder's own tabs before moving one into a split", async () => {
    const a1 = open(1, 11)
    open(2, 21)
    open(2, 22)
    await markTabSetKnown()
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(1)
    const before = layout()
    // Folder 1 has one tab; folder 2's two in the same group do not count.
    useTabStore.getState().splitTab(a1, "right", { move: true })
    expect(layout()).toBe(before)
    expect(shellOf(a1)).toBe(leafIds(before)[0])
  })

  it("keeps every hidden tab in its own group shell across folder switches", async () => {
    const { a1, a2, b1, b2 } = await twoFolders()
    useFolderTabsStore.getState().activateScope(1)
    useTabStore.getState().splitTab(a2, "right", { move: true })
    const shells = () => [a1, a2, b1, b2].map(shellOf)
    const before = shells()
    expect(before[0]).not.toBe(before[1])

    useFolderTabsStore.getState().activateScope(2)
    expect(shells()).toEqual(before)
    useTabStore.getState().splitTab(b2, "down", { move: true })
    const afterSplitB = shells()
    useFolderTabsStore.getState().activateScope(1)
    expect(shells()).toEqual(afterSplitB)
  })

  it("turning the mode on narrows the normal layout under the same group ids; off restores it", async () => {
    const a1 = open(1, 11)
    const b1 = open(2, 21)
    const b2 = open(2, 22)
    await markTabSetKnown()
    useTabStore.getState().splitTab(b2, "right", { move: true })
    const normal = layout()
    const shells = () => [a1, b1, b2].map(shellOf)
    const before = shells()

    useTabStore.getState().syncActiveFolderId()
    useFolderTabsStore.getState().setEnabled(true)
    expect(useFolderTabsStore.getState().scope).toBe(2)
    // B's tabs sit in both normal-mode groups: the same layout, no tab moved.
    expect(leaves()).toEqual(leafIds(normal))
    expect(shells()).toEqual(before)

    // A's only tab sits in the first group, so A is unsplit.
    useFolderTabsStore.getState().activateScope(1)
    expect(leaves()).toEqual([leafIds(normal)[0]])
    useTabStore.getState().splitTab(a1, "down", { move: false })
    expect(leaves()).toHaveLength(2)

    useFolderTabsStore.getState().setEnabled(false)
    expect(layout()).toEqual(normal)
    expect(useTabStore.getState().groupViews).toEqual({})
  })

  it("brings each folder's layout back after a restart with the mode on", async () => {
    const { a2 } = await twoFolders()
    useFolderTabsStore.getState().activateScope(1)
    useTabStore.getState().splitTab(a2, "right", { move: true })
    const folderA = layout()
    useFolderTabsStore.getState().activateScope(2)
    const blob = JSON.parse(localStorage.getItem("workspace:tab-groups:v1")!)
    expect(Object.keys(blob.views).sort()).toEqual(["scope:1", "scope:2"])
    // The top level stays the normal-mode layout, unsplit.
    expect(blob.layout.type).toBe("group")

    // Restart: the stores start over from storage and the server's tab set.
    restart()
    expect(Object.keys(useTabStore.getState().groupViews).sort()).toEqual([
      "scope:1",
      "scope:2",
    ])
    useTabStore.setState({ tabsHydrated: true })
    await useTabStore.getState().refetchTabs()
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(1)
    expect(layout()).toEqual(folderA)
    expect(shellOf(a2)).toBe(leafIds(folderA)[1])
  })

  // The first snapshot failed: the tab set is unknown when the stored mode
  // comes back on, and the conversations the blob arranges arrive later.
  it("keeps a folder's split for conversations that load after the mode came on", async () => {
    localStorage.setItem(
      "workspace:tab-groups:v1",
      JSON.stringify({
        layout: {
          type: "split",
          id: "s",
          orientation: "horizontal",
          ratios: [0.5, 0.5],
          children: [
            { type: "group", id: "g-main" },
            { type: "group", id: "g-two" },
          ],
        },
        assignments: {
          "conv-1-claude_code-11": "g-main",
          "conv-1-claude_code-12": "g-two",
        },
        selection: {},
        tileByGroup: {},
        drafts: [],
        activeDraft: null,
      })
    )
    resetTabStore()
    useTabStore.setState({ tabsHydrated: true })
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(1)

    vi.mocked(api.listOpenedTabs).mockResolvedValue({
      version: 1,
      items: [11, 12].map((conversationId, position) => ({
        folder_id: 1,
        conversation_id: conversationId,
        agent_type: "claude_code",
        is_pinned: true,
        is_active: position === 0,
        position,
      })),
    } as never)
    await useTabStore.getState().refetchTabs()
    expect(leaves()).toEqual(["g-main", "g-two"])
    expect(shellOf("conv-1-claude_code-12")).toBe("g-two")
  })

  it("drops the last session's folder views when the stored mode comes back off", async () => {
    const { a2 } = await twoFolders()
    useFolderTabsStore.getState().activateScope(1)
    useTabStore.getState().splitTab(a2, "right", { move: true })
    restart()
    expect(Object.keys(useTabStore.getState().groupViews)).not.toHaveLength(0)
    useTabStore.setState({ tabsHydrated: true })
    await useTabStore.getState().refetchTabs()
    dropParkedFolderGroupViews()
    expect(useTabStore.getState().groupViews).toEqual({})
    // Turned on later, folder 1 starts from the (unsplit) normal layout.
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(1)
    expect(leaves()).toHaveLength(1)
  })
})
