import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  applyDraftModelSelection,
  type ModelSelectionConnection,
} from "./apply-conversation-model-selection"
import type { DbConversationSummary } from "@/lib/types"
import { loadRememberedAgentModelSelection } from "./remembered-agent-model-selection"
import {
  getModelProviderDraftSelection,
  isModelProviderSelectionWriteInFlight,
  resetModelProviderSelectionStore,
  setModelProviderDraftSelection,
} from "@/stores/model-provider-selection-store"

const { applyConversationUpsert, refreshConversations } = vi.hoisted(() => ({
  applyConversationUpsert: vi.fn(),
  refreshConversations: vi.fn(async () => {}),
}))

vi.mock("@/lib/api", () => ({
  updateConversationModelSelection: vi.fn(),
}))

// The real workspace store pulls in the whole API surface; a minimal zustand
// store keeps this unit test focused on the apply/save flow itself.
vi.mock("@/stores/app-workspace-store", async () => {
  const { create } = await import("zustand")
  const useAppWorkspaceStore = create<{
    conversations: Array<Record<string, unknown>>
    applyConversationUpsert: (summary: Record<string, unknown>) => void
    refreshConversations: () => Promise<void>
  }>(() => ({
    conversations: [],
    applyConversationUpsert,
    refreshConversations,
  }))
  return { useAppWorkspaceStore }
})

function conversationSummary(id: number): DbConversationSummary {
  return {
    id,
    folder_id: 1,
    title: null,
    title_locked: false,
    agent_type: "claude_code",
    status: "pending",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    child_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    pinned_at: null,
  }
}
const { updateConversationModelSelection } = vi.mocked(
  await import("@/lib/api")
)
const { useAppWorkspaceStore } = await import("@/stores/app-workspace-store")

const selection = { providerId: "anthropic", modelId: "claude-opus-4-5" }
const agentType = "claude_code"

function connection(
  overrides: Partial<ModelSelectionConnection> = {}
): ModelSelectionConnection {
  return {
    isViewer: false,
    status: "connected",
    reapplyConfig: vi.fn(async () => true),
    ...overrides,
  }
}

describe("applyDraftModelSelection", () => {
  beforeEach(() => {
    resetModelProviderSelectionStore()
    updateConversationModelSelection.mockReset()
    localStorage.clear()
    useAppWorkspaceStore.setState({ conversations: [] })
    applyConversationUpsert.mockClear()
    refreshConversations.mockClear()
  })

  it("saves the draft, applies it to a fresh session, and remembers it", async () => {
    setModelProviderDraftSelection("tab-1", selection)
    updateConversationModelSelection.mockResolvedValue(undefined)
    const conn = connection()

    await expect(
      applyDraftModelSelection({
        tabId: "tab-1",
        conversationId: 42,
        agentType,
        connection: conn,
        freshSession: true,
      })
    ).resolves.toEqual(selection)

    expect(updateConversationModelSelection).toHaveBeenCalledWith(
      42,
      selection.providerId,
      selection.modelId
    )
    expect(conn.reapplyConfig).toHaveBeenCalledWith(42, { freshSession: true })
    expect(getModelProviderDraftSelection("tab-1")).toBeNull()
    expect(loadRememberedAgentModelSelection(agentType)).toEqual(selection)
    // No workspace row announced yet → the optimistic write is a no-op.
    expect(applyConversationUpsert).not.toHaveBeenCalled()
  })

  it("writes the choice onto the row and flags the write while saving", async () => {
    useAppWorkspaceStore.setState({
      conversations: [{ ...conversationSummary(42), model_source: "provider" }],
    })
    setModelProviderDraftSelection("tab-1", selection)
    let resolveSave: () => void = () => {}
    updateConversationModelSelection.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve
        })
    )
    const conn = connection()

    const pending = applyDraftModelSelection({
      tabId: "tab-1",
      conversationId: 42,
      agentType,
      connection: conn,
      freshSession: true,
    })

    // Before the save resolves: the row already carries the user's choice —
    // the same optimistic write `persistSelection` does — and the picker is
    // told a write is in flight so its auto-default holds off.
    expect(applyConversationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 42,
        model_source: "provider",
        model_provider_id: "anthropic",
        model_provider_model_id: "claude-opus-4-5",
        model: "claude-opus-4-5",
      })
    )
    expect(isModelProviderSelectionWriteInFlight("tab-1")).toBe(true)

    resolveSave()
    await expect(pending).resolves.toEqual(selection)
    expect(isModelProviderSelectionWriteInFlight("tab-1")).toBe(false)
  })

  it("keeps resume semantics for an existing conversation", async () => {
    setModelProviderDraftSelection("tab-1", selection)
    updateConversationModelSelection.mockResolvedValue(undefined)
    const conn = connection()

    await applyDraftModelSelection({
      tabId: "tab-1",
      conversationId: 42,
      agentType,
      connection: conn,
    })

    expect(conn.reapplyConfig).toHaveBeenCalledWith(42, {
      freshSession: false,
    })
    expect(loadRememberedAgentModelSelection(agentType)).toEqual(selection)
  })

  it("does nothing when the draft has no selection", async () => {
    const conn = connection()

    await expect(
      applyDraftModelSelection({
        tabId: "tab-1",
        conversationId: 42,
        agentType,
        connection: conn,
      })
    ).resolves.toBeNull()

    expect(updateConversationModelSelection).not.toHaveBeenCalled()
    expect(conn.reapplyConfig).not.toHaveBeenCalled()
    expect(loadRememberedAgentModelSelection(agentType)).toBeNull()
  })

  it("restores the draft and skips reconnect when saving fails", async () => {
    setModelProviderDraftSelection("tab-1", selection)
    updateConversationModelSelection.mockRejectedValue(new Error("save failed"))
    const conn = connection()

    await expect(
      applyDraftModelSelection({
        tabId: "tab-1",
        conversationId: 42,
        agentType,
        connection: conn,
      })
    ).rejects.toThrow("save failed")

    expect(conn.reapplyConfig).not.toHaveBeenCalled()
    expect(getModelProviderDraftSelection("tab-1")).toEqual(selection)
    expect(loadRememberedAgentModelSelection(agentType)).toBeNull()
    // The in-flight marker is released and the optimistic row write is
    // dropped by re-syncing the authoritative rows.
    expect(isModelProviderSelectionWriteInFlight("tab-1")).toBe(false)
    expect(refreshConversations).toHaveBeenCalled()
  })

  it("restores the draft when applying the saved selection fails", async () => {
    setModelProviderDraftSelection("tab-1", selection)
    updateConversationModelSelection.mockResolvedValue(undefined)
    const conn = connection({
      reapplyConfig: vi.fn(async () => {
        throw new Error("reconnect failed")
      }),
    })

    await expect(
      applyDraftModelSelection({
        tabId: "tab-1",
        conversationId: 42,
        agentType,
        connection: conn,
      })
    ).rejects.toThrow("reconnect failed")

    expect(updateConversationModelSelection).toHaveBeenCalledTimes(1)
    expect(getModelProviderDraftSelection("tab-1")).toEqual(selection)
    // The save succeeded, so the memory is written even though the reconnect
    // afterwards failed (the retry will re-apply the same choice).
    expect(loadRememberedAgentModelSelection(agentType)).toEqual(selection)
  })
})
