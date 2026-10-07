import { act, render, screen, waitFor } from "@testing-library/react"
import { useEffect } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TabProvider, useTabContext } from "@/contexts/tab-context"
import { CONVERSATION_CHANGED_EVENT, TABS_CHANGED_EVENT } from "@/lib/types"
import type {
  AgentType,
  ConversationChange,
  DbConversationSummary,
  FolderDetail,
  OpenedTab,
  SaveTabsOutcome,
  TabsChanged,
} from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import {
  groupOfTab,
  isReparentUnmount,
  resetTabStore,
  selectIsSplit,
  useTabStore,
  type OpenedDraftTarget,
} from "@/stores/tab-store"
import { leafIds } from "@/lib/tab-group-layout"
import {
  buildNewConversationDraftStorageKey,
  loadMessageInputDraftV2,
  saveMessageInputDraftV2,
} from "@/lib/message-input-draft"

const listOpenedTabsMock = vi.fn()
const saveOpenedTabsMock = vi.fn()
const getFolderConversationMock = vi.fn()
const setActiveFolderIdMock = vi.fn()
const activateConversationPaneMock = vi.fn()
const disconnectMock = vi.fn()
const subscribeMock = vi.fn()
const onTransportReconnectMock = vi.fn()
const loadLastActiveContextMock = vi.fn()
const saveLastActiveContextMock = vi.fn()
const clearLastActiveContextMock = vi.fn()
// Captured `tabs://changed` handler so tests can simulate inbound broadcasts.
let tabsChangedHandler: ((change: TabsChanged) => void) | null = null
// Captured `conversation://changed` handler so tests can drive sub-session
// status/upsert/delete events into the open-tab summary cache.
let conversationChangedHandler: ((change: ConversationChange) => void) | null =
  null

vi.mock("next-intl", () => {
  // Return a STABLE function instance across renders, mirroring next-intl's
  // real behavior. An unstable `t` would re-run effects that depend on it
  // (e.g. the hydrate effect) on every render.
  const t = (key: string) => key
  return { useTranslations: () => t }
})

vi.mock("@/lib/api", () => ({
  listOpenedTabs: (...args: unknown[]) => listOpenedTabsMock(...args),
  saveOpenedTabs: (...args: unknown[]) => saveOpenedTabsMock(...args),
  getFolderConversation: (...args: unknown[]) =>
    getFolderConversationMock(...args),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: (...args: unknown[]) => subscribeMock(...args),
  onTransportReconnect: (...args: unknown[]) =>
    onTransportReconnectMock(...args),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({
    activateConversationPane: activateConversationPaneMock,
  }),
}))

vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => ({
    disconnect: disconnectMock,
  }),
}))

vi.mock("@/hooks/use-sorted-available-agents", () => ({
  useSortedAvailableAgents: () => ({
    sortedTypes: ["codex" satisfies AgentType],
    fresh: true,
  }),
}))

vi.mock("@/lib/last-active-context-storage", () => ({
  loadLastActiveContext: () => loadLastActiveContextMock(),
  saveLastActiveContext: (...args: unknown[]) =>
    saveLastActiveContextMock(...args),
  clearLastActiveContext: () => clearLastActiveContextMock(),
}))

const defaultFoldersMock: FolderDetail[] = [
  {
    id: 1,
    name: "repo",
    path: "/repo",
    git_branch: null,
    default_agent_type: "codex",
    last_opened_at: "2026-05-24T00:00:00Z",
    sort_order: 0,
    color: "blue",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
  },
  {
    id: 2,
    name: "other",
    path: "/other",
    git_branch: null,
    default_agent_type: "codex",
    last_opened_at: "2026-05-24T00:00:00Z",
    sort_order: 1,
    color: "green",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
  },
]

const defaultConversationsMock: DbConversationSummary[] = [
  {
    id: 1,
    folder_id: 1,
    title: "First",
    title_locked: false,
    agent_type: "codex",
    status: "in_progress",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 1,
    child_count: 0,
    created_at: "2026-05-24T00:00:00Z",
    updated_at: "2026-05-24T00:00:00Z",
    pinned_at: null,
  },
  {
    id: 2,
    folder_id: 1,
    title: "Second",
    title_locked: false,
    agent_type: "codex",
    status: "in_progress",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 1,
    child_count: 0,
    created_at: "2026-05-24T00:00:00Z",
    updated_at: "2026-05-24T00:00:00Z",
    pinned_at: null,
  },
  {
    id: 3,
    folder_id: 2,
    title: "Third",
    title_locked: false,
    agent_type: "codex",
    status: "in_progress",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 1,
    child_count: 0,
    created_at: "2026-05-24T00:00:00Z",
    updated_at: "2026-05-24T00:00:00Z",
    pinned_at: null,
  },
]

// Reset the real workspace store and seed it with the default fixtures.
// `allFolders` includes hidden chat folders that the user-facing `folders`
// list excludes; both default to the same set (no chat folders) for most
// tests. `conversationsLoading` gates the sub-session seed effect; it defaults
// to loaded (false) so most tests seed immediately. Individual tests override
// slices via `useAppWorkspaceStore.setState` (e.g. an empty root list for the
// loaded-but-empty case).
function seedWorkspaceStore() {
  resetAppWorkspaceStore()
  useAppWorkspaceStore.setState({
    conversations: defaultConversationsMock,
    conversationsLoading: false,
    folders: defaultFoldersMock,
    allFolders: defaultFoldersMock,
    foldersHydrated: true,
    setActiveFolderId: setActiveFolderIdMock,
  })
  // Drop device-local group/tile blobs BEFORE the reset re-reads them —
  // `persistGroupState` writes localStorage during hydrated tests and would
  // otherwise leak split layouts across tests.
  localStorage.clear()
  // The tab store is a module-level singleton: reset it (state + coordination
  // vars + injected runtime + one-shot correction/recovery flags) after seeding
  // the workspace store so `lastConversations` aligns with the seeded list.
  resetTabStore()
}

let latestContext: ReturnType<typeof useTabContext> | null = null

function Probe() {
  const ctx = useTabContext()
  const activeTab = ctx.tabs.find((tab) => tab.id === ctx.activeTabId)

  useEffect(() => {
    latestContext = ctx
  }, [ctx])

  return (
    <div>
      <output data-testid="active">{ctx.activeTabId ?? "none"}</output>
      <output data-testid="tabs">
        {ctx.tabs.map((tab) => tab.id).join(",")}
      </output>
      <output data-testid="active-folder">
        {activeTab?.folderId ?? "none"}
      </output>
    </div>
  )
}

function renderTabs() {
  latestContext = null
  return render(
    <TabProvider>
      <Probe />
    </TabProvider>
  )
}

function openConversationTab(
  folderId: number,
  conversationId: number,
  title: string
) {
  act(() => {
    latestContext?.openTab(folderId, conversationId, "codex", true, title)
  })
}

