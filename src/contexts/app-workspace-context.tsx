"use client"

import { useEffect, type ReactNode } from "react"
import { getGitHead } from "@/lib/api"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import { useAcpEvent } from "@/contexts/acp-connections-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"
import { useTabStore } from "@/stores/tab-store"
import {
  CONVERSATIONS_BULK_CHANGED_EVENT,
  CONVERSATION_CHANGED_EVENT,
  FOLDER_CHANGED_EVENT,
  FOLDER_GROUP_CHANGED_EVENT,
  type ConversationChange,
  type ConversationsBulkChanged,
  type EventEnvelope,
  type FolderChange,
  type FolderGroupChange,
} from "@/lib/types"

interface AppWorkspaceProviderProps {
  children: ReactNode
}

/**
 * On a cross-client `conversation://changed` nudge, poll the persisted detail of
 * a conversation THIS client is passively viewing back into sync (its just-
 * completed reply, streamed to whoever owns the agent, isn't on our live path).
 * The runtime store no-ops unless the conversation is open and this client is a
 * pure viewer of it — the owner's in-memory reply is never refetched over.
 */
function syncOpenViewerDetail(conversationId: number): void {
  useConversationRuntimeStore
    .getState()
    .actions.syncViewerDetail(conversationId)
}

/**
 * Event wiring for `useAppWorkspaceStore` — state itself lives in the store
 * (components subscribe to slices via selectors, not through a context value).
 * This component owns the pieces that need a React lifecycle: initial fetches,
 * the cross-client side-channel subscriptions, and the active-folder branch
 * poll.
 */
