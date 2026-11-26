"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Unlink } from "lucide-react"
import { AgentIcon } from "@/components/agent-icon"
import { CanvasConversationSurface } from "@/components/canvas/canvas-conversation-surface"
import { ConversationStatusDot } from "@/components/conversations/conversation-status-dot"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  SIDE_PANEL_CONTENT_CLASS,
} from "@/components/ui/drawer"
import { useAcpActions } from "@/contexts/acp-connections-context"
import { useTabStore } from "@/contexts/tab-context"
import { useLinkedConversations } from "@/hooks/use-ask-conversations"
import { createAskConversation } from "@/lib/api"
import { formatConversationTitle } from "@/lib/conversation-title"
import { subscribe } from "@/lib/platform"
import {
  CONVERSATION_CHANGED_EVENT,
  type AgentType,
  type ConversationChange,
  type ConversationStatus,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  useAskConversationDrawerStore,
  type AskConversationDrawerTarget,
} from "@/stores/ask-conversation-drawer-store"
import { useDetachAskConversation } from "./use-detach-ask-conversation"

/** Where the drawer's surfaces register their connection key, so the idle
 *  sweep leaves the agent of the ask on show alone. */
const LIVE_SURFACE_SOURCE = "ask-drawer"

/**
 * The ask conversation side drawer: an ask conversation ("ask about this
 * selection"), live — transcript, composer, prompts — beside the conversation
 * it was asked from. Opened by sending a new ask from the selection bubble, or
 * from the ask list in Session Details. A check conversation — the personal
 * agent checking a message ("is this right?") — opens here the same way, from
 * the check list in Session Details or the check's mark under the message.
 *
 * The conversation runs on the canvas's tab-less surface
 * (`CanvasConversationSurface`), not in a tab — the user stays on the
 * conversation it was asked from (opening the ask from the sidebar, where it
 * nests under that conversation, gives it a tab of its own). A new ask's
 * surface creates the row on its first send — under the main conversation —
 * and sends the message the bubble composed as soon as its agent is
 * connected.
 *
 * Mounted once, by the conversation panel; what it shows lives in
 * `useAskConversationDrawerStore`.
 */
export function AskConversationDrawer() {
  const t = useTranslations("Folder.askConversations")
  const target = useAskConversationDrawerStore((s) => s.target)
  const close = useAskConversationDrawerStore((s) => s.close)
  const { registerLiveSurfaceKeys, setActiveKey } = useAcpActions()
  const contextKey = target?.contextKey ?? null
  const conversationId = target?.conversationId ?? null

  useEffect(() => {
    if (!contextKey) return
    registerLiveSurfaceKeys(LIVE_SURFACE_SOURCE, new Set([contextKey]))
    return () => {
      registerLiveSurfaceKeys(LIVE_SURFACE_SOURCE, new Set())
      // The surface took the active connection key while it was open, and its
      // unmount releases it; give it back to the tab the user returns to (its
      // own claim only re-runs when it next becomes active).
      const activeTabId = useTabStore.getState().activeTabId
      window.setTimeout(() => {
        if (
          activeTabId &&
          useAskConversationDrawerStore.getState().target == null
        )
          setActiveKey(activeTabId)
      }, 0)
    }
  }, [contextKey, registerLiveSurfaceKeys, setActiveKey])

  // A deleted ask takes its drawer down with it.
  useEffect(() => {
    if (conversationId == null) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const dispose = await subscribe<ConversationChange>(
        CONVERSATION_CHANGED_EVENT,
        (change) => {
          if (change.kind !== "deleted" || change.id !== conversationId) return
          const current = useAskConversationDrawerStore.getState().target
          if (current?.conversationId === conversationId) {
            useAskConversationDrawerStore.getState().close()
          }
        }
      )
      if (disposed) dispose()
      else unlisten = dispose
    })()
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [conversationId])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !close()) toast.warning(t("pendingFirstMessage"))
    },
    [close, t]
  )

  return (
    <Drawer
      open={target != null}
      onOpenChange={handleOpenChange}
      swipeDirection="right"
    >
      <DrawerContent
        closeButtonClassName="top-2.5 right-3"
        className={SIDE_PANEL_CONTENT_CLASS}
      >
        {target ? (
          <AskDrawerBody key={target.contextKey} target={target} />
        ) : (
          // The drawer animates out after `target` is gone; keep its
          // accessible name through that.
          <>
            <DrawerTitle className="sr-only">{t("drawerTitle")}</DrawerTitle>
            <DrawerDescription className="sr-only">
              {t("drawerDescription")}
            </DrawerDescription>
          </>
        )}
      </DrawerContent>
    </Drawer>
  )
}