describe("TabProvider tab state transitions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedWorkspaceStore()
    listOpenedTabsMock.mockReturnValue(new Promise(() => {}))
    saveOpenedTabsMock.mockResolvedValue({
      accepted: true,
      version: 1,
      tabs: [],
    })
    // mockReset (not just clearAllMocks) also drains any leftover
    // mockReturnValueOnce queue from a prior test so it can't leak a stale
    // (e.g. never-resolving) promise into the next test's first fetch.
    getFolderConversationMock.mockReset()
    getFolderConversationMock.mockReturnValue(new Promise(() => {}))
    tabsChangedHandler = null
    conversationChangedHandler = null
    subscribeMock.mockImplementation((event: string, handler: unknown) => {
      if (event === TABS_CHANGED_EVENT)
        tabsChangedHandler = handler as (change: TabsChanged) => void
      if (event === CONVERSATION_CHANGED_EVENT)
        conversationChangedHandler = handler as (
          change: ConversationChange
        ) => void
      return Promise.resolve(() => {})
    })
    onTransportReconnectMock.mockReturnValue(() => {})
  })

  it("activates the neighboring tab when another tab update is already queued", () => {
    renderTabs()

    expect(latestContext).not.toBeNull()

    openConversationTab(1, 1, "First")
    openConversationTab(1, 2, "Second")
    act(() => {
      latestContext?.switchTab("conv-1-codex-1")
    })

    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-1")

    act(() => {
      latestContext?.setTabRuntimeConversationId("conv-1-codex-1", -1)
      latestContext?.closeTab("conv-1-codex-1")
    })

    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-2")
    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-2")
  })

  it("keeps the current active tab when closing an inactive tab", () => {
    renderTabs()

    expect(latestContext).not.toBeNull()

    openConversationTab(1, 1, "First")
    openConversationTab(1, 2, "Second")
    act(() => {
      latestContext?.switchTab("conv-1-codex-1")
    })

    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-1")

    act(() => {
      latestContext?.closeTab("conv-1-codex-2")
    })

    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-1")
    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-1")
  })

  it("creates and activates a replacement draft when closing the last tab with folders available", () => {
    renderTabs()

    expect(latestContext).not.toBeNull()

    openConversationTab(1, 1, "First")

    act(() => {
      latestContext?.closeTab("conv-1-codex-1")
    })

    const tabsText = screen.getByTestId("tabs").textContent ?? ""
    expect(tabsText).toMatch(/^new-/)
    expect(screen.getByTestId("active")).toHaveTextContent(tabsText)
  })

  it("clears the active tab when closing the last tab with no folders available", () => {
    act(() => {
      useAppWorkspaceStore.setState({ folders: [] })
    })
    renderTabs()

    expect(latestContext).not.toBeNull()

    openConversationTab(1, 1, "First")

    act(() => {
      latestContext?.closeTab("conv-1-codex-1")
    })

    expect(screen.getByTestId("tabs")).toHaveTextContent("")
    expect(screen.getByTestId("active")).toHaveTextContent("none")
  })

  it("activates a remaining tab when closing a folder after switching to one of its tabs in the same batch", () => {
    renderTabs()

    expect(latestContext).not.toBeNull()

    openConversationTab(1, 1, "First")
    openConversationTab(1, 2, "Second")
    openConversationTab(2, 3, "Third")
    act(() => {
      latestContext?.switchTab("conv-2-codex-3")
    })

    expect(screen.getByTestId("active")).toHaveTextContent("conv-2-codex-3")

    act(() => {
      latestContext?.switchTab("conv-1-codex-1")
      latestContext?.closeTabsByFolder(1)
    })

    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-2-codex-3")
    expect(screen.getByTestId("active")).toHaveTextContent("conv-2-codex-3")
  })

  it("ignores closeOtherTabs when its target was removed earlier in the same batch", () => {
    renderTabs()

    expect(latestContext).not.toBeNull()

    openConversationTab(1, 1, "First")
    openConversationTab(1, 2, "Second")

    act(() => {
      latestContext?.closeTab("conv-1-codex-1")
      latestContext?.closeOtherTabs("conv-1-codex-1")
    })

    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-2")
    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-2")
  })

  it("keeps an existing draft active when reopening a draft after closing it in the same batch", () => {
    renderTabs()

    expect(latestContext).not.toBeNull()

    act(() => {
      latestContext?.openNewConversationTab(1, "/repo")
    })

    const draftTabId = latestContext?.activeTabId
    expect(draftTabId).toMatch(/^new-/)

    act(() => {
      latestContext?.closeTab(draftTabId!)
      latestContext?.openNewConversationTab(1, "/repo")
    })

    const tabsText = screen.getByTestId("tabs").textContent ?? ""
    expect(tabsText).toMatch(/^new-/)
    expect(screen.getByTestId("active")).toHaveTextContent(tabsText)
  })

  it("redirects a new-conversation action targeting a hidden chat folder to chat mode", () => {
    // The open-folder list (`folders`) excludes chat folders after refetch, but
    // `allFolders` keeps them — chat detection must read `allFolders`, else a
    // "new conversation" from an active chat conversation would pile a normal
    // draft onto the hidden per-conversation chat folder.
    const chatFolder: FolderDetail = {
      id: 42,
      name: "Chat",
      path: "/data/chat-sessions/x",
      git_branch: null,
      default_agent_type: null,
      last_opened_at: "2026-06-11T00:00:00Z",
      sort_order: 99,
      color: "inherit",
      parent_id: null,
      kind: "chat",
      alias: null,
      group_id: null,
    }
    act(() => {
      useAppWorkspaceStore.setState({
        folders: defaultFoldersMock,
        allFolders: [...defaultFoldersMock, chatFolder],
      })
    })
    renderTabs()
    expect(latestContext).not.toBeNull()

    act(() => {
      latestContext?.openNewConversationTab(42, "/data/chat-sessions/x")
    })

    const activeId = latestContext?.activeTabId ?? ""
    const draft = latestContext?.tabs.find((t) => t.id === activeId)
    expect(activeId).toMatch(/^new-/)
    expect(draft?.isChat).toBe(true)
    expect(draft?.folderId).toBe(0)
  })

  it("seeds a non-chat replacement draft when closing a bound chat tab whose folder is filtered from the open list", () => {
    const chatFolder: FolderDetail = {
      id: 42,
      name: "Chat",
      path: "/data/chat-sessions/x",
      git_branch: null,
      default_agent_type: null,
      last_opened_at: "2026-06-11T00:00:00Z",
      sort_order: 99,
      color: "inherit",
      parent_id: null,
      kind: "chat",
      alias: null,
      group_id: null,
    }
    act(() => {
      useAppWorkspaceStore.setState({
        folders: defaultFoldersMock, // open list excludes the chat folder
        allFolders: [...defaultFoldersMock, chatFolder],
      })
    })
    renderTabs()
    expect(latestContext).not.toBeNull()

    act(() => {
      latestContext?.openTab(42, 5, "codex", true, "chat conversation")
    })
    act(() => {
      latestContext?.closeTab("conv-42-codex-5")
    })

    const replId = latestContext?.activeTabId ?? ""
    const repl = latestContext?.tabs.find((t) => t.id === replId)
    expect(replId).toMatch(/^new-/)
    expect(repl?.conversationId).toBeNull()
    expect(repl?.folderId).not.toBe(42)
    expect(repl?.isChat ?? false).toBe(false)
  })

  it("retargets the replacement draft when reopening a closed draft for another folder in the same batch", async () => {
    renderTabs()

    expect(latestContext).not.toBeNull()

    act(() => {
      latestContext?.openNewConversationTab(1, "/repo")
    })

    const draftTabId = latestContext?.activeTabId
    expect(draftTabId).toMatch(/^new-/)

    act(() => {
      latestContext?.closeTab(draftTabId!)
      latestContext?.openNewConversationTab(2, "/other")
    })

    const replacementTabId = screen.getByTestId("tabs").textContent ?? ""
    expect(replacementTabId).toMatch(/^new-/)
    expect(replacementTabId).not.toBe(draftTabId)
    expect(screen.getByTestId("active")).toHaveTextContent(replacementTabId)

    await waitFor(() => {
      expect(disconnectMock).toHaveBeenCalledWith(replacementTabId)
      expect(screen.getByTestId("active-folder")).toHaveTextContent("2")
    })
  })

  it("applies the supplied folderDefaultAgent for a folder not in the open list", () => {
    // Regression: navigating a branch switch to a just-reopened (closed) folder
    // passes that folder's saved default agent explicitly, because `foldersRef`
    // only catches up on the next render. Folder 999 is absent from the
    // provider's folders, so without the override the draft would fall back to
    // sortedTypes[0] ("codex"); the override must win.
    renderTabs()
    expect(latestContext).not.toBeNull()

    act(() => {
      latestContext?.openNewConversationTab(999, "/closed-wt", {
        folderDefaultAgent: "claude_code",
      })
    })

    const activeId = latestContext?.activeTabId
    const draft = latestContext?.tabs.find((tab) => tab.id === activeId)
    expect(draft?.folderId).toBe(999)
    expect(draft?.agentType).toBe("claude_code")
  })

  it("pins the draft to a forced agent, outranking the folder default", () => {
    // "Ask about this selection" opens the question on the agent that WROTE the
    // text, so the force has to beat folder 1's pinned "codex" default — which
    // otherwise wins over everything.
    renderTabs()
    expect(latestContext).not.toBeNull()

    let opened: OpenedDraftTarget | null = null
    act(() => {
      opened = latestContext!.openNewConversationTab(1, "/repo", {
        forceAgent: "claude_code",
      })
    })

    const target = opened as OpenedDraftTarget | null
    expect(target?.tabId).toBe(latestContext?.activeTabId)
    expect(target).toMatchObject({ agentType: "claude_code", folderId: 1 })
    const draft = latestContext?.tabs.find((tab) => tab.id === target?.tabId)
    expect(draft?.agentType).toBe("claude_code")
    // Explicit caller intent, so the provisional-agent correction pass must not
    // "fix" it back to the resolved default once the agent list goes fresh.
    expect(
      useTabStore.getState().rawTabs.find((t) => t.id === target?.tabId)
        ?.agentTypeProvisional
    ).toBe(false)
  })

  it("promises the retargeted identity when it reuses the group's draft", () => {
    // Each group keeps a single draft, so the second open retargets the first
    // tab rather than adding one — ASYNCHRONOUSLY. Callers that hand work to the
    // returned tab (the "ask about this selection" hand-off) must be told the
    // identity it is heading for, not the stale one it still has, or they would
    // act on the tab while it is still the previous folder's agent.
    renderTabs()
    expect(latestContext).not.toBeNull()

    let first: OpenedDraftTarget | null = null
    act(() => {
      first = latestContext!.openNewConversationTab(1, "/repo")
    })
    expect((first as OpenedDraftTarget | null)?.tabId).toMatch(/^new-/)

    let second: OpenedDraftTarget | null = null
    act(() => {
      // A different agent — the retarget path, not the plain focus path.
      second = latestContext!.openNewConversationTab(1, "/repo", {
        forceAgent: "claude_code",
      })
    })

    const reused = second as OpenedDraftTarget | null
    expect(reused?.tabId).toBe((first as OpenedDraftTarget | null)?.tabId)
    // The promise is the POST-retarget identity, even though the tab has not
    // been patched yet at this point.
    expect(reused).toMatchObject({ agentType: "claude_code", folderId: 1 })
    expect(
      latestContext?.tabs.filter((t) => t.conversationId == null)
    ).toHaveLength(1)
  })

  it("re-points an existing chat draft at a forced agent", () => {
    // A chat-mode draft is normally left alone when it is reopened — it keeps
    // whatever agent it was on, because `inherit` is only a suggestion. A FORCED
    // agent is not: asking about a selection in a codex chat must not have the
    // question answered by whichever agent the group's chat draft happened to be
    // sitting on.
    renderTabs()
    expect(latestContext).not.toBeNull()

    act(() => {
      latestContext?.openChatModeTab({ forceAgent: "claude_code" })
    })
    const chatDraftId = latestContext?.activeTabId ?? ""
    expect(
      latestContext?.tabs.find((t) => t.id === chatDraftId)?.agentType
    ).toBe("claude_code")

    let reopened: OpenedDraftTarget | null = null
    act(() => {
      reopened = latestContext!.openChatModeTab({ forceAgent: "codex" })
    })

    const target = reopened as OpenedDraftTarget | null
    expect(target?.tabId).toBe(chatDraftId)
    expect(target).toMatchObject({ agentType: "codex", folderId: 0 })
    const draft = latestContext?.tabs.find((t) => t.id === chatDraftId)
    expect(draft?.agentType).toBe("codex")
    expect(draft?.isChat).toBe(true)
    expect(
      useTabStore.getState().rawTabs.find((t) => t.id === chatDraftId)
        ?.agentTypeProvisional
    ).toBe(false)
  })

  it("activates an opened tab when another tab update is already queued", () => {
    renderTabs()

    expect(latestContext).not.toBeNull()

    openConversationTab(1, 1, "First")

    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-1")

    act(() => {
      latestContext?.setTabRuntimeConversationId("conv-1-codex-1", -1)
      latestContext?.openTab(1, 2, "codex", true, "Second")
    })

    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-1")
    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-2")
    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-2")
  })

  it("keeps the retained draft tab active when binding it over an existing duplicate conversation tab", () => {
    renderTabs()

    expect(latestContext).not.toBeNull()

    openConversationTab(1, 1, "First")
    act(() => {
      latestContext?.openNewConversationTab(1, "/repo")
    })

    const draftTabId = latestContext?.activeTabId
    expect(draftTabId).toMatch(/^new-/)

    act(() => {
      latestContext?.setTabRuntimeConversationId(draftTabId!, -1)
      latestContext?.bindConversationTab(draftTabId!, 1, "codex", "First", -1)
    })

    expect(screen.getByTestId("tabs")).toHaveTextContent(draftTabId!)
    expect(screen.getByTestId("tabs").textContent).not.toContain(
      "conv-1-codex-1"
    )
    expect(screen.getByTestId("active")).toHaveTextContent(draftTabId!)
  })

  it("does not report a preview replacement for a preview tab already closed in the same batch", () => {
    const replacedTabIds: string[] = []
    renderTabs()

    expect(latestContext).not.toBeNull()

    latestContext?.onPreviewTabReplaced((tabId) => {
      replacedTabIds.push(tabId)
    })
    act(() => {
      latestContext?.openTab(1, 1, "codex", false, "First")
    })

    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-1")

    act(() => {
      latestContext?.closeTab("conv-1-codex-1")
      latestContext?.openTab(1, 2, "codex", false, "Second")
    })

    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-2")
    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-2")
    expect(replacedTabIds).toEqual([])
  })
})

function tabItem(
  folderId: number,
  conversationId: number,
  isActive = false
): OpenedTab {
  return {
    id: conversationId,
    folder_id: folderId,
    conversation_id: conversationId,
    agent_type: "codex",
    position: 0,
    is_active: isActive,
    is_pinned: true,
  }
}

