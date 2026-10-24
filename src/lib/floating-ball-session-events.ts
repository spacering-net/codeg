/**
 * Floating-ball hand-off events for actions that must run inside a mounted
 * conversation view (which owns the mode selector, pin state and the delete
 * confirm dialog). Each event carries the DB conversation id and each
 * per-tab instance compares it against its own — a tab whose conversation
 * does not match ignores the event (multi-tab safe, same idiom as
 * rename-conversation-events but synchronous).
 */

export const DELETE_CONVERSATION_EVENT = "codeg:fb-delete-conversation"
export const FOCUS_MODE_SELECTOR_EVENT = "codeg:fb-focus-mode-selector"
export const TOGGLE_PLAN_FULL_EVENT = "codeg:fb-toggle-plan-full"

export interface FloatingBallSessionDetail {
  conversationId: number | null
}

function dispatch(type: string, conversationId: number | null) {
  window.dispatchEvent(
    new CustomEvent(type, {
      detail: { conversationId } satisfies FloatingBallSessionDetail,
    })
  )
}

/** Open the delete confirmation for the current session (header-owned UI). */
export function requestDeleteConversation(conversationId: number | null) {
  dispatch(DELETE_CONVERSATION_EVENT, conversationId)
}

/** Focus/open the composer's inline mode selector on the active tab. */
export function requestFocusModeSelector(conversationId: number | null) {
  dispatch(FOCUS_MODE_SELECTOR_EVENT, conversationId)
}

/** Switch the active session between Plan and full-access mode. */
export function requestTogglePlanFull(conversationId: number | null) {
  dispatch(TOGGLE_PLAN_FULL_EVENT, conversationId)
}

/** True when the event targets this instance's conversation (null = drafts). */
export function eventMatchesConversation(
  detail: FloatingBallSessionDetail | undefined,
  conversationId: number | null
): boolean {
  return detail?.conversationId === conversationId
}
