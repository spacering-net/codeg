"use client"

import { ExternalLink } from "lucide-react"
import { useTranslations } from "next-intl"
import { AgentIcon } from "@/components/agent-icon"
import { ConversationStatusDot } from "@/components/conversations/conversation-status-dot"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  SIDE_PANEL_CONTENT_CLASS,
} from "@/components/ui/drawer"
import { formatConversationTitle } from "@/lib/conversation-title"
import type { ConversationStatus, DbConversationSummary } from "@/lib/types"
import { cn } from "@/lib/utils"
import { CanvasConversationSurface } from "./canvas-conversation-surface"

/**
 * A canvas card's conversation, opened as a side panel instead of on the board.
 *
 * The board's own way of working in a conversation is to expand the card in
 * place, which costs board space and, for a card inside a region, costs it its
 * membership — expanding a member detaches it first. This is the other half:
 * full conversation, nothing moved. Same surface either way
 * (`CanvasConversationSurface`), so composer, mode and config selectors,
 * permission / question / plan prompts all behave identically.
 *
 * Deliberately NOT rendered by the card: ReactFlow culls nodes outside the
 * viewport, so a panel owned by a card would vanish the moment the user panned
 * away from it. `canvas-view` owns the open state and renders this.
 *
 * It is also deliberately NOT in board units — this is chrome portalled to the
 * body, so it follows the appearance zoom like the rest of the app's panels,
 * while the board keeps its own scale (see `canvas-board-units` in globals.css).
 */
interface CanvasConversationDrawerProps {
  /** The conversation on show, or `null` when the panel is closed. Kept by the
   *  view rather than derived here so the header title tracks a rename. */
  conversation: DbConversationSummary | null
  /** Connection key for this panel's surface — minted by the view, which also
   *  registers it as a live surface so the idle sweep leaves its agent alone. */
  contextKey: string | null
  onOpenChange: (open: boolean) => void
  onOpenInWorkspace: () => void
}

export function CanvasConversationDrawer({
  conversation,
  contextKey,
  onOpenChange,
  onOpenInWorkspace,
}: CanvasConversationDrawerProps) {
  const t = useTranslations("Canvas")
  const open = conversation != null && contextKey != null
  const status = conversation?.status as ConversationStatus | undefined

  return (
    <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="right">
      <DrawerContent
        closeButtonClassName="top-2.5 right-3"
        className={SIDE_PANEL_CONTENT_CLASS}
      >
        {conversation && contextKey ? (
          <div className="flex h-full min-h-0 flex-col">
            {/* `pr-12` clears the close button; the workspace link sits just
                inside it, so the two read as one cluster. */}
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 pr-12">
              <AgentIcon
                agentType={conversation.agent_type}
                className="size-4 shrink-0"
              />
              {status && (
                <ConversationStatusDot
                  status={status}
                  size="sm"
                  className={cn(
                    status === "in_progress" && "motion-safe:animate-pulse"
                  )}
                />
              )}
              <DrawerTitle className="min-w-0 flex-1 truncate text-sm font-semibold">
                {conversation.title
                  ? formatConversationTitle(conversation.title)
                  : t("untitled")}
              </DrawerTitle>
              <DrawerDescription className="sr-only">
                {t("detailPanelDescription")}
              </DrawerDescription>
              <button
                type="button"
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                aria-label={t("openInWorkspace")}
                title={t("openInWorkspace")}
                onClick={onOpenInWorkspace}
              >
                <ExternalLink className="size-4" />
              </button>
            </div>
            <CanvasConversationSurface
              // Remount on a different conversation: the surface fixes its
              // runtime session id at mount, so reusing the instance would leave
              // the second conversation streaming into the first one's session.
              key={conversation.id}
              contextKey={contextKey}
              conversationId={conversation.id}
              agentType={conversation.agent_type}
              isActive
              // A bound conversation shows its OWN folder and can't be moved —
              // the same rule a tab and an expanded card follow.
              folderPickerOverride={{
                folderId: conversation.folder_id,
                editable: false,
                onSelectFolder: () => {},
                onSelectChatMode: () => {},
              }}
              className="min-h-0 flex-1"
            />
          </div>
        ) : null}
      </DrawerContent>
    </Drawer>
  )
}