describe("TabProvider cross-client sync", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedWorkspaceStore()
    listOpenedTabsMock.mockResolvedValue({ items: [], version: 0 })
    saveOpenedTabsMock.mockResolvedValue({
      accepted: true,
      version: 1,
      tabs: [],
    })
    // mockReset (not just clearAllMocks) also drains any leftover
    // mockReturnValueOnce queue from a prior test so it can't leak a stale
    // (e.g. never-resolving) promise into the next test's first fetch.
    getFolderConversationMock.mockReset()
    getFolderConversationMock.mockReturnValue(new Promise(() => {}))
    tabsChangedHandler = null
    conversationChangedHandler = null
    subscribeMock.mockImplementation((event: string, handler: unknown) => {
      if (event === TABS_CHANGED_EVENT)
        tabsChangedHandler = handler as (change: TabsChanged) => void
      if (event === CONVERSATION_CHANGED_EVENT)
        conversationChangedHandler = handler as (
          change: ConversationChange
        ) => void
      return Promise.resolve(() => {})
    })
    disconnectMock.mockResolvedValue(undefined)
    onTransportReconnectMock.mockReturnValue(() => {})
  })

  async function renderHydrated() {
    renderTabs()
    // Flush mount effects: the hydrate promise + the async subscribe() IIFE
    // that captures the handler.
    await act(async () => {})
  }

  it("applies a remote snapshot, adding a conversation tab", async () => {
    await renderHydrated()
    expect(tabsChangedHandler).not.toBeNull()

    act(() => {
      tabsChangedHandler?.({
        version: 1,
        origin: "other-device",
        tabs: [tabItem(1, 1)],
      })
    })

    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-1")
  })

  it("preserves an active chat-mode draft across an inbound remote snapshot", async () => {
    await renderHydrated()
    expect(tabsChangedHandler).not.toBeNull()

    // Enter folderless chat mode → a device-local chat draft (folderId 0).
    act(() => {
      latestContext?.openChatModeTab()
    })
    const chatDraftId = latestContext?.activeTabId ?? ""
    expect(chatDraftId).toMatch(/^new-/)
    expect(latestContext?.tabs.find((t) => t.id === chatDraftId)?.isChat).toBe(
      true
    )

    // A remote snapshot arrives. The chat draft's folderId 0 is in no folder
    // list, so it must be preserved by its `isChat` flag — never silently
    // dropped — keeping the user on their unsent folderless draft.
    act(() => {
      tabsChangedHandler?.({
        version: 1,
        origin: "other-device",
        tabs: [tabItem(1, 1)],
      })
    })

    const draft = latestContext?.tabs.find((t) => t.id === chatDraftId)
    expect(draft).toBeDefined()
    expect(draft?.isChat).toBe(true)
    expect(draft?.conversationId).toBeNull()
  })

  it("does not save when applying a remote snapshot (no echo back)", async () => {
    await renderHydrated()
    saveOpenedTabsMock.mockClear()

    act(() => {
      tabsChangedHandler?.({
        version: 1,
        origin: "other-device",
        tabs: [tabItem(1, 1)],
      })
    })

    // The applying-remote guard makes the save effect a no-op: no timer armed,
    // so the save is never issued.
    expect(saveOpenedTabsMock).not.toHaveBeenCalled()
  })

  it("re-picks a neighbor when a remote snapshot removes the focused tab", async () => {
    await renderHydrated()

    act(() => {
      tabsChangedHandler?.({
        version: 1,
        origin: "x",
        tabs: [tabItem(1, 1), tabItem(1, 2)],
      })
    })
    act(() => {
      latestContext?.switchTab("conv-1-codex-2")
    })
    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-2")

    act(() => {
      tabsChangedHandler?.({ version: 2, origin: "x", tabs: [tabItem(1, 1)] })
    })

    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-1")
    expect(screen.getByTestId("tabs").textContent).not.toContain(
      "conv-1-codex-2"
    )
    // The remote snapshot carried no active marker (sender was on a draft), so
    // focus re-picks the surviving neighbor.
    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-1")
  })

  it("preserves the device-local draft across a remote apply", async () => {
    await renderHydrated()

    act(() => {
      latestContext?.openNewConversationTab(1, "/repo")
    })
    const draftId = latestContext?.activeTabId
    expect(draftId).toMatch(/^new-/)

    act(() => {
      tabsChangedHandler?.({ version: 1, origin: "x", tabs: [tabItem(1, 1)] })
    })

    const tabsText = screen.getByTestId("tabs").textContent ?? ""
    expect(tabsText).toContain("conv-1-codex-1")
    expect(tabsText).toContain(draftId ?? "")
  })

  it("synthesizes a replacement draft when a remote snapshot is empty", async () => {
    listOpenedTabsMock.mockResolvedValue({ items: [tabItem(1, 1)], version: 1 })
    await renderHydrated()
    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-1")

    act(() => {
      tabsChangedHandler?.({ version: 2, origin: "x", tabs: [] })
    })

    const tabsText = screen.getByTestId("tabs").textContent ?? ""
    expect(tabsText).toMatch(/^new-/)
    expect(screen.getByTestId("active")).toHaveTextContent(tabsText)
  })

  it("drops a remote change at or below the current version", async () => {
    listOpenedTabsMock.mockResolvedValue({ items: [], version: 5 })
    await renderHydrated()

    act(() => {
      tabsChangedHandler?.({ version: 3, origin: "x", tabs: [tabItem(1, 1)] })
    })
    expect(screen.getByTestId("tabs").textContent).not.toContain(
      "conv-1-codex-1"
    )

    act(() => {
      tabsChangedHandler?.({ version: 5, origin: "x", tabs: [tabItem(1, 2)] })
    })
    expect(screen.getByTestId("tabs").textContent).not.toContain(
      "conv-1-codex-2"
    )
  })

  it("buffers a remote change that beats hydration and applies it after", async () => {
    let resolveList: (snap: {
      items: OpenedTab[]
      version: number
    }) => void = () => {}
    listOpenedTabsMock.mockReturnValue(
      new Promise((res) => {
        resolveList = res
      })
    )
    renderTabs()
    await act(async () => {
      await Promise.resolve()
    })
    expect(tabsChangedHandler).not.toBeNull()

    // Arrives before hydration completes → buffered, not yet applied.
    act(() => {
      tabsChangedHandler?.({ version: 1, origin: "x", tabs: [tabItem(1, 1)] })
    })
    expect(screen.getByTestId("tabs").textContent).not.toContain(
      "conv-1-codex-1"
    )

    // Hydrate at version 0 → the buffered v1 change is applied.
    await act(async () => {
      resolveList({ items: [], version: 0 })
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-1")
    })
  })

  it("mirrors the focused tab from a remote snapshot", async () => {
    // Seed real tabs so no recovery draft is synthesized on empty hydration — an
    // active draft would legitimately hold focus (see "does not steal focus from
    // an in-progress local draft"), which would mask the focus-mirror behavior
    // this test isolates.
    listOpenedTabsMock.mockResolvedValue({
      items: [tabItem(1, 1, true), tabItem(1, 2)],
      version: 0,
    })
    await renderHydrated()
    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-1")

    act(() => {
      tabsChangedHandler?.({
        version: 1,
        origin: "x",
        tabs: [tabItem(1, 1), tabItem(1, 2, true)],
      })
    })

    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-2")
    // Focus is mirrored: the remote's active tab (c2) becomes ours.
    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-2")
  })

  it("does not steal focus from an in-progress local draft", async () => {
    await renderHydrated()

    act(() => {
      latestContext?.openNewConversationTab(1, "/repo")
    })
    const draftId = latestContext?.activeTabId
    expect(draftId).toMatch(/^new-/)

    // Remote focuses a conversation tab — but we're typing in a draft, so the
    // draft stays focused (its unsent input must not be yanked away).
    act(() => {
      tabsChangedHandler?.({
        version: 1,
        origin: "x",
        tabs: [tabItem(1, 1, true)],
      })
    })

    const tabsText = screen.getByTestId("tabs").textContent ?? ""
    expect(tabsText).toContain("conv-1-codex-1")
    expect(tabsText).toContain(draftId ?? "")
    expect(screen.getByTestId("active")).toHaveTextContent(draftId ?? "")
  })

  it("saves the focused tab so focus syncs across clients", async () => {
    listOpenedTabsMock.mockResolvedValue({
      items: [tabItem(1, 1, true), tabItem(1, 2)],
      version: 1,
    })
    await renderHydrated()
    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-1")
    saveOpenedTabsMock.mockClear()

    act(() => {
      latestContext?.switchTab("conv-1-codex-2")
    })

    // The debounced save fires with the new focus reflected in `is_active`.
    await waitFor(() => expect(saveOpenedTabsMock).toHaveBeenCalled(), {
      timeout: 2000,
    })
    const calls = saveOpenedTabsMock.mock.calls
    const items = calls[calls.length - 1][0] as OpenedTab[]
    const active = items.find((it) => it.is_active)
    expect(active?.conversation_id).toBe(2)
  })

  it("restores the focused tab from is_active on hydrate", async () => {
    listOpenedTabsMock.mockResolvedValue({
      items: [tabItem(1, 1), tabItem(1, 2, true)],
      version: 3,
    })
    await renderHydrated()

    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-2")
  })

  it("cancels a pending local save when a remote snapshot supersedes it", async () => {
    listOpenedTabsMock.mockResolvedValue({
      items: [tabItem(1, 1, true), tabItem(1, 2)],
      version: 1,
    })
    await renderHydrated()
    saveOpenedTabsMock.mockClear()

    // Arm a debounced save by switching focus...
    act(() => {
      latestContext?.switchTab("conv-1-codex-2")
    })
    // ...then a newer remote snapshot lands before the 500ms timer fires.
    act(() => {
      tabsChangedHandler?.({ version: 2, origin: "x", tabs: [tabItem(1, 1)] })
    })

    // The superseded save must never fire (its timer is cleared on apply), so a
    // now-stale payload can't save with the bumped version and clobber truth.
    await new Promise((r) => setTimeout(r, 600))
    expect(saveOpenedTabsMock).not.toHaveBeenCalled()
  })

  it("cancels an armed save when the set reverts to the last-saved state", async () => {
    listOpenedTabsMock.mockResolvedValue({
      items: [tabItem(1, 1, true)],
      version: 1,
    })
    await renderHydrated()
    saveOpenedTabsMock.mockClear()

    // Open c2 (arms a debounced save for [c1,c2]) then close it before 500ms —
    // the set reverts to the already-saved [c1], so the armed save (which would
    // persist & broadcast the closed c2) must be cancelled, not just skipped.
    act(() => {
      latestContext?.openTab(1, 2, "codex", true, "Second")
    })
    act(() => {
      latestContext?.closeTab("conv-1-codex-2")
    })

    await new Promise((r) => setTimeout(r, 600))
    expect(saveOpenedTabsMock).not.toHaveBeenCalled()
  })

  it("re-saves to reconcile when the set reverts while a save is in flight", async () => {
    listOpenedTabsMock.mockResolvedValue({
      items: [tabItem(1, 1, true)],
      version: 1,
    })
    // Control save resolution so we can revert mid-flight.
    let resolveSave: (r: SaveTabsOutcome) => void = () => {}
    saveOpenedTabsMock.mockImplementation(
      () =>
        new Promise<SaveTabsOutcome>((res) => {
          resolveSave = res
        })
    )
    await renderHydrated()

    // Open c2 → arm a save; let the 500ms debounce fire (now in flight).
    act(() => {
      latestContext?.openTab(1, 2, "codex", true, "Second")
    })
    await waitFor(() => expect(saveOpenedTabsMock).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    })
    expect(
      (saveOpenedTabsMock.mock.calls[0][0] as OpenedTab[]).map(
        (i) => i.conversation_id
      )
    ).toEqual([1, 2])

    // Revert (close c2) BEFORE the in-flight save resolves.
    act(() => {
      latestContext?.closeTab("conv-1-codex-2")
    })
    // The in-flight save resolves accepted — it persisted the obsolete [c1,c2].
    await act(async () => {
      resolveSave({ accepted: true, version: 2, tabs: [] })
      await Promise.resolve()
    })

    // Divergence must self-heal: a second save persists the reverted [c1].
    await waitFor(() => expect(saveOpenedTabsMock).toHaveBeenCalledTimes(2), {
      timeout: 2000,
    })
    expect(
      (saveOpenedTabsMock.mock.calls[1][0] as OpenedTab[]).map(
        (i) => i.conversation_id
      )
    ).toEqual([1])
  })

  it("does not regress the version when an accepted save resolves after a newer remote", async () => {
    listOpenedTabsMock.mockResolvedValue({
      items: [tabItem(1, 1, true)],
      version: 1,
    })
    let resolveSave: (r: SaveTabsOutcome) => void = () => {}
    saveOpenedTabsMock.mockImplementation(
      () =>
        new Promise<SaveTabsOutcome>((res) => {
          resolveSave = res
        })
    )
    await renderHydrated()

    // Arm + fire a save (in flight, based on v1).
    act(() => {
      latestContext?.openTab(1, 2, "codex", true, "Second")
    })
    await waitFor(() => expect(saveOpenedTabsMock).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    })

    // A newer remote snapshot (v5) is applied while the save is in flight.
    act(() => {
      tabsChangedHandler?.({
        version: 5,
        origin: "x",
        tabs: [tabItem(1, 1), tabItem(1, 3)],
      })
    })
    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-3")

    // The stale save resolves accepted at the older v2.
    await act(async () => {
      resolveSave({ accepted: true, version: 2, tabs: [] })
      await Promise.resolve()
    })

    // The version must not have regressed to 2 — a remote at v3 is still dropped.
    act(() => {
      tabsChangedHandler?.({ version: 3, origin: "x", tabs: [tabItem(1, 9)] })
    })
    expect(screen.getByTestId("tabs").textContent).not.toContain(
      "conv-1-codex-9"
    )
  })

  it("ignores a rejected save's stale snapshot when a newer remote already applied", async () => {
    listOpenedTabsMock.mockResolvedValue({
      items: [tabItem(1, 1, true)],
      version: 1,
    })
    let resolveSave: (r: SaveTabsOutcome) => void = () => {}
    saveOpenedTabsMock.mockImplementation(
      () =>
        new Promise<SaveTabsOutcome>((res) => {
          resolveSave = res
        })
    )
    await renderHydrated()

    // Arm + fire a save (in flight, based on v1).
    act(() => {
      latestContext?.openTab(1, 2, "codex", true, "Second")
    })
    await waitFor(() => expect(saveOpenedTabsMock).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    })

    // A newer remote snapshot (v5) is applied while the save is in flight.
    act(() => {
      tabsChangedHandler?.({
        version: 5,
        origin: "x",
        tabs: [tabItem(1, 1), tabItem(1, 3)],
      })
    })
    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-3")

    // The save is REJECTED carrying the server's older v2 snapshot, which holds
    // a tab (c8) that the applied v5 truth no longer has.
    await act(async () => {
      resolveSave({
        accepted: false,
        version: 2,
        tabs: [tabItem(1, 1), tabItem(1, 8)],
      })
      await Promise.resolve()
    })

    // The stale v2 reconciliation must NOT clobber the applied v5 state nor
    // regress the version: c3 stays, c8 never appears, and a later remote at v3
    // is still dropped (version stayed at 5).
    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-3")
    expect(screen.getByTestId("tabs").textContent).not.toContain(
      "conv-1-codex-8"
    )
    // c2 was opened here and never acknowledged by any snapshot, so the v5 apply
    // merged it rather than dropping it (see the bound-draft regression below).
    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-2")
    act(() => {
      tabsChangedHandler?.({ version: 3, origin: "x", tabs: [tabItem(1, 9)] })
    })
    expect(screen.getByTestId("tabs").textContent).not.toContain(
      "conv-1-codex-9"
    )
  })

  it("merges the server snapshot when a save is rejected with no newer remote already applied", async () => {
    // Regression: the reject path must reconcile even at the SAME version it
    // just advanced to. A save based on v1 is rejected with the server's
    // authoritative v2 set, and NO intervening remote has landed — so the
    // server's side of the divergence must land (c9 opened elsewhere appears,
    // c1 closed elsewhere disappears) rather than being left stale, while the
    // tab this client opened since v1 survives the merge.
    listOpenedTabsMock.mockResolvedValue({
      items: [tabItem(1, 1, true)],
      version: 1,
    })
    let resolveSave: (r: SaveTabsOutcome) => void = () => {}
    saveOpenedTabsMock.mockImplementation(
      () =>
        new Promise<SaveTabsOutcome>((res) => {
          resolveSave = res
        })
    )
    await renderHydrated()

    // Arm + fire a save (in flight, based on v1).
    act(() => {
      latestContext?.openTab(1, 2, "codex", true, "Second")
    })
    await waitFor(() => expect(saveOpenedTabsMock).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    })

    // Server rejects it (another client committed first), returning the
    // authoritative v2 set = just conversation 9. No remote snapshot was applied
    // in between, so `version` only advances via this rejection.
    await act(async () => {
      resolveSave({
        accepted: false,
        version: 2,
        tabs: [tabItem(1, 9, true)],
      })
      await Promise.resolve()
    })

    // The server's side of the divergence is adopted — c9 lands, c1 (which the
    // server had at v1 and has since dropped) goes — and the local addition c2
    // rides through, since no snapshot has ever contained it.
    const tabsText = screen.getByTestId("tabs").textContent ?? ""
    expect(tabsText).toContain("conv-1-codex-9")
    expect(tabsText).toContain("conv-1-codex-2")
    expect(tabsText).not.toContain("conv-1-codex-1")
  })

  it("keeps a locally-closed tab closed when the rejected snapshot still has it", async () => {
    // Mirror image of the merge: the server's set is not newer truth about the
    // tabs THIS client has already acted on. A close that hasn't been persisted
    // yet must not be undone by the snapshot that races it, or the tab
    // resurrects and the user has to close it twice.
    listOpenedTabsMock.mockResolvedValue({
      items: [tabItem(1, 1, true), tabItem(1, 2)],
      version: 1,
    })
    let resolveSave: (r: SaveTabsOutcome) => void = () => {}
    saveOpenedTabsMock.mockImplementation(
      () =>
        new Promise<SaveTabsOutcome>((res) => {
          resolveSave = res
        })
    )
    await renderHydrated()
    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-2")

    act(() => {
      latestContext?.closeTab("conv-1-codex-2")
    })
    await waitFor(() => expect(saveOpenedTabsMock).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    })

    // Rejected: the server (bumped by an unrelated change) still lists c2.
    await act(async () => {
      resolveSave({
        accepted: false,
        version: 2,
        tabs: [tabItem(1, 1, true), tabItem(1, 2)],
      })
      await Promise.resolve()
    })

    expect(screen.getByTestId("tabs").textContent).not.toContain(
      "conv-1-codex-2"
    )
    // …and the close is re-pushed at the version we just learned.
    await waitFor(() => expect(saveOpenedTabsMock).toHaveBeenCalledTimes(2), {
      timeout: 2000,
    })
    expect(saveOpenedTabsMock.mock.calls[1][1]).toBe(2)
    expect(saveOpenedTabsMock.mock.calls[1][0]).toEqual([
      expect.objectContaining({ conversation_id: 1 }),
    ])
  })

  it("preserves a bound draft's local id and runtime session across a remote apply", async () => {
    await renderHydrated()

    act(() => {
      latestContext?.openNewConversationTab(1, "/repo")
    })
    const draftId = latestContext?.activeTabId
    expect(draftId).toMatch(/^new-/)

    // The draft binds to a real conversation but keeps its `new-*` id + runtime.
    act(() => {
      latestContext?.bindConversationTab(draftId!, 1, "codex", "First", -7)
    })

    // A remote snapshot now includes that conversation.
    act(() => {
      tabsChangedHandler?.({ version: 1, origin: "x", tabs: [tabItem(1, 1)] })
    })

    // The tab keeps its original id (no remount under conv-1-codex-1) and its
    // live runtime session id survives — the in-progress conversation isn't lost.
    const tabsText = screen.getByTestId("tabs").textContent ?? ""
    expect(tabsText).toContain(draftId ?? "")
    expect(tabsText).not.toContain("conv-1-codex-1")
    const bound = latestContext?.tabs.find((tb) => tb.id === draftId)
    expect(bound?.runtimeConversationId).toBe(-7)
  })

  it("keeps a draft just bound to a live conversation when its save is rejected", async () => {
    // Regression (reported): the ONLY tab is a draft; the user sends its first
    // prompt, which creates the row and binds the tab. Meanwhile the server's
    // tab version had silently advanced (a background invalidation bumps the
    // barrier without broadcasting when it removes no row), so this client's
    // save is rejected and handed a server set that has never seen the new
    // conversation. Adopting that set wholesale dropped the running
    // conversation's tab and — with nothing left — synthesized a blank draft:
    // the user watched the workspace jump back to "new conversation" while
    // their prompt kept streaming, visible only in the sidebar.
    listOpenedTabsMock.mockResolvedValue({ items: [], version: 3 })
    saveOpenedTabsMock.mockResolvedValue({
      accepted: false,
      version: 4,
      tabs: [],
    })
    await renderHydrated()

    act(() => {
      latestContext?.openNewConversationTab(1, "/repo")
    })
    const draftId = latestContext?.activeTabId ?? ""
    expect(draftId).toMatch(/^new-/)

    act(() => {
      latestContext?.bindConversationTab(draftId, 7, "codex", "Sent", -1)
    })

    // Let the debounced save fire and be rejected.
    await waitFor(() => expect(saveOpenedTabsMock).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    })
    await act(async () => {
      await Promise.resolve()
    })

    // The bound tab is a local addition the server has never acknowledged, so
    // the rejection must merge (keep it), not clobber.
    expect(screen.getByTestId("tabs")).toHaveTextContent(draftId)
    expect(latestContext?.tabs).toHaveLength(1)
    expect(screen.getByTestId("active")).toHaveTextContent(draftId)
    expect(latestContext?.tabs[0]?.conversationId).toBe(7)

    // …and it must be re-saved against the version we just learned, so the row
    // actually lands on the server instead of living on only in this client.
    await waitFor(() => expect(saveOpenedTabsMock).toHaveBeenCalledTimes(2), {
      timeout: 2000,
    })
    expect(saveOpenedTabsMock.mock.calls[1][1]).toBe(4)
    expect(saveOpenedTabsMock.mock.calls[1][0]).toEqual([
      expect.objectContaining({ conversation_id: 7, folder_id: 1 }),
    ])
  })

  it("reconciles a change missed before the subscription went live", async () => {
    // Hydrate sees v1; a change committed before the server-side receiver was
    // live bumped the server to v2 — the post-subscribe refetch must catch it.
    listOpenedTabsMock
      .mockResolvedValueOnce({ items: [], version: 1 })
      .mockResolvedValueOnce({ items: [tabItem(1, 1)], version: 2 })
    await renderHydrated()

    await waitFor(() => {
      expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-1")
    })
  })
})

