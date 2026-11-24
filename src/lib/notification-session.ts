import { formatConversationTitle } from "@/lib/conversation-title"
import type { NotifyPayload } from "@/lib/desktop-notification"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"
import { useTabStore } from "@/stores/tab-store"

/**
 * Which session an OS notification is about, in words a user recognises.
 *
 * A notification used to be titled with the window's ACTIVE folder — not the
 * folder of the session that raised it — and to name only the agent, so with
 * several sessions running an "<agent> needs permission" notification pointed
 * at none of them in particular, and could name the wrong folder outright.
 *
 * The connection's context key is its tab id. From the tab we reach the
 * persisted conversation (its title, its own folder), falling back to the
 * tab's label for a draft that has no row yet.
 *
 * A key no tab owns is reached through the conversation its connection serves
 * instead. That is not only a canvas card: closing a tab whose agent is still
 * busy keeps its connection (see `shouldDisconnectOnUnmount`), so the turn
 * that finishes in the background — exactly when a notification is the only
 * way to learn of it — arrives under a tab id that no longer exists. A
 * connection with no known conversation (a delegated sub-agent's own
 * connection) keeps the old active-folder title.
 */
function describeNotificationSession(
  contextKey: string,
  connectionConversationId: number | null | undefined,
  activeFolderName: string | null | undefined
): { sessionTitle: string | null; folderName: string | null } {
  const workspace = useAppWorkspaceStore.getState()
  const tab = useTabStore.getState().tabs.find((t) => t.id === contextKey)

  let conversationId = tab ? tab.conversationId : connectionConversationId
  // The runtime session learns the row id on the first send, which can be
  // before the draft's tab is bound to it.
  if (tab && conversationId == null && tab.runtimeConversationId != null) {
    conversationId =
      useConversationRuntimeStore
        .getState()
        .byConversationId.get(tab.runtimeConversationId)?.dbConversationId ??
      null
  }
  const conversation =
    conversationId != null
      ? workspace.conversations.find((c) => c.id === conversationId)
      : undefined
  if (!tab && !conversation) {
    return { sessionTitle: null, folderName: activeFolderName || null }
  }

  // `allFolders`, not `folders`: a chat-mode conversation lives in a hidden
  // folder the sidebar's list leaves out. A chat draft has no folder at all,
  // and then no folder is named rather than the active one.
  const folderId = conversation?.folder_id ?? tab?.folderId
  const folder = workspace.allFolders.find((f) => f.id === folderId)

  return {
    sessionTitle:
      formatConversationTitle(conversation?.title).trim() ||
      tab?.title.trim() ||
      null,
    folderName: folder?.alias || folder?.name || null,
  }
}

/**
 * Build an event notification that says which session it is about: the
 * session's title as the notification title, its folder ahead of the message.
 *
 * `connectionConversationId` is the persisted conversation the connection
 * serves, as far as the caller knows it — consulted only when no tab owns
 * `contextKey`.
 *
 * With "hide notification contents" on, it reads as it always did —
 * `<folder> - Codeg` over the message alone — except that the folder is the
 * session's own. A session title is the user's own words (often the first
 * line of their prompt), exactly what that setting exists to keep out of the
 * notification centre.
 */
export function sessionNotificationPayload(
  contextKey: string,
  connectionConversationId: number | null | undefined,
  activeFolderName: string | null | undefined,
  content: { body: string; redactedBody?: string }
): NotifyPayload {
  const { sessionTitle, folderName } = describeNotificationSession(
    contextKey,
    connectionConversationId,
    activeFolderName
  )
  const folderTitle = folderName ? `${folderName} - Codeg` : "Codeg"
  if (!sessionTitle) return { title: folderTitle, ...content }
  return {
    title: sessionTitle,
    redactedTitle: folderTitle,
    // The title no longer names the folder, so the body does — except in the
    // redacted form, whose title names it again.
    body: folderName ? `${folderName} · ${content.body}` : content.body,
    redactedBody: content.redactedBody ?? content.body,
  }
}
