import type { DbConversationDetail } from "@/lib/types"
import {
  isTurnFailureCode,
  routeAcpError,
  type AcpErrorLevel,
} from "@/lib/acp-error-presentation"
import { resolveVisibleConversationError } from "@/lib/conversation-error"

export interface PersistedConversationErrorAlert {
  /** Reuses the live event's Alerts key when its connection is known. */
  key: string
  /** One claim per DB revision even when repeated errors share a live key. */
  revisionKey: string
  /** Turn-failure notifications use a per-turn serial, so match their family. */
  liveTurnFailurePrefix: string | null
  level: AcpErrorLevel
  message: string
}

export function selectPersistedConversationErrorAlert({
  conversationId,
  detail,
  liveError,
  status,
  retiredRevision,
}: {
  conversationId: number | null
  detail: DbConversationDetail | null
  liveError: string | null
  status: string | null
  retiredRevision: number | null
}): PersistedConversationErrorAlert | null {
  if (
    conversationId == null ||
    detail?.summary.id !== conversationId ||
    liveError
  ) {
    return null
  }
  const message = resolveVisibleConversationError(
    null,
    status,
    detail,
    retiredRevision
  )
  if (!message) return null

  const code = detail.last_error?.code
  const rawMessage = detail.last_error?.message ?? message
  const route = routeAcpError(code)
  // Action verdicts answer a past click; upstream never hydrates them into
  // standing session state. Transcript errors already have their own card.
  if (route.kind !== "session") return null

  const revisionKey = `persisted-acp-error:${conversationId}:${detail.last_error_revision ?? 0}`
  const connectionId = detail.last_error_connection_id
  const liveTurnFailurePrefix =
    connectionId && isTurnFailureCode(code)
      ? `acp-turn-failure:${connectionId}:`
      : null
  const key =
    connectionId && !liveTurnFailurePrefix
      ? `acp-error:${connectionId}:${code || rawMessage}`
      : revisionKey
  return {
    key,
    revisionKey,
    liveTurnFailurePrefix,
    level: route.level,
    message,
  }
}

/** Shared across mounted views so opening the same history in another tab
 * does not replay its recovered alert. A new revision can still be shown. */
export class PersistedConversationErrorAlertTracker {
  private readonly seen = new Set<string>()
  private readonly liveKeys = new Set<string>()

  markLiveKey(key: string): void {
    this.liveKeys.delete(key)
    this.liveKeys.add(key)
    // A session can stay open indefinitely; retain recent notifications only.
    if (this.liveKeys.size > 512) {
      this.liveKeys.delete(this.liveKeys.values().next().value!)
    }
  }

  wasLiveNotified(alert: PersistedConversationErrorAlert): boolean {
    if (this.liveKeys.has(alert.key)) return true
    const prefix = alert.liveTurnFailurePrefix
    return (
      prefix !== null &&
      [...this.liveKeys].some((key) => key.startsWith(prefix))
    )
  }

  claim(revisionKey: string): boolean {
    if (this.seen.has(revisionKey)) return false
    this.seen.add(revisionKey)
    return true
  }
}

export const persistedConversationErrorAlertTracker =
  new PersistedConversationErrorAlertTracker()
