"use client"

import { createContext, useContext } from "react"
import type { CanvasNodePatchInput } from "@/lib/api"
import type { AgentType, DbConversationSummary } from "@/lib/types"
import type { NewConversationTarget } from "./canvas-model"

/**
 * Actions and interaction state the custom ReactFlow node components need from
 * the canvas view. A context (rather than routing through RF `data`) so
 * selection-mirror highlights and expand toggles don't have to rebuild the
 * whole node array to reach one card.
 */
export interface CanvasViewContextValue {
  /** Regions whose "+N" expander is open. */
  expandedRegions: ReadonlySet<number>
  setRegionExpanded: (regionDbId: number, expanded: boolean) => void
  /** Pinned cards (by db id) rendered as a live conversation. */
  detailCards: ReadonlySet<number>
  setCardDetail: (pinDbId: number, open: boolean) => void
  /**
   * Expanded cards allowed to hold an ACP connection. An expansion restored
   * from a previous visit starts OUTSIDE this set: it shows its transcript but
   * does not connect, so opening the canvas cannot spawn one agent process per
   * remembered card. The card promotes itself on the first interaction.
   */
  liveSurfaces: ReadonlySet<string>
  activateSurface: (contextKey: string) => void
  /**
   * Expand a MEMBER card: it leaves the region through the normal detach
   * gesture first (a detail surface can't live in the uniform grid), and the
   * resulting pinned card is what opens.
   */
  detachMember: (
    regionDbId: number,
    conversationId: number,
    opts?: { expand?: boolean }
  ) => Promise<void>
  /** Drop a conversation from a custom region without pinning it anywhere. */
  removeMember: (regionDbId: number, conversationId: number) => Promise<void>
  /**
   * Conversation ids currently selected on the canvas — every card showing one
   * of these lights a mirror ring, which is what makes "the same conversation
   * in several regions" legible at a glance.
   */
  selectedConversationIds: ReadonlySet<number>
  /** The custom region a dragged card is currently hovering, if any. */
  dropTargetRegionId: number | null
  /** The region whose title is being edited inline (rename is triggered from
   *  the action dock; the region owns the input). */
  renamingRegionId: number | null
  setRenamingRegionId: (regionDbId: number | null) => void
  /** Patch a DB node (rename, color, collapse, grid shape, note text, members). */
  patchNode: (nodeId: number, patch: CanvasNodePatchInput) => Promise<void>
  /**
   * Commit a NodeResizer gesture: persist the final geometry, then clear the
   * transient position/size overlays the resize fed (resizes never get a
   * dragStop, so without this the overlays would pin the node forever).
   */
  endNodeResize: (
    nodeId: number,
    geometry: { x: number; y: number; width: number; height: number }
  ) => void
  deleteNode: (nodeId: number) => Promise<void>
  /** Leave the canvas and open the conversation in the workspace. */
  openConversation: (conversation: DbConversationSummary, pin: boolean) => void
  /**
   * Show a conversation in the side panel: the whole conversation, without
   * giving it board space or (for a region member) taking it out of its region,
   * which expanding in place has to do first.
   */
  openConversationDrawer: (conversationId: number) => void
  /**
   * The ACP connection key a pinned card's live surface must use. Normally
   * derived from the node id, but a card that grew out of a draft INHERITS the
   * draft's key so the swap is invisible to the connection layer (the draft is
   * mid-prompt at that moment). Stable for the card's lifetime.
   */
  contextKeyForPin: (pinDbId: number) => string
  /** The connection key an unsent draft card uses. */
  draftSurfaceKey: (draftId: string) => string
  /** Keep a passage selected in a card's transcript as a note beside it. */
  saveSelectionAsNote: (pinDbId: number, text: string) => Promise<void>
  /**
   * Throw away an unsent draft card (client-local, nothing to delete). Refuses
   * once the draft's first send is in flight — see `sendingDrafts`.
   */
  dismissDraft: (draftId: string) => void
  /** Drafts whose first send is creating its conversation row right now; their
   *  discard controls hide rather than sit there doing nothing. */
  sendingDrafts: ReadonlySet<string>
  setDraftSending: (draftId: string, sending: boolean) => void
  /** Switch a draft's agent before its first message. */
  setDraftAgent: (draftId: string, agentType: AgentType) => void
  /** Switch a draft's target folder (or chat mode) before its first message. */
  setDraftTarget: (draftId: string, target: NewConversationTarget) => void
  /** Colour a draft. Held on the local draft — it has no row yet — and handed
   *  to the row its first send creates. Empty string clears it. */
  setDraftColor: (draftId: string, color: string) => void
  /** The draft's first send created a row: persist the card in its place. */
  materializeDraft: (draftId: string, conversationId: number) => Promise<void>
}

const CanvasViewContext = createContext<CanvasViewContextValue | null>(null)

export const CanvasViewProvider = CanvasViewContext.Provider

export function useCanvasView(): CanvasViewContextValue {
  const ctx = useContext(CanvasViewContext)
  if (!ctx) {
    throw new Error("useCanvasView must be used within the canvas view")
  }
  return ctx
}