describe("TabProvider post-hydration recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedWorkspaceStore()
    // Draft-only sessions persist nothing, so a fresh launch hydrates empty.
    listOpenedTabsMock.mockResolvedValue({ items: [], version: 0 })
    saveOpenedTabsMock.mockResolvedValue({
      accepted: true,
      version: 1,
      tabs: [],
    })
    disconnectMock.mockResolvedValue(undefined)
    loadLastActiveContextMock.mockReturnValue(null)
    tabsChangedHandler = null
    subscribeMock.mockImplementation(
      (event: string, handler: (change: TabsChanged) => void) => {
        if (event === TABS_CHANGED_EVENT) tabsChangedHandler = handler
        return Promise.resolve(() => {})
      }
    )
    onTransportReconnectMock.mockReturnValue(() => {})
  })

  async function renderHydrated() {
    renderTabs()
    await act(async () => {})
  }

  function activeTab() {
    return latestContext?.tabs.find((t) => t.id === latestContext?.activeTabId)
  }

  it("restores a draft on the hinted folder when it still exists", async () => {
    loadLastActiveContextMock.mockReturnValue({
      folderId: 2,
      isChat: false,
    })
    await renderHydrated()
    await waitFor(() =>
      expect(screen.getByTestId("active-folder")).toHaveTextContent("2")
    )
    expect(activeTab()?.id).toMatch(/^new-/)
    expect(activeTab()?.conversationId).toBeNull()
  })

  it("falls back to the first folder when the hinted folder is gone", async () => {
    loadLastActiveContextMock.mockReturnValue({
      folderId: 999,
      isChat: false,
    })
    await renderHydrated()
    await waitFor(() =>
      expect(screen.getByTestId("active-folder")).toHaveTextContent("1")
    )
    expect(activeTab()?.conversationId).toBeNull()
  })

  it("restores chat mode when the hint is a chat draft", async () => {
    loadLastActiveContextMock.mockReturnValue({
      folderId: 0,
      isChat: true,
    })
    await renderHydrated()
    await waitFor(() =>
      expect(screen.getByTestId("active")).not.toHaveTextContent("none")
    )
    expect(activeTab()?.isChat).toBe(true)
    expect(activeTab()?.folderId).toBe(0)
    expect(activeTab()?.conversationId).toBeNull()
  })

  it("synthesizes a first-folder draft when there is no hint", async () => {
    await renderHydrated()
    await waitFor(() =>
      expect(screen.getByTestId("active-folder")).toHaveTextContent("1")
    )
    expect(activeTab()?.id).toMatch(/^new-/)
    expect(activeTab()?.conversationId).toBeNull()
  })

  it("synthesizes a chat draft when there are no folders (never blank)", async () => {
    act(() => {
      useAppWorkspaceStore.setState({ folders: [], allFolders: [] })
    })
    await renderHydrated()
    await waitFor(() =>
      expect(screen.getByTestId("active")).not.toHaveTextContent("none")
    )
    // An active tab exists → the panel is not blank and the sidebar is enabled.
    expect(screen.getByTestId("tabs").textContent ?? "").toMatch(/^new-/)
    expect(activeTab()?.isChat).toBe(true)
  })

  it("recovers only once — a later remote snapshot adds no second draft", async () => {
    await renderHydrated()
    await waitFor(() =>
      expect(screen.getByTestId("active")).not.toHaveTextContent("none")
    )
    const draftId = latestContext?.activeTabId
    act(() => {
      tabsChangedHandler?.({ version: 1, origin: "x", tabs: [tabItem(1, 1)] })
    })
    const drafts =
      latestContext?.tabs.filter((t) => t.conversationId == null) ?? []
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.id).toBe(draftId)
  })

  it("persists the active draft's context for the next launch", async () => {
    await renderHydrated()
    await waitFor(() =>
      expect(saveLastActiveContextMock).toHaveBeenCalledWith(
        expect.objectContaining({ folderId: 1, isChat: false })
      )
    )
  })

  it("clears the hint once a real conversation is focused", async () => {
    await renderHydrated()
    await waitFor(() => expect(saveLastActiveContextMock).toHaveBeenCalled())
    clearLastActiveContextMock.mockClear()
    act(() => {
      latestContext?.openTab(1, 1, "codex", true, "First")
      latestContext?.switchTab("conv-1-codex-1")
    })
    await waitFor(() => expect(clearLastActiveContextMock).toHaveBeenCalled())
  })

  it("does not recover when persisted tabs hydrate non-empty", async () => {
    listOpenedTabsMock.mockResolvedValue({
      items: [tabItem(1, 1, true)],
      version: 1,
    })
    loadLastActiveContextMock.mockReturnValue({
      folderId: 2,
      isChat: false,
    })
    await renderHydrated()
    await waitFor(() =>
      expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-1")
    )
    const drafts =
      latestContext?.tabs.filter((t) => t.conversationId == null) ?? []
    expect(drafts).toHaveLength(0)
    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-1")
  })
})