function AskDrawerBody({ target }: { target: AskConversationDrawerTarget }) {
  const t = useTranslations("Folder.askConversations")
  const tCheck = useTranslations("Folder.checkConversations")
  const setCreated = useAskConversationDrawerStore((s) => s.setCreated)
  const consumeInitialSend = useAskConversationDrawerStore(
    (s) => s.consumeInitialSend
  )
  const setCreating = useAskConversationDrawerStore((s) => s.setCreating)
  const {
    contextKey,
    kind,
    parentConversationId,
    conversationId,
    agentType,
    folderId,
    workingDir,
  } = target
  // Fixed at mount: the surface pins its runtime session to the id it mounted
  // with (a new ask streams under a draft id), and the row its first send
  // creates must not re-key it. Same for the first message, which the surface
  // reads once.
  const [mountConversationId] = useState(conversationId)
  const [initialSend] = useState(target.initialSend)

  const asks = useLinkedConversations(parentConversationId, kind)
  const listed =
    conversationId != null
      ? asks?.find((row) => row.id === conversationId)
      : undefined
  // Unlinked while on show, the conversation is a root of the workspace list
  // instead.
  const unlinked = useAppWorkspaceStore((s) =>
    conversationId != null
      ? (s.conversations.find((row) => row.id === conversationId) ?? null)
      : null
  )
  const summary = listed ?? unlinked ?? null
  const status = summary?.status as ConversationStatus | undefined
  const title = summary?.title ? formatConversationTitle(summary.title) : ""
  const detach = useDetachAskConversation()

  const runFolderId = summary?.folder_id ?? folderId
  // The ask runs in its folder (a new one in the main conversation's, which is
  // where the backend creates it); `draftTarget` is also how the surface finds
  // that folder for a row the workspace list doesn't carry.
  const draftTarget = useMemo(
    () => ({
      kind: "folder" as const,
      folderId: runFolderId,
      workingDir: workingDir ?? "",
    }),
    [runFolderId, workingDir]
  )
  // An ask shows its own folder and can't be moved — the same rule a bound
  // tab follows.
  const folderPickerOverride = useMemo(
    () => ({
      folderId: runFolderId,
      editable: false,
      onSelectFolder: () => {},
      onSelectChatMode: () => {},
    }),
    [runFolderId]
  )
  const createDraftConversation = useCallback(
    // Filed in the folder this surface's agent is running in, whatever the
    // main conversation has done since. The row may land under another
    // conversation than the one passed (asked from an ask, it goes under
    // that ask's main conversation): the drawer follows it there, so its
    // header finds the row in the right ask list.
    async (agent: AgentType, seed: string | undefined) => {
      const created = await createAskConversation(
        parentConversationId,
        runFolderId,
        agent,
        seed
      )
      setCreated(
        contextKey,
        created.conversationId,
        created.parentConversationId
      )
      return created
    },
    [contextKey, parentConversationId, runFolderId, setCreated]
  )
  const handleInitialSendConsumed = useCallback(
    () => consumeInitialSend(contextKey),
    [consumeInitialSend, contextKey]
  )
  const handleCreatingChange = useCallback(
    (creating: boolean) => setCreating(contextKey, creating),
    [contextKey, setCreating]
  )
  // A surface leaving mid-send (the user discarded it) must not leave the
  // drawer thinking a send is still in flight.
  useEffect(
    () => () => setCreating(contextKey, false),
    [contextKey, setCreating]
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* `pr-12` clears the close button; the unlink action sits just inside
          it, so the two read as one cluster. */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5 pr-12">
        <AgentIcon agentType={agentType} className="size-4 shrink-0" />
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
          {title || (kind === "check" ? tCheck("untitled") : t("untitled"))}
        </DrawerTitle>
        <DrawerDescription className="sr-only">
          {kind === "check"
            ? tCheck("drawerDescription")
            : t("drawerDescription")}
        </DrawerDescription>
        {listed && (
          <button
            type="button"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            aria-label={t("convertToRegular")}
            title={t("convertToRegular")}
            onClick={() => detach(listed.id)}
          >
            <Unlink className="size-4" />
          </button>
        )}
      </div>
      <CanvasConversationSurface
        contextKey={contextKey}
        conversationId={mountConversationId}
        agentType={agentType}
        draftTarget={draftTarget}
        createDraftConversation={createDraftConversation}
        initialSend={initialSend}
        onInitialSendConsumed={handleInitialSendConsumed}
        onCreatingChange={handleCreatingChange}
        folderPickerOverride={folderPickerOverride}
        checksOpenInDrawer
        isActive
        className="min-h-0 flex-1"
      />
    </div>
  )
}
