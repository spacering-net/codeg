import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  initialConversationPanes,
  paneForTab,
  persistedConversationPanes,
  restoreConversationPanes,
} from "@/lib/conversation-panes"
import { leafIds, singleGroupLayout, splitGroup } from "@/lib/tab-group-layout"
import { listOpenedTabs, saveOpenedTabs } from "@/lib/api"
import { CONVERSATION_PANES_PREF_KEY } from "@/lib/conversation-pane-prefs"
import type { FolderDetail, OpenedTab } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import { resetFolderTabsStore, useFolderTabsStore } from "./folder-tabs-store"
import {
  isTabInScope,
  resetTabStore,
  shellGroupOfTab,
  useTabStore,
} from "./tab-store"
import {
  buildNewConversationDraftStorageKey,
  saveMessageInputDraft,
  loadMessageInputDraft,
} from "@/lib/message-input-draft"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))

const folders: FolderDetail[] = [1, 2].map((id) => ({
  id,
  name: `repo-${id}`,
  path: `/repo-${id}`,
  git_branch: null,
  default_agent_type: null,
  last_opened_at: "",
  sort_order: id,
  color: "inherit",
  parent_id: null,
  kind: "folder",
  alias: null,
  group_id: null,
}))

const opened: OpenedTab[] = [1, 2].map((id) => ({
  id,
  folder_id: id,
  conversation_id: id,
  agent_type: "codex",
  position: id,
  is_active: id === 1,
  is_pinned: true,
}))

async function hydrate() {
  vi.mocked(listOpenedTabs).mockResolvedValue({ items: opened, version: 0 })
  useTabStore.getState().hydrate()
  await vi.waitFor(() => expect(useTabStore.getState().tabsHydrated).toBe(true))
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(CONVERSATION_PANES_PREF_KEY, "true")
  vi.clearAllMocks()
  resetTabStore()
  resetFolderTabsStore()
  resetAppWorkspaceStore()
  useAppWorkspaceStore.setState({
    folders,
    allFolders: folders,
    foldersHydrated: true,
  })
})

afterEach(() => {
  useTabStore.getState().clearSaveTimer()
  vi.useRealTimers()
})