describe("TabProvider sub-session tabs", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedWorkspaceStore()
    // No hydration noise — open the sub-session tab imperatively instead.
    listOpenedTabsMock.mockReturnValue(new Promise(() => {}))
    saveOpenedTabsMock.mockResolvedValue({
      accepted: true,
      version: 1,
      tabs: [],
    })
    // mockReset (not just clearAllMocks) also drains any leftover
    // mockReturnValueOnce queue from a prior test so it can't leak a stale
    // (e.g. never-resolving) promise into the next test's first fetch.
    getFolderConversationMock.mockReset()
    getFolderConversationMock.mockReturnValue(new Promise(() => {}))
    tabsChangedHandler = null
    conversationChangedHandler = null
    subscribeMock.mockImplementation((event: string, handler: unknown) => {
      if (event === TABS_CHANGED_EVENT)
        tabsChangedHandler = handler as (change: TabsChanged) => void
      if (event === CONVERSATION_CHANGED_EVENT)
        conversationChangedHandler = handler as (
          change: ConversationChange
        ) => void
      return Promise.resolve(() => {})
    })
    onTransportReconnectMock.mockReturnValue(() => {})
  })

  function subSummary(
    overrides: Partial<DbConversationSummary> = {}
  ): DbConversationSummary {
    return {
      id: 99,
      folder_id: 1,
      title: "Review the auth module",
      title_locked: false,
      agent_type: "codex",
      status: "in_progress",
      kind: "delegate",
      model: null,
      git_branch: null,
      external_id: null,
      message_count: 0,
      child_count: 0,
      created_at: "2026-05-24T00:00:00Z",
      updated_at: "2026-05-24T00:00:00Z",
      pinned_at: null,
      parent_id: 1,
      ...overrides,
    }
  }

  it("resolves an open sub-session tab's title + status from a fetched summary, then keeps the status dot live", async () => {
    // Sub-session id 99 is absent from the root conversations list (1,2,3), so a
    // tab for it can ONLY get its title/status from the seed fetch + the live
    // conversation channel — the exact gap this fix closes.
    getFolderConversationMock.mockResolvedValue({
      summary: subSummary(),
      turns: [],
      session_stats: null,
    })
    renderTabs()
    await act(async () => {}) // flush mount: subscribe() captures the handler
    // Open WITHOUT a seed title — mirrors handleSelect opening a sidebar child.
    act(() => {
      latestContext?.openTab(1, 99, "codex", true)
    })
    const subTab = () =>
      latestContext?.tabs.find((tab) => tab.conversationId === 99)
    // Before the fetch resolves the tab can't resolve a title (root-only map).
    expect(subTab()?.title).toBe("untitledConversation")
    // Flush the seed fetch → title + status fill in from the fetched summary.
    await act(async () => {})
    expect(subTab()?.title).toBe("Review the auth module")
    expect(subTab()?.status).toBe("in_progress")
    // A live status event for the running sub-agent flips the tab's status dot.
    act(() => {
      conversationChangedHandler?.({
        kind: "status",
        id: 99,
        status: "completed",
      })
    })
    expect(subTab()?.status).toBe("completed")
  })

  it("does not fetch a summary for a root conversation tab (resolved from the list)", async () => {
    // Id 1 IS a root in the conversations list, so the tab resolves from there
    // and the sub-session seed fetch must never fire for it.
    renderTabs()
    await act(async () => {})
    act(() => {
      latestContext?.openTab(1, 1, "codex", true)
    })
    await act(async () => {})
    expect(getFolderConversationMock).not.toHaveBeenCalled()
    expect(
      latestContext?.tabs.find((tab) => tab.conversationId === 1)?.title
    ).toBe("First")
  })

  it("applies a status event that arrives while the seed fetch is still in flight (no lost event)", async () => {
    // Hold the seed fetch open so an event can land mid-flight.
    let resolveFetch: (detail: unknown) => void = () => {}
    getFolderConversationMock.mockReturnValue(
      new Promise((res) => {
        resolveFetch = res
      })
    )
    renderTabs()
    await act(async () => {}) // capture the conversation://changed handler
    act(() => {
      latestContext?.openTab(1, 99, "codex", true)
    })
    await act(async () => {}) // reconcile effect → seed fetch in flight
    // An event lands before the seed resolves — it must be buffered, then win
    // over the (older) fetched status when the seed commits.
    act(() => {
      conversationChangedHandler?.({
        kind: "status",
        id: 99,
        status: "completed",
      })
    })
    await act(async () => {
      resolveFetch({
        summary: subSummary({ status: "in_progress" }),
        turns: [],
        session_stats: null,
      })
    })
    const subTab = latestContext?.tabs.find((tab) => tab.conversationId === 99)
    expect(subTab?.title).toBe("Review the auth module")
    expect(subTab?.status).toBe("completed") // buffered event won over the fetch
  })

  it("merges an upsert then a status that both land during the seed window (upsert title + later status)", async () => {
    let resolveFetch: (detail: unknown) => void = () => {}
    getFolderConversationMock.mockReturnValue(
      new Promise((res) => {
        resolveFetch = res
      })
    )
    renderTabs()
    await act(async () => {})
    act(() => {
      latestContext?.openTab(1, 99, "codex", true)
    })
    await act(async () => {}) // seed in flight
    // Two events during the fetch: a full upsert (new title) THEN a status. The
    // status must not clobber the upsert's title — both must survive.
    act(() => {
      conversationChangedHandler?.({
        kind: "upsert",
        summary: subSummary({ title: "Renamed by AI", status: "in_progress" }),
      })
      conversationChangedHandler?.({
        kind: "status",
        id: 99,
        status: "completed",
      })
    })
    // The fetched snapshot carries the OLD title; the merge must prefer the
    // upsert's summary and the later status.
    await act(async () => {
      resolveFetch({
        summary: subSummary({ title: "OLD", status: "pending" }),
        turns: [],
        session_stats: null,
      })
    })
    const subTab = latestContext?.tabs.find((tab) => tab.conversationId === 99)
    expect(subTab?.title).toBe("Renamed by AI") // upsert summary won over the fetch
    expect(subTab?.status).toBe("completed") // later status patched on top
  })

  it("keeps a delete terminal across a late status during the seed window (no resurrection)", async () => {
    let resolveFetch: (detail: unknown) => void = () => {}
    getFolderConversationMock.mockReturnValue(
      new Promise((res) => {
        resolveFetch = res
      })
    )
    renderTabs()
    await act(async () => {})
    act(() => {
      latestContext?.openTab(1, 99, "codex", true)
    })
    await act(async () => {}) // seed in flight
    act(() => {
      conversationChangedHandler?.({ kind: "deleted", id: 99 })
      conversationChangedHandler?.({
        kind: "status",
        id: 99,
        status: "completed",
      })
    })
    await act(async () => {
      resolveFetch({
        summary: subSummary(),
        turns: [],
        session_stats: null,
      })
    })
    // A child deleted mid-fetch must not be committed by the seed despite a later
    // status — the tab stays unresolved ("Untitled"), with no status.
    const subTab = latestContext?.tabs.find((tab) => tab.conversationId === 99)
    expect(subTab?.title).toBe("untitledConversation")
    expect(subTab?.status).toBeUndefined()
  })

  it("seeds an open child tab even when the (loaded) root list is empty", async () => {
    // Loaded-but-empty root list: the seed must still fire (gated on loading, not
    // on conversationMap.size, which an old `size === 0` guard would skip).
    act(() => {
      useAppWorkspaceStore.setState({
        conversations: [],
        conversationsLoading: false,
      })
    })
    getFolderConversationMock.mockResolvedValue({
      summary: subSummary(),
      turns: [],
      session_stats: null,
    })
    renderTabs()
    await act(async () => {})
    act(() => {
      latestContext?.openTab(1, 99, "codex", true)
    })
    await act(async () => {})
    expect(getFolderConversationMock).toHaveBeenCalledWith(99)
    expect(
      latestContext?.tabs.find((tab) => tab.conversationId === 99)?.title
    ).toBe("Review the auth module")
  })

  it("does not seed while the root list is still loading", async () => {
    act(() => {
      useAppWorkspaceStore.setState({ conversationsLoading: true })
    })
    renderTabs()
    await act(async () => {})
    act(() => {
      latestContext?.openTab(1, 99, "codex", true)
    })
    await act(async () => {})
    expect(getFolderConversationMock).not.toHaveBeenCalled()
  })

  it("discards a stale in-flight seed on reconnect and reseeds the open child tab", async () => {
    // TabProvider registers MORE THAN ONE reconnect handler (tab resync + this
    // sub-session cache), so capture them all and fire all to exercise ours.
    const reconnectCbs: Array<() => void> = []
    onTransportReconnectMock.mockImplementation((cb: () => void) => {
      reconnectCbs.push(cb)
      return () => {}
    })
    let resolveStale: (detail: unknown) => void = () => {}
    let resolveFresh: (detail: unknown) => void = () => {}
    getFolderConversationMock
      .mockReturnValueOnce(
        new Promise((res) => {
          resolveStale = res
        })
      )
      .mockReturnValueOnce(
        new Promise((res) => {
          resolveFresh = res
        })
      )
    renderTabs()
    await act(async () => {})
    act(() => {
      latestContext?.openTab(1, 99, "codex", true)
    })
    await act(async () => {}) // seed #1 in flight
    act(() => {
      reconnectCbs.forEach((cb) => cb())
    })
    await act(async () => {}) // reconcile reruns under a new epoch → seed #2 in flight
    // The pre-reconnect (stale) response must be ignored…
    await act(async () => {
      resolveStale({
        summary: subSummary({ title: "STALE" }),
        turns: [],
        session_stats: null,
      })
    })
    expect(
      latestContext?.tabs.find((tab) => tab.conversationId === 99)?.title
    ).toBe("untitledConversation")
    // …and the fresh reseed response applied.
    await act(async () => {
      resolveFresh({
        summary: subSummary({ title: "FRESH" }),
        turns: [],
        session_stats: null,
      })
    })
    expect(
      latestContext?.tabs.find((tab) => tab.conversationId === 99)?.title
    ).toBe("FRESH")
    expect(getFolderConversationMock).toHaveBeenCalledTimes(2)
  })

  it("prunes a child tab's cached summary when the tab closes (so a reopen refetches)", async () => {
    getFolderConversationMock.mockResolvedValue({
      summary: subSummary(),
      turns: [],
      session_stats: null,
    })
    renderTabs()
    await act(async () => {})
    act(() => {
      latestContext?.openTab(1, 99, "codex", true)
    })
    await act(async () => {})
    expect(getFolderConversationMock).toHaveBeenCalledTimes(1)
    const tabId = latestContext?.tabs.find(
      (tab) => tab.conversationId === 99
    )?.id
    act(() => {
      latestContext?.closeTab(tabId!)
    })
    await act(async () => {})
    // Reopen → a pruned cache forces a fresh fetch (a leaked entry would not).
    act(() => {
      latestContext?.openTab(1, 99, "codex", true)
    })
    await act(async () => {})
    expect(getFolderConversationMock).toHaveBeenCalledTimes(2)
  })
})

