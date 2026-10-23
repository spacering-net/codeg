/**
 * "Rename the current session" hand-off from the floating ball. The header
 * that owns the rename dialog is mounted per conversation tab, so the signal
 * carries the DB id and each instance compares it against its own — a tab
 * whose conversation does not match ignores the event (multi-tab safe, same
 * idiom as task-compose-events but synchronous: the header stays mounted).
 */

export const RENAME_CONVERSATION_EVENT = "codeg:rename-conversation"

export interface RenameConversationDetail {
  conversationId: number
}

export function requestRenameConversation(detail: RenameConversationDetail) {
  window.dispatchEvent(new CustomEvent(RENAME_CONVERSATION_EVENT, { detail }))
}
