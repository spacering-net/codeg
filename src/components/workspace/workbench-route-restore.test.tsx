/**
 * The window opens on the home view it was left on, through everything the
 * tab store does on its own while starting: the last session's tabs coming
 * back, a restored draft whose folder is gone being dropped, a draft made for
 * an empty workspace. Only the user's own activation of a conversation shows
 * the conversations (and is kept for next time). The real TabProvider, route
 * provider and route sync; the backend mocked as tab-context.test.tsx does.
 */
import { act, cleanup, render, screen } from "@testing-library/react"
import { useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TabProvider, useTabContext } from "@/contexts/tab-context"
import {
  useWorkbenchRoute,
  WorkbenchRouteProvider,
} from "@/contexts/workbench-route-context"
import type { AgentType, FolderDetail, OpenedTab } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { resetFolderTabsStore } from "@/stores/folder-tabs-store"
import { resetTabStore, useTabStore } from "@/stores/tab-store"

import { WorkbenchRouteConversationSync } from "./workbench-route-conversation-sync"

const h = vi.hoisted(() => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  loadLastActiveContext: vi.fn(),
}))

vi.mock("next-intl", () => {
  const t = (key: string) => key
  return { useTranslations: () => t }
})
vi.mock("@/lib/api", () => ({
  listOpenedTabs: (...args: unknown[]) => h.listOpenedTabs(...args),
  saveOpenedTabs: (...args: unknown[]) => h.saveOpenedTabs(...args),
  // The tab titles' reads: never answered here.
  getFolderConversation: vi.fn(() => new Promise(() => {})),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: () => Promise.resolve(() => {}),
  onTransportReconnect: () => () => {},
}))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({ activateConversationPane: vi.fn() }),
}))
vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => ({ disconnect: vi.fn(async () => {}) }),
}))
vi.mock("@/hooks/use-sorted-available-agents", () => ({
  useSortedAvailableAgents: () => ({
    sortedTypes: ["codex" satisfies AgentType],
    fresh: true,
  }),
}))
vi.mock("@/lib/last-active-context-storage", () => ({
  loadLastActiveContext: () => h.loadLastActiveContext(),
  saveLastActiveContext: vi.fn(),
  clearLastActiveContext: vi.fn(),
}))

const LAST_VIEW = "workspace:last-view:local"

function folder(id: number): FolderDetail {
  return {
    id,
    name: `f${id}`,
    path: `/f${id}`,
    git_branch: null,
    default_agent_type: "codex",
    last_opened_at: "2026-11-15T00:00:00Z",
    sort_order: id,
    color: "blue",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
  }
}

function tab(conversationId: number, isActive = false): OpenedTab {
  return {
    id: conversationId,
    folder_id: 1,
    conversation_id: conversationId,
    agent_type: "codex",
    position: 0,
    is_active: isActive,
    is_pinned: true,
  }
}

let tabs: ReturnType<typeof useTabContext> | null = null

function Probe() {
  const { routeId } = useWorkbenchRoute()
  const ctx = useTabContext()
  useEffect(() => {
    tabs = ctx
  }, [ctx])
  return <output data-testid="route">{routeId}</output>
}

function seedWorkspace(folders: FolderDetail[]) {
  resetFolderTabsStore()
  resetAppWorkspaceStore()
  useAppWorkspaceStore.setState({
    conversations: [],
    conversationsLoading: false,
    folders,
    allFolders: folders,
    foldersHydrated: true,
    setActiveFolderId: vi.fn(),
  })
}

/** The workspace as it starts: tabs, then the route over them. */
async function start(items: OpenedTab[]) {
  h.listOpenedTabs.mockResolvedValue({ items, version: 1 })
  render(
    <TabProvider>
      <WorkbenchRouteProvider>
        <WorkbenchRouteConversationSync />
        <Probe />
      </WorkbenchRouteProvider>
    </TabProvider>
  )
  await act(async () => {})
  await act(async () => {})
}

const route = () => screen.getByTestId("route").textContent

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  seedWorkspace([folder(1), folder(2)])
  resetTabStore()
  h.saveOpenedTabs.mockResolvedValue({ accepted: true, version: 2, tabs: [] })
  h.loadLastActiveContext.mockReturnValue(null)
  tabs = null
})
afterEach(cleanup)

describe("opening on the view the window was left on", () => {
  it("stays on the assistants page through the last session's tabs coming back", async () => {
    localStorage.setItem(LAST_VIEW, "personalAgent")
    await start([tab(1, true), tab(2)])
    expect(useTabStore.getState().activeTabId).not.toBeNull()
    expect(route()).toBe("personalAgent")
    expect(localStorage.getItem(LAST_VIEW)).toBe("personalAgent")
    // The user's own activation shows the conversations, kept for next time.
    const other = useTabStore
      .getState()
      .rawTabs.find((t) => t.id !== useTabStore.getState().activeTabId)!
    act(() => tabs!.switchTab(other.id))
    expect(route()).toBe("conversations")
    expect(localStorage.getItem(LAST_VIEW)).toBe("conversations")
  })

  it("stays on it through the draft made for an empty workspace", async () => {
    localStorage.setItem(LAST_VIEW, "personalAgent")
    await start([])
    // Recovered: a draft on the first folder, focused.
    const active = useTabStore.getState().activeTabId
    expect(active).toMatch(/^new-/)
    expect(route()).toBe("personalAgent")
    expect(localStorage.getItem(LAST_VIEW)).toBe("personalAgent")
    act(() => tabs!.openTab(1, 7, "codex", true, "Seven"))
    expect(route()).toBe("conversations")
    expect(localStorage.getItem(LAST_VIEW)).toBe("conversations")
  })

  it("stays on it through a restored draft whose folder is gone being dropped", async () => {
    // A session left with a draft on folder 2, focused.
    await start([tab(1, true)])
    act(() => tabs!.openNewConversationTab(2, "/f2"))
    const draft = useTabStore.getState().activeTabId!
    expect(
      useTabStore.getState().rawTabs.find((t) => t.id === draft)?.folderId
    ).toBe(2)
    cleanup()
    // Folder 2 deleted while the app was closed; the window was left on the
    // assistants page.
    act(() => resetTabStore())
    seedWorkspace([folder(1)])
    localStorage.setItem(LAST_VIEW, "personalAgent")
    // Its conversation tab is still there, so nothing is recovered: the
    // focus moves to it from the dropped draft, and that alone.
    await start([tab(1)])
    expect(useTabStore.getState().rawTabs.some((t) => t.id === draft)).toBe(
      false
    )
    expect(useTabStore.getState().activeTabId).toBe("conv-1-codex-1")
    expect(route()).toBe("personalAgent")
    expect(localStorage.getItem(LAST_VIEW)).toBe("personalAgent")
    // And the user's first activation after it still counts.
    act(() => tabs!.openTab(1, 7, "codex", true, "Seven"))
    expect(route()).toBe("conversations")
  })

  it("opens on the conversations when they were shown last, as before", async () => {
    await start([tab(1, true)])
    expect(route()).toBe("conversations")
  })
})