describe("TabProvider tab groups", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedWorkspaceStore()
    listOpenedTabsMock.mockResolvedValue({ items: [], version: 1 })
    saveOpenedTabsMock.mockResolvedValue({
      accepted: true,
      version: 2,
      tabs: [],
    })
    getFolderConversationMock.mockReset()
    getFolderConversationMock.mockReturnValue(new Promise(() => {}))
    tabsChangedHandler = null
    conversationChangedHandler = null
    subscribeMock.mockImplementation((event: string, handler: unknown) => {
      if (event === TABS_CHANGED_EVENT)
        tabsChangedHandler = handler as (change: TabsChanged) => void
      if (event === CONVERSATION_CHANGED_EVENT)
        conversationChangedHandler = handler as (
          change: ConversationChange
        ) => void
      return Promise.resolve(() => {})
    })
    disconnectMock.mockResolvedValue(undefined)
    onTransportReconnectMock.mockReturnValue(() => {})
  })

  /** Hydrate from an explicit snapshot so the post-hydration recovery never
   *  synthesizes a draft tab under the tests' feet. */
  async function renderWithTabs(items: OpenedTab[]) {
    listOpenedTabsMock.mockResolvedValue({ items, version: 1 })
    const result = renderTabs()
    await act(async () => {})
    return result
  }

  const store = () => useTabStore.getState()
  const leaves = () => leafIds(store().groupLayout)
  const groupOfId = (tabId: string) =>
    groupOfTab(store().groupOf, store().groupLayout, tabId)
  /** The leaf that is NOT in `known` — the group a split just created. */
  const newLeafBeside = (...known: string[]) => {
    const other = leaves().filter((id) => !known.includes(id))
    expect(other).toHaveLength(1)
    return other[0]
  }

  it("split-and-move creates a second group with the tab and focuses it", async () => {
    await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2)])
    const home = leaves()[0]

    act(() => {
      store().splitTab("conv-1-codex-2", "right", { move: true })
    })

    expect(selectIsSplit(store())).toBe(true)
    expect(leaves()).toHaveLength(2)
    const g1 = newLeafBeside(home)
    expect(groupOfId("conv-1-codex-1")).toBe(home)
    expect(groupOfId("conv-1-codex-2")).toBe(g1)
    expect(store().activeTabId).toBe("conv-1-codex-2")
    expect(store().groupSelection[home]).toBe("conv-1-codex-1")
    expect(store().groupSelection[g1]).toBe("conv-1-codex-2")
  })

  it("split-and-move is a no-op when the tab is alone in its group", async () => {
    await renderWithTabs([tabItem(1, 1, true)])

    act(() => {
      store().splitTab("conv-1-codex-1", "right", { move: true })
    })

    expect(selectIsSplit(store())).toBe(false)
    expect(leaves()).toHaveLength(1)
  })

  it("plain split seeds the new group with a draft inheriting the context tab", async () => {
    await renderWithTabs([tabItem(1, 1, true)])
    const home = leaves()[0]

    act(() => {
      store().splitTab("conv-1-codex-1", "down", { move: false })
    })

    expect(leaves()).toHaveLength(2)
    const g1 = newLeafBeside(home)
    const draft = store().rawTabs.find((t) => t.conversationId == null)
    expect(draft).toBeDefined()
    expect(draft?.folderId).toBe(1)
    expect(draft?.agentType).toBe("codex")
    expect(draft?.workingDir).toBe("/repo")
    expect(groupOfId(draft!.id)).toBe(g1)
    expect(store().activeTabId).toBe(draft!.id)
    expect(groupOfId("conv-1-codex-1")).toBe(home)
    const layout = store().groupLayout
    expect(layout.type === "split" && layout.orientation).toBe("vertical")
  })

  it("plain split from a chat draft seeds a chat draft (one draft per group)", async () => {
    await renderWithTabs([tabItem(1, 1, true)])
    act(() => {
      store().openChatModeTab()
    })
    const chatDraftId = store().activeTabId!
    expect(chatDraftId).toMatch(/^new-/)

    act(() => {
      store().splitTab(chatDraftId, "right", { move: false })
    })

    const drafts = store().rawTabs.filter((t) => t.conversationId == null)
    expect(drafts).toHaveLength(2)
    const newDraft = drafts.find((t) => t.id !== chatDraftId)
    expect(newDraft?.isChat).toBe(true)
    expect(newDraft?.folderId).toBe(0)
    expect(groupOfId(newDraft!.id)).not.toBe(groupOfId(chatDraftId))
  })

  it("same-direction splits flatten into siblings; cross-direction splits nest", async () => {
    await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2), tabItem(2, 3)])

    act(() => {
      store().splitTab("conv-1-codex-2", "right", { move: true })
    })
    act(() => {
      store().splitTab("conv-2-codex-3", "right", { move: true })
    })
    // conv-2-codex-3 was still in the home group, and home's parent split is
    // already horizontal — so this second right-split inserts a SIBLING,
    // giving one flat 3-way split rather than nesting.
    const root = store().groupLayout
    expect(root.type).toBe("split")
    if (root.type !== "split") return
    expect(root.orientation).toBe("horizontal")
    expect(root.children).toHaveLength(3)
    expect(root.children.every((c) => c.type === "group")).toBe(true)

    // Splitting downward from inside the row nests a vertical split.
    act(() => {
      store().splitTab("conv-2-codex-3", "down", { move: false })
    })
    const nested = store().groupLayout
    expect(nested.type).toBe("split")
    if (nested.type !== "split") return
    expect(nested.orientation).toBe("horizontal")
    const verticalChild = nested.children.find((c) => c.type === "split")
    expect(verticalChild).toBeDefined()
    expect(verticalChild?.type === "split" && verticalChild.orientation).toBe(
      "vertical"
    )
  })

  it("closing a group's last tab collapses the split and focuses the neighbor's selection", async () => {
    await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2)])

    act(() => {
      store().splitTab("conv-1-codex-2", "right", { move: true })
    })
    expect(selectIsSplit(store())).toBe(true)

    act(() => {
      store().closeTab("conv-1-codex-2")
    })

    expect(selectIsSplit(store())).toBe(false)
    expect(leaves()).toHaveLength(1)
    expect(store().activeTabId).toBe("conv-1-codex-1")
    expect(Object.keys(store().groupOf)).not.toContain("conv-1-codex-2")
  })

  it("moveTabToGroup moves and focuses; draining a group collapses it", async () => {
    await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2)])
    const home = leaves()[0]

    act(() => {
      store().splitTab("conv-1-codex-2", "right", { move: true })
    })
    const g1 = newLeafBeside(home)

    act(() => {
      store().moveTabToGroup("conv-1-codex-1", g1)
    })

    // Home drained → the tree collapses back to a single group (g1).
    expect(selectIsSplit(store())).toBe(false)
    expect(leaves()).toEqual([g1])
    expect(store().activeTabId).toBe("conv-1-codex-1")
    expect(store().groupSelection[g1]).toBe("conv-1-codex-1")
  })

  it("dissolveGroup merges its tabs into the neighbor without reordering rawTabs", async () => {
    await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2)])
    const home = leaves()[0]

    act(() => {
      store().splitTab("conv-1-codex-2", "right", { move: true })
    })
    const g1 = newLeafBeside(home)

    act(() => {
      store().dissolveGroup(g1)
    })

    expect(selectIsSplit(store())).toBe(false)
    expect(store().rawTabs.map((t) => t.id)).toEqual([
      "conv-1-codex-1",
      "conv-1-codex-2",
    ])
    expect(groupOfId("conv-1-codex-2")).toBe(home)
  })

  it("unsplitAll flattens every group and keeps the rawTabs order", async () => {
    await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2), tabItem(2, 3)])

    act(() => {
      store().splitTab("conv-1-codex-2", "right", { move: true })
    })
    act(() => {
      store().splitTab("conv-2-codex-3", "right", { move: true })
    })
    expect(leaves()).toHaveLength(3)

    act(() => {
      store().unsplitAll()
    })

    expect(selectIsSplit(store())).toBe(false)
    expect(store().rawTabs.map((t) => t.id)).toEqual([
      "conv-1-codex-1",
      "conv-1-codex-2",
      "conv-2-codex-3",
    ])
  })

  it("group actions on the already-active tab never dirty the synced payload", async () => {
    await renderWithTabs([tabItem(1, 1), tabItem(1, 2, true)])

    const home = leaves()[0]
    act(() => {
      store().splitTab("conv-1-codex-2", "right", { move: true })
    })
    const g1 = newLeafBeside(home)
    act(() => {
      store().toggleGroupTile(g1)
      store().toggleGroupOrientation(g1)
      store().resizeGroupSplit(store().groupLayout.id, 0, 0.3)
      store().dissolveGroup(g1)
      store().unsplitAll()
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700))
    })
    expect(saveOpenedTabsMock).not.toHaveBeenCalled()
  })

  it("closeOtherTabs while split only closes the group's own siblings", async () => {
    await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2), tabItem(2, 3)])

    act(() => {
      store().splitTab("conv-2-codex-3", "right", { move: true })
    })

    act(() => {
      store().closeOtherTabs("conv-1-codex-1")
    })

    expect(
      store()
        .rawTabs.map((t) => t.id)
        .sort()
    ).toEqual(["conv-1-codex-1", "conv-2-codex-3"])
    expect(selectIsSplit(store())).toBe(true)
    expect(store().activeTabId).toBe("conv-1-codex-1")
  })

  it("reorderGroupTabs permutes only its group's slots in rawTabs", async () => {
    await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2), tabItem(2, 3)])
    const home = leaves()[0]

    act(() => {
      store().splitTab("conv-2-codex-3", "right", { move: true })
    })
    const g1 = newLeafBeside(home)
    act(() => {
      store().moveTabToGroup("conv-1-codex-2", g1)
    })
    expect(store().rawTabs.map((t) => t.id)).toEqual([
      "conv-1-codex-1",
      "conv-1-codex-2",
      "conv-2-codex-3",
    ])

    const g1Tabs = store().tabs.filter((t) => groupOfId(t.id) === g1)
    act(() => {
      store().reorderGroupTabs(g1, [g1Tabs[1], g1Tabs[0]])
    })

    // g1 occupied slots 1 and 2; slot 0 (the other group) is untouched.
    expect(store().rawTabs.map((t) => t.id)).toEqual([
      "conv-1-codex-1",
      "conv-2-codex-3",
      "conv-1-codex-2",
    ])

    // Mismatched ids are refused outright.
    const before = store().rawTabs
    act(() => {
      store().reorderGroupTabs(g1, [g1Tabs[0]])
    })
    expect(store().rawTabs).toBe(before)
  })

  /**
   * The unsplit strip's reorder, which has to take the same care its
   * split-group sibling above already takes.
   *
   * `Reorder.Group` emits the order of the items it has measured since its own
   * last render, filtered by REFERENCE against its current `values`. The filter
   * can only remove, and the tab objects it holds are the ones the strip
   * rendered with — so the list it hands back is a request to MOVE tabs, not a
   * new tab set. Adopting it wholesale closed whichever tab was missing from it
   * and rolled the rest back to whatever the strip last rendered.
   */
  describe("reorderTabs", () => {
    it("keeps a tab the reorder callback left out", async () => {
      await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2), tabItem(1, 3)])
      const rendered = store().tabs

      act(() => {
        store().reorderTabs([rendered[2], rendered[1]])
      })

      // The omitted tab is still open — and still the one being looked at.
      expect(store().rawTabs.map((t) => t.id)).toContain("conv-1-codex-1")
      expect(store().activeTabId).toBe("conv-1-codex-1")
      expect(store().rawTabs).toHaveLength(3)
    })

    it("does not roll a tab back to what the strip rendered with", async () => {
      await renderWithTabs([tabItem(1, 1, true)])
      act(() => {
        store().openNewConversationTab(1, "/repo")
      })
      const draftId = store().rawTabs.find((t) => t.conversationId == null)!.id
      // What the strip was holding when the drag began.
      const rendered = store().tabs

      // The draft's first message lands mid-drag: it binds to a real
      // conversation, and its transcript now lives under a virtual runtime id.
      act(() => {
        store().bindConversationTab(draftId, 7, "codex", "sent", -42)
      })
      act(() => {
        store().reorderTabs([rendered[1], rendered[0]])
      })

      expect(store().rawTabs.map((t) => t.id)).toEqual([
        draftId,
        "conv-1-codex-1",
      ])
      const moved = store().rawTabs.find((t) => t.id === draftId)!
      expect(moved.conversationId).toBe(7)
      expect(moved.runtimeConversationId).toBe(-42)
    })

    it("still moves the tab on a complete permutation", async () => {
      await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2), tabItem(1, 3)])
      const rendered = store().tabs

      act(() => {
        store().reorderTabs([rendered[1], rendered[2], rendered[0]])
      })

      expect(store().rawTabs.map((t) => t.id)).toEqual([
        "conv-1-codex-2",
        "conv-1-codex-3",
        "conv-1-codex-1",
      ])
    })

    it("refuses a list that names one tab twice", async () => {
      await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2)])
      const rendered = store().tabs
      const before = store().rawTabs

      act(() => {
        store().reorderTabs([rendered[1], rendered[1]])
      })

      expect(store().rawTabs).toBe(before)
    })
  })

  it("per-group draft singleton: each group reuses its own draft", async () => {
    await renderWithTabs([tabItem(1, 1, true)])
    const home = leaves()[0]

    act(() => {
      store().splitTab("conv-1-codex-1", "right", { move: false })
    })
    const g1 = newLeafBeside(home)
    const draftInG1 = store().rawTabs.find((t) => t.conversationId == null)!

    // Focused group is g1 (the draft) — reuses that draft, no new tab.
    act(() => {
      store().openNewConversationTab(1, "/repo")
    })
    expect(
      store().rawTabs.filter((t) => t.conversationId == null)
    ).toHaveLength(1)
    expect(store().activeTabId).toBe(draftInG1.id)

    // Explicitly targeting the home group creates a second, per-group draft.
    act(() => {
      store().openNewConversationTab(1, "/repo", { targetGroup: home })
    })
    const drafts = store().rawTabs.filter((t) => t.conversationId == null)
    expect(drafts).toHaveLength(2)
    expect(drafts.map((d) => groupOfId(d.id)).sort()).toEqual([home, g1].sort())
  })

  it("persists the split layout and restores it across a restart", async () => {
    const first = await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2)])

    act(() => {
      store().splitTab("conv-1-codex-2", "right", { move: true })
    })
    const movedGroup = groupOfId("conv-1-codex-2")

    const blobRaw = localStorage.getItem("workspace:tab-groups:v1")
    expect(blobRaw).not.toBeNull()
    const blob = JSON.parse(blobRaw!) as {
      assignments: Record<string, string>
      layout: { type: string }
    }
    expect(blob.layout.type).toBe("split")
    expect(blob.assignments["conv-1-codex-2"]).toBe(movedGroup)
    expect(
      Object.keys(blob.assignments).every((key) => !key.startsWith("new-"))
    ).toBe(true)

    // Simulate a restart: fresh store (re-reads localStorage), fresh provider.
    first.unmount()
    act(() => {
      resetTabStore()
    })
    await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2)])

    expect(selectIsSplit(store())).toBe(true)
    expect(groupOfId("conv-1-codex-2")).toBe(movedGroup)
    expect(groupOfId("conv-1-codex-1")).not.toBe(movedGroup)
  })

  // Drafts are device-local (no DB row before the first send), so without the
  // blob carrying them a "conversation | new conversation" split lost the whole
  // right-hand group on restart: no members → normalizeTree collapses it.
  it("restores draft tabs into their own groups, keeping a draft-only group alive", async () => {
    const first = await renderWithTabs([tabItem(1, 1, true)])
    const home = leaves()[0]
    act(() => {
      store().splitTab("conv-1-codex-1", "right", { move: false })
    })
    const g1 = newLeafBeside(home)
    const draft = store().rawTabs.find((t) => t.conversationId == null)!
    expect(groupOfId(draft.id)).toBe(g1)

    const blob = JSON.parse(localStorage.getItem("workspace:tab-groups:v1")!)
    expect(blob.drafts).toHaveLength(1)
    expect(blob.drafts[0]).toMatchObject({ id: draft.id, group: g1 })
    expect(blob.activeDraft).toBe(draft.id)

    first.unmount()
    act(() => {
      resetTabStore()
    })
    await renderWithTabs([tabItem(1, 1, true)])

    expect(selectIsSplit(store())).toBe(true)
    const restoredDraft = store().rawTabs.find((t) => t.conversationId == null)
    expect(restoredDraft?.id).toBe(draft.id)
    expect(restoredDraft?.folderId).toBe(1)
    expect(groupOfId(draft.id)).toBe(g1)
    // Draft focus is device-local state; it comes back with the draft.
    expect(store().activeTabId).toBe(draft.id)
    expect(store().groupSelection[g1]).toBe(draft.id)
  })

  // A transient backend failure must not be mistaken for "the user closed
  // everything": the empty tab set would prune every assignment, collapse the
  // layout, write that ruin over the blob, and sweep every per-tab composer key
  // as orphaned — losing both the remembered layout and unsent text for good.
  it("keeps the saved layout and composer drafts when the tab fetch fails", async () => {
    const first = await renderWithTabs([tabItem(1, 1, true)])
    const home = leaves()[0]
    act(() => {
      store().splitTab("conv-1-codex-1", "right", { move: false })
    })
    const g1 = newLeafBeside(home)
    const draft = store().rawTabs.find((t) => t.conversationId == null)!
    const goodBlob = localStorage.getItem("workspace:tab-groups:v1")!
    // Unsent text in BOTH drafts' composers (per-tab keys).
    saveMessageInputDraftV2(buildNewConversationDraftStorageKey(draft.id), {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "wip" }] },
      ],
    })

    first.unmount()
    act(() => {
      resetTabStore()
    })
    listOpenedTabsMock.mockRejectedValueOnce(new Error("backend down"))
    const second = renderTabs()
    await act(async () => {})
    // Let the idle-scheduled sweep (synchronous in jsdom) have its chance.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    // The on-disk layout is untouched, so the next good launch still restores it.
    expect(localStorage.getItem("workspace:tab-groups:v1")).toBe(goodBlob)
    // The unsent text survives.
    expect(
      loadMessageInputDraftV2(buildNewConversationDraftStorageKey(draft.id))
    ).toMatchObject({ kind: "doc" })
    // The device-local draft is still shown (not a blank workspace), in its group.
    expect(store().rawTabs.some((t) => t.id === draft.id)).toBe(true)
    expect(groupOfId(draft.id)).toBe(g1)
    // Nothing is pushed at the server off the back of a failed read.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700))
    })
    expect(saveOpenedTabsMock).not.toHaveBeenCalled()

    // The refetch that follows the subscription rescues the session: the
    // conversation tab returns and persistence resumes.
    second.unmount()
  })

  // The rescue must go by the snapshot's CONTENTS while the tab set is unknown.
  // `opened_tabs_version` defaults to 0 when the metadata key is missing, so a
  // populated set can arrive as version 0 — losing a `snap.version > version`
  // comparison and leaving the drafts-only state to be pruned and persisted.
  it("adopts the recovery refetch even when its version does not advance", async () => {
    const first = await renderWithTabs([tabItem(1, 1, true)])
    const home = leaves()[0]
    act(() => {
      store().splitTab("conv-1-codex-1", "right", { move: false })
    })
    const g1 = newLeafBeside(home)
    const draft = store().rawTabs.find((t) => t.conversationId == null)!

    first.unmount()
    act(() => {
      resetTabStore()
    })
    // Hydration fails, then the post-subscription refetch answers with the real
    // tabs stamped version 0 (the same value the failed session still holds).
    listOpenedTabsMock.mockRejectedValueOnce(new Error("backend down"))
    listOpenedTabsMock.mockResolvedValue({
      items: [tabItem(1, 1, true)],
      version: 0,
    })
    const second = renderTabs()
    await act(async () => {})
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    // The conversation tab is back alongside the restored draft, each in its
    // own group — the split survived the failed launch.
    expect(store().rawTabs.some((t) => t.id === "conv-1-codex-1")).toBe(true)
    expect(store().rawTabs.some((t) => t.id === draft.id)).toBe(true)
    expect(selectIsSplit(store())).toBe(true)
    expect(groupOfId("conv-1-codex-1")).toBe(home)
    expect(groupOfId(draft.id)).toBe(g1)
    second.unmount()
  })

  it("restores drafts without dirtying the synced payload", async () => {
    const first = await renderWithTabs([tabItem(1, 1, true)])
    act(() => {
      store().splitTab("conv-1-codex-1", "right", { move: false })
    })
    first.unmount()
    act(() => {
      resetTabStore()
    })
    saveOpenedTabsMock.mockClear()

    await renderWithTabs([tabItem(1, 1, true)])
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700))
    })

    // The restore focuses the draft, which means no tab carries is_active. That
    // baseline is seeded at hydrate, so no CAS save (and no cross-client focus
    // broadcast) fires just from launching.
    expect(saveOpenedTabsMock).not.toHaveBeenCalled()
  })

  it("drops a restored draft whose folder is gone and collapses its group", async () => {
    const first = await renderWithTabs([tabItem(1, 1, true)])
    const home = leaves()[0]
    act(() => {
      // Draft on folder 2, moved into its own group.
      store().openNewConversationTab(2, "/other", { targetGroup: home })
    })
    const draft = store().rawTabs.find((t) => t.conversationId == null)!
    act(() => {
      store().splitTab("conv-1-codex-1", "right", { move: true })
    })
    expect(selectIsSplit(store())).toBe(true)

    // Restart with folder 2 deleted while the app was closed.
    first.unmount()
    act(() => {
      resetTabStore()
    })
    useAppWorkspaceStore.setState({
      folders: [defaultFoldersMock[0]],
      allFolders: [defaultFoldersMock[0]],
    })
    await renderWithTabs([tabItem(1, 1, true)])

    expect(store().rawTabs.some((t) => t.id === draft.id)).toBe(false)
    expect(selectIsSplit(store())).toBe(false)
  })

  it("loads a pre-drafts blob (no `drafts` field) unchanged", async () => {
    const first = await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2)])
    act(() => {
      store().splitTab("conv-1-codex-2", "right", { move: true })
    })
    const movedGroup = groupOfId("conv-1-codex-2")
    const blob = JSON.parse(localStorage.getItem("workspace:tab-groups:v1")!)
    delete blob.drafts
    delete blob.activeDraft
    first.unmount()
    localStorage.setItem("workspace:tab-groups:v1", JSON.stringify(blob))
    act(() => {
      resetTabStore()
    })
    await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2)])

    expect(selectIsSplit(store())).toBe(true)
    expect(groupOfId("conv-1-codex-2")).toBe(movedGroup)
    expect(store().rawTabs.some((t) => t.conversationId == null)).toBe(false)
  })

  it("prunes a restored group whose tabs no longer exist after hydration", async () => {
    const first = await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2)])
    act(() => {
      store().splitTab("conv-1-codex-2", "right", { move: true })
    })
    expect(selectIsSplit(store())).toBe(true)

    // Restart, but conv 2 was closed elsewhere — its group must collapse.
    first.unmount()
    act(() => {
      resetTabStore()
    })
    await renderWithTabs([tabItem(1, 1, true)])

    expect(selectIsSplit(store())).toBe(false)
    expect(leaves()).toHaveLength(1)
  })

  it("seeds the first group's tile flag from the legacy tile-mode key", () => {
    localStorage.setItem("workspace:tile-mode", "true")
    act(() => {
      resetTabStore()
    })
    const firstGroup = leaves()[0]
    expect(store().tileByGroup[firstGroup]).toBe(true)
  })

  it("binding a split-group draft persists its group under the canonical id", async () => {
    await renderWithTabs([tabItem(1, 1, true)])
    const home = leaves()[0]

    act(() => {
      store().splitTab("conv-1-codex-1", "right", { move: false })
    })
    const g1 = newLeafBeside(home)
    const draft = store().rawTabs.find((t) => t.conversationId == null)!
    expect(groupOfId(draft.id)).toBe(g1)

    act(() => {
      store().bindConversationTab(draft.id, 99, "codex", "Bound", -1)
    })

    expect(groupOfId(draft.id)).toBe(g1)
    const blob = JSON.parse(
      localStorage.getItem("workspace:tab-groups:v1")!
    ) as { assignments: Record<string, string> }
    expect(blob.assignments["conv-1-codex-99"]).toBe(g1)
  })

  it("remote snapshots keep open tabs' groups, default new tabs to the first group, and keep drafts", async () => {
    await renderWithTabs([tabItem(1, 1, true)])
    expect(tabsChangedHandler).not.toBeNull()
    const home = leaves()[0]

    act(() => {
      store().splitTab("conv-1-codex-1", "right", { move: false })
    })
    const g1 = newLeafBeside(home)
    const draft = store().rawTabs.find((t) => t.conversationId == null)!

    act(() => {
      tabsChangedHandler?.({
        version: 7,
        origin: "other-device",
        tabs: [tabItem(1, 1), tabItem(1, 2)],
      })
    })

    expect(groupOfId("conv-1-codex-1")).toBe(home)
    expect(groupOfId("conv-1-codex-2")).toBe(home)
    expect(store().rawTabs.some((t) => t.id === draft.id)).toBe(true)
    expect(groupOfId(draft.id)).toBe(g1)
    expect(selectIsSplit(store())).toBe(true)
  })

  it("keeps the focused group's selection glued to the active tab across switches", async () => {
    await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2), tabItem(2, 3)])
    const home = leaves()[0]

    act(() => {
      store().splitTab("conv-2-codex-3", "right", { move: true })
    })
    const g1 = newLeafBeside(home)

    act(() => {
      store().switchTab("conv-1-codex-1")
    })
    expect(store().groupSelection[home]).toBe("conv-1-codex-1")
    expect(store().groupSelection[g1]).toBe("conv-2-codex-3")

    act(() => {
      store().switchTab("conv-2-codex-3")
    })
    expect(store().groupSelection[home]).toBe("conv-1-codex-1")
    expect(store().groupSelection[g1]).toBe("conv-2-codex-3")
    expect(store().activeTabId).toBe("conv-2-codex-3")
  })

  // Cross-group drag drops land at a specific position via
  // `moveTabToGroup(..., { index })`; menu moves stay index-less (assignment
  // only, no reorder). The index path is a partition insert: only the target
  // group gains a slot, every other group's relative order is untouched.
  describe("moveTabToGroup with index (drag drops)", () => {
    /** 4 tabs, then split-move conv-3 right → home [1,2,4], g1 [3]. */
    async function splitFour() {
      await renderWithTabs([
        tabItem(1, 1, true),
        tabItem(1, 2),
        tabItem(1, 3),
        tabItem(1, 4),
      ])
      const home = leaves()[0]
      act(() => {
        store().splitTab("conv-1-codex-3", "right", { move: true })
      })
      return { home, g1: newLeafBeside(home) }
    }

    it("inserts before the target group's k-th member", async () => {
      const { home, g1 } = await splitFour()

      act(() => {
        store().moveTabToGroup("conv-1-codex-1", g1, { index: 0 })
      })

      expect(groupOfId("conv-1-codex-1")).toBe(g1)
      expect(store().activeTabId).toBe("conv-1-codex-1")
      // g1 display order: dropped tab first, then the old member.
      expect(
        store()
          .rawTabs.filter((t) => groupOfId(t.id) === g1)
          .map((t) => t.id)
      ).toEqual(["conv-1-codex-1", "conv-1-codex-3"])
      // Partition insert: home's remaining tabs keep their relative order.
      expect(
        store()
          .rawTabs.filter((t) => groupOfId(t.id) === home)
          .map((t) => t.id)
      ).toEqual(["conv-1-codex-2", "conv-1-codex-4"])
    })

    it("appends past the last member when the index overshoots", async () => {
      const { g1 } = await splitFour()

      act(() => {
        store().moveTabToGroup("conv-1-codex-2", g1, { index: 99 })
      })

      expect(
        store()
          .rawTabs.filter((t) => groupOfId(t.id) === g1)
          .map((t) => t.id)
      ).toEqual(["conv-1-codex-3", "conv-1-codex-2"])
    })

    it("keeps the menu move (no index) free of rawTabs reorder and saves", async () => {
      const { g1 } = await splitFour()
      const orderBefore = store().rawTabs.map((t) => t.id)

      act(() => {
        store().moveTabToGroup("conv-1-codex-1", g1)
      })

      expect(store().rawTabs.map((t) => t.id)).toEqual(orderBefore)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 700))
      })
      expect(saveOpenedTabsMock).not.toHaveBeenCalled()
    })

    it("syncs a bound-tab drag insert like any user reorder", async () => {
      const { g1 } = await splitFour()

      act(() => {
        store().moveTabToGroup("conv-1-codex-1", g1, { index: 0 })
      })

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 700))
      })
      expect(saveOpenedTabsMock).toHaveBeenCalled()
    })

    // A draft is its group's own scratch slot (own composer text, own folder /
    // agent context), and every group can spawn one from its own strip — so it
    // never changes groups. All three routes must agree, or the UI and the store
    // disagree about where a group's draft lives.
    it("refuses to move a draft between groups (drag, menu, and split-and-move)", async () => {
      await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2)])
      const home = leaves()[0]
      act(() => {
        store().splitTab("conv-1-codex-1", "right", { move: false })
      })
      const g1 = newLeafBeside(home)
      const g1Draft = store().rawTabs.find(
        (t) => t.conversationId == null && groupOfId(t.id) === g1
      )!
      expect(g1Draft).toBeTruthy()

      // Drag drop (with index) and menu move (no index) are both rejected.
      act(() => {
        store().moveTabToGroup(g1Draft.id, home, { index: 0 })
      })
      expect(groupOfId(g1Draft.id)).toBe(g1)
      act(() => {
        store().moveTabToGroup(g1Draft.id, home)
      })
      expect(groupOfId(g1Draft.id)).toBe(g1)

      // Split-and-move on a draft is a no-op too (plain split still seeds a
      // fresh draft in the new group — covered above).
      const leavesBefore = leaves().length
      act(() => {
        store().splitTab(g1Draft.id, "down", { move: true })
      })
      expect(leaves()).toHaveLength(leavesBefore)
      expect(groupOfId(g1Draft.id)).toBe(g1)
    })

    it("still reorders a draft WITHIN its own group", async () => {
      await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2)])
      const home = leaves()[0]
      act(() => {
        store().openNewConversationTab(1, "/w1", { targetGroup: home })
      })
      const draft = store().rawTabs.find((t) => t.conversationId == null)!
      const homeTabs = store().tabs.filter((t) => groupOfId(t.id) === home)
      expect(homeTabs.map((t) => t.id)).toEqual([
        "conv-1-codex-1",
        "conv-1-codex-2",
        draft.id,
      ])

      act(() => {
        store().reorderGroupTabs(home, [homeTabs[2], homeTabs[0], homeTabs[1]])
      })

      expect(
        store()
          .rawTabs.filter((t) => groupOfId(t.id) === home)
          .map((t) => t.id)
      ).toEqual([draft.id, "conv-1-codex-1", "conv-1-codex-2"])
    })
  })

  // The unmount classifier that decides whether a vanishing conversation view
  // keeps its ACP connection. Getting this wrong in either direction is
  // expensive: too broad leaks viewer subscriptions (the idle sweep skips
  // viewers), too narrow kills a live agent CLI mid-stream on a group move.
  describe("isReparentUnmount", () => {
    it("is false when the surface unmounts with the tab left in place", async () => {
      await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2)])
      const home = leaves()[0]

      // Mobile conversation→file pane switch / workbench route overlay: the
      // whole surface unmounts, but nothing about the tab or its group moved.
      expect(isReparentUnmount(store(), "conv-1-codex-1", home)).toBe(false)
      expect(isReparentUnmount(store(), "conv-1-codex-2", home)).toBe(false)
    })

    it("is false for a closed tab so the connection still tears down", async () => {
      await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2)])
      const home = leaves()[0]

      act(() => {
        store().closeTab("conv-1-codex-2")
      })

      expect(isReparentUnmount(store(), "conv-1-codex-2", home)).toBe(false)
    })

    it("is true only for the tab a cross-group move actually reparents", async () => {
      await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2)])
      const home = leaves()[0]
      act(() => {
        store().splitTab("conv-1-codex-2", "right", { move: true })
      })
      const g1 = newLeafBeside(home)

      // The moved view rendered under `home` and now belongs to `g1`.
      expect(isReparentUnmount(store(), "conv-1-codex-2", home)).toBe(true)
      // Its sibling never left `home`, so its unmount would be a real one.
      expect(isReparentUnmount(store(), "conv-1-codex-1", home)).toBe(false)
      // And once remounted under g1, a later surface teardown is not a
      // reparent either.
      expect(isReparentUnmount(store(), "conv-1-codex-2", g1)).toBe(false)
    })

    it("is true for tabs merged back by dissolve and unsplit-all", async () => {
      await renderWithTabs([tabItem(1, 1, true), tabItem(1, 2)])
      const home = leaves()[0]
      act(() => {
        store().splitTab("conv-1-codex-2", "right", { move: true })
      })
      const g1 = newLeafBeside(home)

      act(() => {
        store().dissolveGroup(g1)
      })
      expect(isReparentUnmount(store(), "conv-1-codex-2", g1)).toBe(true)

      act(() => {
        store().splitTab("conv-1-codex-2", "down", { move: true })
      })
      const g2 = newLeafBeside(home)
      act(() => {
        store().unsplitAll()
      })
      expect(isReparentUnmount(store(), "conv-1-codex-2", g2)).toBe(true)
      // The tab that stayed in the surviving group is untouched.
      expect(isReparentUnmount(store(), "conv-1-codex-1", home)).toBe(false)
    })
  })
})
