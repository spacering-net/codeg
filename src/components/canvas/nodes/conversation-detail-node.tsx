"use client"

import { memo, useCallback } from "react"
import { type Node, type NodeProps } from "@xyflow/react"
import { Minimize2, X } from "lucide-react"
import { useTranslations } from "next-intl"
import { AgentIcon } from "@/components/agent-icon"
import { ConversationStatusDot } from "@/components/conversations/conversation-status-dot"
import { formatConversationTitle } from "@/lib/conversation-title"
import type { AgentType, ConversationStatus } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  CanvasConversationSurface,
  type CanvasDraftTarget,
} from "../canvas-conversation-surface"
import {
  type ConversationCardData,
  type NewConversationTarget,
} from "../canvas-model"
import { useCanvasView } from "../canvas-view-context"
import { CARD_HEADER_BUTTON_CLASS, CardFrame } from "./card-frame"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

export type ConversationDetailFlowNode = Node<
  ConversationCardData,
  "conversationDetail"
>

export interface ConversationDraftData {
  draftId: string
  target: NewConversationTarget
  agentType: AgentType
  /** Set before the card has a row of its own; the send that mints the row
   *  carries it over, so the colour outlives the draft. */
  color?: string | null
  [key: string]: unknown
}

export type ConversationDraftFlowNode = Node<
  ConversationDraftData,
  "conversationDraft"
>

/**
 * A pinned conversation card expanded into a live conversation: transcript,
 * composer and streaming reply, right on the board. The card owns a STABLE
 * connection key derived from its DB node id, so re-renders never re-key the
 * connection and a workspace tab on the same conversation stays a separate
 * surface that attaches to the same agent.
 */
export const ConversationDetailNode = memo(function ConversationDetailNode({
  data,
  selected,
}: NodeProps<ConversationDetailFlowNode>) {
  const t = useTranslations("Canvas")
  const {
    setCardDetail,
    endNodeResize,
    contextKeyForPin,
    liveSurfaces,
    activateSurface,
    saveSelectionAsNote,
  } = useCanvasView()
  const conversation = data.conversation
  const pinDbId = data.pinDbId
  // Bound to this card before the early return so the identity only changes
  // when the card does — `MessageListView` keeps it across renders.
  const saveAsNote = useCallback(
    (text: string) => {
      if (pinDbId != null) void saveSelectionAsNote(pinDbId, text)
    },
    [saveSelectionAsNote, pinDbId]
  )

  if (!conversation || pinDbId == null) return null

  const contextKey = contextKeyForPin(pinDbId)
  const live = liveSurfaces.has(contextKey)
  const status = conversation.status as ConversationStatus
  return (
    <CardFrame
      selected={selected}
      color={data.color}
      onActivate={live ? undefined : () => activateSurface(contextKey)}
      icon={
        <>
          <AgentIcon
            agentType={conversation.agent_type}
            className="size-3.5 shrink-0"
          />
          <ConversationStatusDot
            status={status}
            size="sm"
            className={cn(
              status === "in_progress" && "motion-safe:animate-pulse"
            )}
          />
        </>
      }
      title={
        conversation.title
          ? formatConversationTitle(conversation.title)
          : t("untitled")
      }
      actions={
        <button
          type="button"
          className={CARD_HEADER_BUTTON_CLASS}
          aria-label={t("collapseConversation")}
          title={t("collapseConversation")}
          onClick={() => setCardDetail(pinDbId, false)}
        >
          <Minimize2 className="size-3.5" />
        </button>
      }
      onResizeEnd={(geometry) => endNodeResize(pinDbId, geometry)}
    >
      <CanvasConversationSurface
        contextKey={contextKey}
        conversationId={conversation.id}
        agentType={conversation.agent_type}
        isActive={live}
        onSaveSelectionAsNote={saveAsNote}
        // A bound conversation shows its OWN folder and can't be moved — the
        // same rule a tab follows once it has a conversation.
        folderPickerOverride={{
          folderId: conversation.folder_id,
          editable: false,
          onSelectFolder: () => {},
          onSelectChatMode: () => {},
        }}
      />
    </CardFrame>
  )
})

/**
 * An unsent conversation. Client-local until the first message: the row, and
 * the canvas node that pins it, are both created by that send (see
 * `materializeDraft`), so an abandoned draft leaves nothing behind — the same
 * contract draft TABS have with `opened_tabs`.
 */
export const ConversationDraftNode = memo(function ConversationDraftNode({
  data,
  selected,
}: NodeProps<ConversationDraftFlowNode>) {
  const t = useTranslations("Canvas")
  const {
    dismissDraft,
    sendingDrafts,
    setDraftSending,
    setDraftAgent,
    setDraftTarget,
    materializeDraft,
    draftSurfaceKey,
    liveSurfaces,
    activateSurface,
  } = useCanvasView()
  const target = data.target
  const contextKey = draftSurfaceKey(data.draftId)
  const live = liveSurfaces.has(contextKey)
  const creating = sendingDrafts.has(data.draftId)
  const targetFolderId = "folderId" in target ? target.folderId : null
  const folderPath = useAppWorkspaceStore((s) =>
    targetFolderId != null
      ? (s.allFolders.find((f) => f.id === targetFolderId)?.path ?? null)
      : null
  )

  const draftTarget: CanvasDraftTarget =
    targetFolderId != null
      ? {
          kind: "folder",
          folderId: targetFolderId,
          workingDir: folderPath ?? "",
        }
      : { kind: "chat" }

  return (
    <CardFrame
      selected={selected}
      color={data.color}
      onActivate={live ? undefined : () => activateSurface(contextKey)}
      icon={
        <AgentIcon agentType={data.agentType} className="size-3.5 shrink-0" />
      }
      title={t("newConversation")}
      actions={
        // Gone, not disabled, while the first send is creating the row: there
        // is nothing left to discard once the conversation exists and the
        // prompt is on its way, and a dead-looking button invites the click
        // that used to strand both.
        creating ? null : (
          <button
            type="button"
            className={CARD_HEADER_BUTTON_CLASS}
            aria-label={t("discardDraft")}
            title={t("discardDraft")}
            onClick={() => dismissDraft(data.draftId)}
          >
            <X className="size-3.5" />
          </button>
        )
      }
    >
      <CanvasConversationSurface
        contextKey={contextKey}
        conversationId={null}
        agentType={data.agentType}
        isActive={live}
        onCreatingChange={(sending) => setDraftSending(data.draftId, sending)}
        // Unsent: switching folder just re-points where the first message will
        // go, so the chip stays live right up until the send.
        folderPickerOverride={{
          folderId: targetFolderId,
          editable: true,
          onSelectFolder: (folderId) =>
            setDraftTarget(data.draftId, { folderId }),
          onSelectChatMode: () => setDraftTarget(data.draftId, { chat: true }),
        }}
        onAgentTypeChange={(agentType) =>
          setDraftAgent(data.draftId, agentType)
        }
        draftTarget={draftTarget}
        onConversationCreated={(conversationId) =>
          void materializeDraft(data.draftId, conversationId)
        }
      />
    </CardFrame>
  )
})
