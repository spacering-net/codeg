import { act, cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { TabProvider } from "@/contexts/tab-context"
import {
  buildNewConversationDraftStorageKey,
  loadMessageInputDraftV2,
  saveMessageInputDraftV2,
} from "@/lib/message-input-draft"
import type { FolderDetail } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import { resetTabStore, useTabStore } from "./tab-store"

const mocks = vi.hoisted(() => ({
  listOpenFolders: vi.fn(),
  listAllFolders: vi.fn(),
  listGroups: vi.fn(),
  listTabs: vi.fn(),
  saveTabs: vi.fn(),
  activate: vi.fn(),
  disconnect: vi.fn(),
  translate: (key: string) => key,
}))

vi.mock("next-intl", () => ({ useTranslations: () => mocks.translate }))
vi.mock("@/lib/api", () => ({
  listOpenFolderDetails: mocks.listOpenFolders,
  listAllFolderDetails: mocks.listAllFolders,
  listFolderGroups: mocks.listGroups,
  listOpenedTabs: mocks.listTabs,
  saveOpenedTabs: mocks.saveTabs,
}))
vi.mock("@/lib/platform", () => ({
  subscribe: async () => () => {},
  onTransportReconnect: () => () => {},
}))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({ activateConversationPane: mocks.activate }),
}))
vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => ({ disconnect: mocks.disconnect }),
}))
vi.mock("@/hooks/use-sorted-available-agents", () => ({
  useSortedAvailableAgents: () => ({ sortedTypes: [], fresh: false }),
}))

const draftId = "new-offline-draft"
const draftKey = buildNewConversationDraftStorageKey(draftId)
let errors: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  resetAppWorkspaceStore()
  localStorage.setItem(
    "workspace:tab-groups:v1",
    JSON.stringify({
      layout: { type: "group", id: "g-main" },
      assignments: {},
      selection: { "g-main": draftId },
      tileByGroup: {},
      drafts: [
        {
          id: draftId,
          group: "g-main",
          index: 0,
          folderId: 1,
          workingDir: "/repo",
          agentType: "codex",
        },
      ],
      activeDraft: draftId,
    })
  )
  saveMessageInputDraftV2(draftKey, {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Unsent work survives offline" }],
      },
    ],
  })
  resetTabStore()
  mocks.listOpenFolders.mockRejectedValue(new Error("remote offline"))
  mocks.listAllFolders.mockRejectedValue(new Error("remote offline"))
  mocks.listGroups.mockRejectedValue(new Error("remote offline"))
  mocks.listTabs.mockRejectedValue(new Error("remote offline"))
  errors = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  resetTabStore()
  errors.mockRestore()
  localStorage.clear()
})

it("preserves a restored composer draft until an authoritative folder snapshot arrives", async () => {
  const savedText = loadMessageInputDraftV2(draftKey)
  const storageKey = `codeg:message-input-draft:v2:${draftKey}`
  const persistedText = localStorage.getItem(storageKey)
  expect(persistedText).not.toBeNull()
  render(
    <TabProvider>
      <div>Offline workspace</div>
    </TabProvider>
  )
  await act(async () => {
    await useAppWorkspaceStore.getState().fetchFolders()
  })
  await waitFor(() => expect(useTabStore.getState().tabsHydrated).toBe(true))

  // Both HTTP reads failed, but the real TabProvider must not interpret an
  // unknown folder set as deletion and clear the persisted composer key.
  expect(useAppWorkspaceStore.getState().foldersHydrated).toBe(false)
  expect(useTabStore.getState().rawTabs.map((tab) => tab.id)).toContain(draftId)
  expect(loadMessageInputDraftV2(draftKey)).toEqual(savedText)
  expect(localStorage.getItem(storageKey)).toBe(persistedText)

  const folder: FolderDetail = {
    id: 1,
    name: "repo",
    path: "/repo",
    git_branch: null,
    default_agent_type: "codex",
    last_opened_at: "2026-01-01T00:00:00.000Z",
    sort_order: 0,
    color: "inherit",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
  }
  mocks.listOpenFolders.mockResolvedValue([folder])
  mocks.listAllFolders.mockResolvedValue([folder])
  mocks.listGroups.mockResolvedValue([])
  await act(async () => {
    await useAppWorkspaceStore.getState().fetchFolders()
  })

  expect(useAppWorkspaceStore.getState().foldersHydrated).toBe(true)
  expect(useTabStore.getState().rawTabs.map((tab) => tab.id)).toContain(draftId)
  expect(loadMessageInputDraftV2(draftKey)).toEqual(savedText)
  expect(localStorage.getItem(storageKey)).toBe(persistedText)
  expect(mocks.saveTabs).not.toHaveBeenCalled()
})