describe("会话 Pane", () => {
  it("默认关闭，收到共享 Pane 也保持普通标签页和文件夹范围", async () => {
    localStorage.removeItem(CONVERSATION_PANES_PREF_KEY)
    const shared = initialConversationPanes()
    shared.panes[0].name = "Another device"
    vi.mocked(listOpenedTabs).mockResolvedValue({
      items: opened,
      version: 0,
      pane_state: shared,
    })
    useTabStore.getState().hydrate()
    await vi.waitFor(() =>
      expect(useTabStore.getState().tabsHydrated).toBe(true)
    )
    expect(useTabStore.getState().panesEnabled).toBe(false)
    expect(useTabStore.getState().paneState).toBeNull()
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(1)
    expect(useTabStore.getState().rawTabs.filter(isTabInScope)).toHaveLength(1)
    useTabStore.getState().handleTabsChanged({
      tabs: opened,
      version: 1,
      origin: "another-client",
      pane_state: shared,
    })
    expect(useTabStore.getState().paneState).toBeNull()
    expect(useTabStore.getState().rawTabs.filter(isTabInScope)).toHaveLength(1)
  })

  it("关闭后保留所有会话与 Pane，重新启用恢复名称、布局和草稿归属", async () => {
    await hydrate()
    const disconnect = vi.fn()
    useTabStore.getState().setSideEffects({
      activateConversationPane: vi.fn(),
      acpDisconnect: disconnect,
    })
    const original = useTabStore.getState().paneState!.activePaneId
    useTabStore.getState().createPane()
    const created = useTabStore.getState().paneState!.activePaneId
    useTabStore.getState().renamePane(created, "Keep this Pane")
    useTabStore
      .getState()
      .moveTabToPane(useTabStore.getState().rawTabs[1].id, created)
    useTabStore.getState().openNewConversationTab(2, "/repo-2")
    const draftId = useTabStore.getState().activeTabId!
    const before = structuredClone(useTabStore.getState().paneState)
    const tabs = useTabStore.getState().rawTabs

    useTabStore.getState().setPanesEnabled(false)
    expect(useTabStore.getState().paneState).toBeNull()
    expect(useTabStore.getState().rawTabs).toEqual(tabs)
    expect(useTabStore.getState().rawTabs.every(isTabInScope)).toBe(true)

    useTabStore.getState().setPanesEnabled(true)
    const restored = useTabStore.getState().paneState!
    expect(restored.panes.map((pane) => pane.id)).toEqual([original, created])
    expect(restored.panes[1].name).toBe("Keep this Pane")
    expect(restored.panes[1].layout).toEqual(before!.panes[1].layout)
    expect(paneForTab(restored, draftId)?.id).toBe(created)
    expect(useTabStore.getState().rawTabs).toEqual(tabs)
    expect(disconnect).not.toHaveBeenCalled()
  })

  it("迁移当前标签到 Pane 1，跨项目且不受文件夹过滤", async () => {
    await hydrate()
    const state = useTabStore.getState()
    expect(state.paneState?.panes).toHaveLength(1)
    useFolderTabsStore.getState().setEnabled(true)
    expect(state.rawTabs.every(isTabInScope)).toBe(true)
    useFolderTabsStore.getState().activateScope(2)
    expect(state.rawTabs.every(isTabInScope)).toBe(true)
  })

  it("启用后再关闭恢复原有分屏和文件夹范围", async () => {
    localStorage.removeItem(CONVERSATION_PANES_PREF_KEY)
    await hydrate()
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(1)
    const source = useTabStore.getState().rawTabs[0].id
    useTabStore.getState().splitTab(source, "right", { move: false })
    const regularLayout = useTabStore.getState().groupLayout
    const regularGroups = { ...useTabStore.getState().groupOf }

    useTabStore.getState().setPanesEnabled(true)
    expect(useTabStore.getState().rawTabs.every(isTabInScope)).toBe(true)
    useTabStore.getState().createPane()
    useTabStore.getState().setPanesEnabled(false)

    expect(useTabStore.getState().groupLayout).toEqual(regularLayout)
    expect(useTabStore.getState().groupOf).toEqual(regularGroups)
    expect(
      useTabStore
        .getState()
        .rawTabs.filter(isTabInScope)
        .map((tab) => tab.folderId)
    ).toEqual([1, 1])
  })

  it("创建空 Pane，原视图保持隐藏且不关闭标签或断连", async () => {
    await hydrate()
    const disconnect = vi.fn()
    useTabStore.getState().setSideEffects({
      activateConversationPane: vi.fn(),
      acpDisconnect: disconnect,
    })
    const original = useTabStore.getState().paneState!.activePaneId
    const tabId = useTabStore.getState().rawTabs[0].id
    const originalShell = shellGroupOfTab(useTabStore.getState(), tabId)
    useTabStore.getState().createPane()
    const state = useTabStore.getState()
    expect(state.activeTabId).toBeNull()
    expect(state.rawTabs).toHaveLength(2)
    expect(state.rawTabs.filter(isTabInScope)).toHaveLength(0)
    expect(shellGroupOfTab(state, tabId)).toBe(originalShell)
    expect(disconnect).not.toHaveBeenCalled()
    state.switchPane(original)
    expect(useTabStore.getState().rawTabs.filter(isTabInScope)).toHaveLength(2)
    expect(useTabStore.getState().activeTabId).toBe(tabId)
  })

  it("打开既有会话回所属 Pane，关闭重开加入当前 Pane", async () => {
    await hydrate()
    const first = useTabStore.getState().paneState!.activePaneId
    useTabStore.getState().createPane()
    const second = useTabStore.getState().paneState!.activePaneId
    useTabStore.getState().openTab(1, 1, "codex", true)
    expect(useTabStore.getState().paneState!.activePaneId).toBe(first)
    const tabId = useTabStore.getState().activeTabId!
    useTabStore.getState().closeTab(tabId)
    useTabStore.getState().switchPane(second)
    useTabStore.getState().openTab(1, 1, "codex", true)
    expect(paneForTab(useTabStore.getState().paneState!, tabId)?.id).toBe(
      second
    )
  })

  it("移动会话到目标 Pane 的组并激活，保留源会话和运行身份", async () => {
    await hydrate()
    const original = useTabStore.getState().paneState!.activePaneId
    const tab = useTabStore.getState().rawTabs[0]
    useTabStore.getState().setTabRuntimeConversationId(tab.id, -42)
    useTabStore.getState().createPane()
    const target = useTabStore.getState().paneState!.activePaneId
    useTabStore.getState().switchPane(original)
    useTabStore.getState().moveTabToPane(tab.id, target)
    const state = useTabStore.getState()
    expect(state.paneState!.activePaneId).toBe(target)
    expect(state.activeTabId).toBe(tab.id)
    expect(
      state.rawTabs.find((item) => item.id === tab.id)?.runtimeConversationId
    ).toBe(-42)
    expect(
      state.paneState!.panes.filter((pane) =>
        Object.prototype.hasOwnProperty.call(pane.assignments, tab.id)
      )
    ).toHaveLength(1)
    expect(state.rawTabs).toHaveLength(2)
  })

  it("移除 Pane 只关闭其中标签，保留其他 Pane；最后一个不能移除", async () => {
    await hydrate()
    const first = useTabStore.getState().paneState!.activePaneId
    useTabStore.getState().createPane()
    const second = useTabStore.getState().paneState!.activePaneId
    useTabStore.getState().removePane(first)
    expect(useTabStore.getState().rawTabs).toHaveLength(0)
    expect(useTabStore.getState().paneState!.activePaneId).toBe(second)
    useTabStore.getState().removePane(second)
    expect(useTabStore.getState().paneState!.panes).toHaveLength(1)
  })

  it("分屏和草稿在 Pane 切换后保留，关闭全部只作用于当前 Pane", async () => {
    await hydrate()
    const first = useTabStore.getState().paneState!.activePaneId
    useTabStore
      .getState()
      .splitTab(useTabStore.getState().activeTabId!, "right", { move: false })
    const layout = useTabStore.getState().groupLayout
    expect(leafIds(layout)).toHaveLength(2)
    useTabStore.getState().createPane()
    useTabStore.getState().closeAllTabs()
    expect(useTabStore.getState().rawTabs).toHaveLength(3)
    useTabStore.getState().switchPane(first)
    expect(useTabStore.getState().groupLayout).toEqual(layout)
    expect(useTabStore.getState().rawTabs.filter(isTabInScope)).toHaveLength(3)
  })

  it("保存含空 Pane 的共享状态，草稿不发送服务端", async () => {
    await hydrate()
    useTabStore.getState().createPane()
    const paneId = useTabStore.getState().paneState!.activePaneId
    useTabStore.getState().openNewConversationTab(1, "/repo-1")
    const state = useTabStore.getState()
    const shared = persistedConversationPanes(state.paneState!, state.rawTabs)
    expect(
      shared.panes.find((pane) => pane.id === paneId)?.assignments
    ).toEqual({})
    expect(shared.panes.find((pane) => pane.id === paneId)?.active).toBeNull()
    vi.mocked(saveOpenedTabs).mockResolvedValue({
      accepted: true,
      version: 1,
      tabs: opened,
      pane_state: shared,
    })
    vi.useFakeTimers()
    state.runSaveEffect()
    await vi.advanceTimersByTimeAsync(550)
    expect(saveOpenedTabs).toHaveBeenCalledWith(
      expect.any(Array),
      0,
      expect.any(String),
      shared
    )
  })

  it("远端同步名称、当前 Pane 和布局，不把会话重复归属", async () => {
    await hydrate()
    const panes = initialConversationPanes()
    const tabId = "conv-1-codex-1"
    panes.panes[0].name = "远端"
    panes.panes[0].assignments = {
      [tabId]: "g-main",
      "conv-2-codex-2": "g-main",
    }
    panes.panes[0].active = tabId
    useTabStore.getState().handleTabsChanged({
      version: 3,
      origin: "other-client",
      tabs: opened,
      pane_state: panes,
    })
    expect(useTabStore.getState().paneState!.panes[0].name).toBe("远端")
    expect(useTabStore.getState().activeTabId).toBe(tabId)
    expect(
      useTabStore.getState().paneState!.panes[0].assignments
    ).toHaveProperty(tabId)
  })

  it("重启恢复多个 Pane、选中位置和本机未发送草稿", async () => {
    await hydrate()
    useTabStore.getState().createPane()
    const paneId = useTabStore.getState().paneState!.activePaneId
    useTabStore.getState().renamePane(paneId, "调研")
    const draft = useTabStore.getState().openNewConversationTab(1, "/repo-1")
    const key = buildNewConversationDraftStorageKey(draft.tabId)
    saveMessageInputDraft(key, "保留未发送输入")
    const state = useTabStore.getState()
    const shared = persistedConversationPanes(state.paneState!, state.rawTabs)
    resetTabStore()
    vi.mocked(listOpenedTabs).mockResolvedValue({
      items: opened,
      version: 5,
      pane_state: shared,
    })
    useTabStore.getState().hydrate()
    await vi.waitFor(() =>
      expect(useTabStore.getState().tabsHydrated).toBe(true)
    )
    const restored = useTabStore.getState()
    expect(restored.paneState!.activePaneId).toBe(paneId)
    expect(restored.activeTabId).toBe(draft.tabId)
    expect(
      restored.paneState!.panes.find((pane) => pane.id === paneId)?.name
    ).toBe("调研")
    expect(paneForTab(restored.paneState!, draft.tabId)?.id).toBe(paneId)
    expect(loadMessageInputDraft(key)).toBe("保留未发送输入")
  })

  it("过期 CAS 被拒绝时采用新布局，不重写远端的改名和归属", async () => {
    await hydrate()
    useTabStore.getState().renamePane("pane-main", "本地旧修改")
    const remote = initialConversationPanes()
    remote.panes[0].name = "远端新修改"
    remote.panes[0].assignments = {
      "conv-1-codex-1": "g-main",
      "conv-2-codex-2": "g-main",
    }
    remote.panes[0].active = "conv-1-codex-1"
    vi.mocked(saveOpenedTabs).mockResolvedValue({
      accepted: false,
      version: 10,
      tabs: opened,
      pane_state: remote,
    })
    vi.useFakeTimers()
    useTabStore.getState().runSaveEffect()
    await vi.advanceTimersByTimeAsync(550)
    expect(useTabStore.getState().paneState!.panes[0].name).toBe("远端新修改")
    useTabStore.getState().runSaveEffect()
    await vi.advanceTimersByTimeAsync(550)
    expect(saveOpenedTabs).toHaveBeenCalledTimes(1)
  })

  it("共享空 Pane 不被另一端自动填入会话或新草稿", async () => {
    const shared = initialConversationPanes()
    vi.mocked(listOpenedTabs).mockResolvedValue({
      items: [],
      version: 2,
      pane_state: shared,
    })
    useTabStore.getState().hydrate()
    await vi.waitFor(() =>
      expect(useTabStore.getState().tabsHydrated).toBe(true)
    )
    expect(useTabStore.getState().rawTabs).toEqual([])
    expect(useTabStore.getState().activeTabId).toBeNull()
    expect(useTabStore.getState().paneState!.panes).toHaveLength(1)
  })

  it("首次读取失败后重连，仍会初始化并保存 Pane", async () => {
    vi.mocked(listOpenedTabs).mockRejectedValueOnce(new Error("offline"))
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    useTabStore.getState().hydrate()
    await vi.waitFor(() =>
      expect(useTabStore.getState().tabsHydrated).toBe(true)
    )
    vi.mocked(listOpenedTabs).mockResolvedValue({ items: opened, version: 0 })
    await useTabStore.getState().refetchTabs()
    log.mockRestore()
    expect(useTabStore.getState().paneState?.panes[0].name).toBe("Pane 1")
    expect(useTabStore.getState().rawTabs.filter(isTabInScope)).toHaveLength(2)
  })

  it("保留本机草稿组时，不覆盖另一端新建的分屏", async () => {
    await hydrate()
    const tabs = useTabStore.getState().rawTabs
    const draft = {
      ...tabs[0],
      id: "new-local-draft",
      conversationId: null,
    }
    const local = initialConversationPanes()
    local.panes[0].layout = splitGroup(
      singleGroupLayout(),
      "g-main",
      "right",
      "g-draft"
    )
    local.panes[0].assignments = {
      [tabs[0].id]: "g-main",
      [draft.id]: "g-draft",
    }
    const remote = initialConversationPanes()
    remote.panes[0].layout = splitGroup(
      singleGroupLayout(),
      "g-main",
      "down",
      "g-remote"
    )
    remote.panes[0].assignments = {
      [tabs[0].id]: "g-main",
      [tabs[1].id]: "g-remote",
    }
    const restored = restoreConversationPanes(remote, [...tabs, draft], local)
    expect(leafIds(restored.panes[0].layout)).toEqual([
      "g-main",
      "g-draft",
      "g-remote",
    ])
    expect(restored.panes[0].assignments[draft.id]).toBe("g-draft")
    expect(restored.panes[0].assignments[tabs[1].id]).toBe("g-remote")
  })

  it("另一端草稿未同步成员时，仍保持共享分屏；主动关闭有成员的组才收拢", async () => {
    const shared = initialConversationPanes()
    shared.panes[0].layout = splitGroup(
      singleGroupLayout(),
      "g-main",
      "right",
      "g-other-draft"
    )
    shared.panes[0].assignments = {
      "conv-1-codex-1": "g-main",
      "conv-2-codex-2": "g-main",
    }
    vi.mocked(listOpenedTabs).mockResolvedValue({
      items: opened,
      version: 1,
      pane_state: shared,
    })
    useTabStore.getState().hydrate()
    await vi.waitFor(() =>
      expect(useTabStore.getState().tabsHydrated).toBe(true)
    )
    expect(leafIds(useTabStore.getState().groupLayout)).toEqual([
      "g-main",
      "g-other-draft",
    ])
    useTabStore.getState().renamePane("pane-main", "共享布局")
    expect(leafIds(useTabStore.getState().groupLayout)).toEqual([
      "g-main",
      "g-other-draft",
    ])
    useTabStore.getState().splitTab("conv-1-codex-1", "down", { move: true })
    expect(leafIds(useTabStore.getState().groupLayout)).toHaveLength(3)
    useTabStore.getState().closeTab("conv-1-codex-1")
    expect(leafIds(useTabStore.getState().groupLayout)).toEqual([
      "g-main",
      "g-other-draft",
    ])
  })
})