export function AppWorkspaceProvider({ children }: AppWorkspaceProviderProps) {
  useEffect(() => {
    const { fetchFolders, refreshConversations } =
      useAppWorkspaceStore.getState()
    void fetchFolders()
    void refreshConversations()
  }, [])

  // Subscribe to the global `conversation://changed` side-channel so any
  // client's create/rename/delete/status reaches this client's sidebar in real
  // time — independent of whether the conversation is open/attached anywhere.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void (async () => {
      const dispose = await subscribe<ConversationChange>(
        CONVERSATION_CHANGED_EVENT,
        (change) => {
          const store = useAppWorkspaceStore.getState()
          if (change.kind === "upsert") {
            store.applyConversationUpsert(change.summary)
            // This side-channel keeps the sidebar in sync but does NOT touch an
            // open conversation's detail. If THIS client is only viewing that
            // conversation (another client owns the live agent), a turn that
            // just completed there has no live promotion path here — so pull the
            // reply from the persisted transcript. No-op unless the conversation
            // is open and this client is a pure viewer of it.
            syncOpenViewerDetail(change.summary.id)
          } else if (change.kind === "deleted") {
            store.applyConversationRemove(change.id)
          } else {
            store.updateConversationLocal(change.id, {
              status: change.status,
            })
            syncOpenViewerDetail(change.id)
          }
        }
      )
      if (disposed) dispose()
      else unlisten = dispose
    })()

    // Events fired while the WS was disconnected are dropped by the broadcaster
    // (receiver_count == 0). A full re-fetch on reconnect reconciles. Returns
    // null on desktop IPC (no disconnect window) → no-op there.
    const offReconnect = onTransportReconnect(() => {
      void useAppWorkspaceStore.getState().refreshConversations()
    })

    return () => {
      disposed = true
      unlisten?.()
      offReconnect?.()
    }
  }, [])

  // A batch import (the import-picker window, possibly a different window than
  // this one) announces completion with ONE `conversations://bulk-changed`
  // nudge instead of per-row upserts; answer it with a single full refetch.
  // Folder creations arrive separately on `folder://changed` below.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void (async () => {
      const dispose = await subscribe<ConversationsBulkChanged>(
        CONVERSATIONS_BULK_CHANGED_EVENT,
        () => {
          void useAppWorkspaceStore.getState().refreshConversations()
        }
      )
      if (disposed) dispose()
      else unlisten = dispose
    })()

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // Subscribe to the global `folder://changed` side-channel so a folder created
  // headlessly (e.g. an automation per-run worktree) lands in this client's
  // workspace list in real time — without it, a conversation produced in that
  // worktree has no known folder to group under and never renders in the sidebar.
  // `deleted` closes the loop: a task worktree removed after its merge vanishes
  // from the sidebar right away instead of lingering until the next reload.
  // Only syncs the list (+ seeds branches); unlike WorkspaceOpenFolderListener
  // it never opens/focuses a tab, so a background emitter can't steal focus.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void (async () => {
      const dispose = await subscribe<FolderChange>(
        FOLDER_CHANGED_EVENT,
        (change) => {
          const store = useAppWorkspaceStore.getState()
          if (change.kind === "upsert") {
            store.upsertFolder(change.folder)
            // Only seed the branch when the event actually carries one. A
            // freshly-minted worktree row stores `git_branch: null` (resolved
            // later by git-head detection), and re-broadcasting an existing root
            // must not clobber its already-known in-memory branch with null.
            if (change.folder.git_branch) {
              store.setBranch(change.folder.id, change.folder.git_branch)
            }
          } else if (change.kind === "deleted") {
            // A folder that stops existing takes its tabs with it — the same
            // pairing the sidebar's own "remove folder" makes (it calls
            // `closeTabsByFolder` before the API). The backend drops this
            // folder's PERSISTED tabs and broadcasts that snapshot, but drafts
            // are device-local and never reach it: without this, a draft opened
            // in the worktree stays on screen pointing at a cwd that no longer
            // exists (`pruneOrphanDraftsOnce` would only clean it up on the next
            // launch). Closing retargets `activeTabId`, which TabProvider syncs
            // back into `activeFolderId`.
            useTabStore.getState().closeTabsByFolder(change.id)
            store.applyFolderRemove(change.id)
          }
        }
      )
      if (disposed) dispose()
      else unlisten = dispose
    })()

    // A folder created while the WS was disconnected is dropped by the
    // broadcaster (receiver_count == 0); a full folder re-fetch on reconnect
    // reconciles. Returns null on desktop IPC (no disconnect window) → no-op.
    const offReconnect = onTransportReconnect(() => {
      void useAppWorkspaceStore.getState().fetchFolders()
    })

    return () => {
      disposed = true
      unlisten?.()
      offReconnect?.()
    }
  }, [])

  // Sidebar folder groups are edited in one window but rendered in every client,
  // so a rename / recolor / delete has to reach them all. Group CRUD carries its
  // detail and is applied in place; a `layout` nudge carries nothing by design
  // (one drag rewrites `group_id`/`sort_order` across every visible folder) and
  // is answered with a re-read. That re-read is silent — nothing renders
  // `foldersLoading` — and it also lands on the client that STARTED the change,
  // which is deliberate: it converges the optimistic patch on server truth at
  // the cost of one local query per gesture, instead of needing an origin tag to
  // tell an echo from a peer's edit.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void (async () => {
      const dispose = await subscribe<FolderGroupChange>(
        FOLDER_GROUP_CHANGED_EVENT,
        (change) => {
          useAppWorkspaceStore.getState().applyFolderGroupChange(change)
        }
      )
      if (disposed) dispose()
      else unlisten = dispose
    })()

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // Branch polling: only poll the active folder. Subscribes to the resolved
  // path (a primitive) rather than `allFolders`, so folder-list churn doesn't
  // restart the poll — only an actual active-folder change does.
  const activeFolderId = useAppWorkspaceStore((s) => s.activeFolderId)
  const activeFolderPath = useAppWorkspaceStore((s) =>
    s.activeFolderId == null
      ? null
      : (s.allFolders.find((f) => f.id === s.activeFolderId)?.path ?? null)
  )
  useEffect(() => {
    if (activeFolderId == null || activeFolderPath == null) return
    const folderId = activeFolderId

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      try {
        const head = await getGitHead(activeFolderPath)
        if (cancelled) return
        useAppWorkspaceStore.getState().applyGitHead(folderId, head)
        // Poll a repo briskly to catch branch switches; back off otherwise.
        const delay = head.is_repo ? 10_000 : 60_000
        timer = setTimeout(poll, delay)
      } catch {
        if (!cancelled) {
          timer = setTimeout(poll, 60_000)
        }
      }
    }

    void poll()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [activeFolderId, activeFolderPath])

  return <>{children}</>
}

/**
 * Bridges backend `conversation_status_changed` events into the workspace's
 * local conversations list. The DB row is already updated by the backend
 * before this event fires, so this only patches the in-memory summary.
 *
 * Must be rendered inside `AcpConnectionsProvider` (for `useAcpEvent`).
 */
export function ConversationStatusEventBridge() {
  useAcpEvent((envelope: EventEnvelope) => {
    if (envelope.type !== "conversation_status_changed") return
    useAppWorkspaceStore
      .getState()
      .updateConversationLocal(envelope.conversation_id, {
        status: envelope.status,
      })
  })
  return null
}
