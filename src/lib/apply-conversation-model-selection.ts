import { updateConversationModelSelection } from "@/lib/api"
import { rememberAgentModelSelection } from "@/lib/remembered-agent-model-selection"
import type { AgentType } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  clearModelProviderSelectionWriteInFlight,
  consumeModelProviderDraftSelection,
  markModelProviderSelectionWriteInFlight,
  setModelProviderDraftSelection,
} from "@/stores/model-provider-selection-store"

/** The connection state and restart action needed to apply launch-time config. */
export interface ModelSelectionConnection {
  isViewer: boolean
  status: string | null
  reapplyConfig: (
    conversationIdOverride?: number,
    options?: { freshSession?: boolean }
  ) => Promise<boolean>
}

export interface ApplyDraftModelSelectionParams {
  tabId: string
  conversationId: number
  /** The agent whose remembered provider/model choice should be updated. */
  agentType: AgentType
  connection: ModelSelectionConnection
  /** New conversations have no history; start a new session instead of loading
   *  the unused session that was launched before the provider was selected. */
  freshSession?: boolean
}

/**
 * Mirror `persistSelection`'s optimistic write: put the user's choice on the
 * workspace row before the save round-trip starts. The freshly created row
 * (or the bare upsert broadcast that announced it) has no selection — without
 * this, the picker's auto-default would see "bound, no choice" in the window
 * between consuming the draft and the authoritative broadcast, and overwrite
 * the user's pick with the first visible provider's first model.
 */
function applyOptimisticConversationModelSelection(
  conversationId: number,
  providerId: string,
  modelId: string
) {
  const { conversations, applyConversationUpsert } =
    useAppWorkspaceStore.getState()
  const row = conversations.find((c) => c.id === conversationId)
  if (!row) return
  applyConversationUpsert({
    ...row,
    model_source: "provider",
    model_provider_id: providerId,
    model_provider_model_id: modelId,
    model: modelId,
  })
}

/**
 * Save a pre-bind Model Provider choice and make its launch-time config live.
 * Returns the applied selection, or `null` when the draft had no choice. On
 * failure the draft is restored so a retry can save/send the same choice.
 */
export async function applyDraftModelSelection({
  tabId,
  conversationId,
  agentType,
  connection,
  freshSession = false,
}: ApplyDraftModelSelectionParams) {
  const selection = consumeModelProviderDraftSelection(tabId)
  if (!selection) return null

  // A choice is being written for this tab: hold the picker's auto-default
  // off and show the choice on the row immediately — the optimistic write is
  // what the picker displays until the authoritative broadcast lands.
  markModelProviderSelectionWriteInFlight(tabId)
  applyOptimisticConversationModelSelection(
    conversationId,
    selection.providerId,
    selection.modelId
  )

  try {
    await updateConversationModelSelection(
      conversationId,
      selection.providerId,
      selection.modelId
    )
    // The choice was actually applied to a conversation — remember it for the
    // agent so the next new conversation can restore it.
    rememberAgentModelSelection(agentType, selection)
  } catch (error) {
    setModelProviderDraftSelection(tabId, selection)
    clearModelProviderSelectionWriteInFlight(tabId)
    // Drop the optimistic row write — the save never happened.
    void useAppWorkspaceStore.getState().refreshConversations()
    throw error
  }

  try {
    if (!connection.isViewer && connection.status === "connected") {
      await connection.reapplyConfig(conversationId, { freshSession })
    }
  } catch (error) {
    setModelProviderDraftSelection(tabId, selection)
    throw error
  } finally {
    clearModelProviderSelectionWriteInFlight(tabId)
  }

  return selection
}
