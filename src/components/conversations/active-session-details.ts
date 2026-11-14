import type {
  DbConversationSummary,
  MessageTurn,
  SessionStats,
} from "@/lib/types"
import type { ConversationRuntimeSession } from "@/contexts/conversation-runtime-context"

/** The slice of an open tab needed to locate its active runtime session. */
export interface ActiveSessionTabRef {
  conversationId: number | null
  /** Virtual (negative) runtime key a new conversation streams under before it
   *  reconciles to its persisted `conversationId`. */
  runtimeConversationId?: number
  /** The live status the tab strip shows — decorated from the workspace list,
   *  or from the child-summary cache for a sub-agent's conversation, which the
   *  list doesn't hold. Both follow the backend's status events. */
  status?: string
}

export interface ActiveSessionDetails {
  summary: DbConversationSummary | null
  stats: SessionStats | null
  model: string | null
}

/**
 * The slice of a runtime session this resolver actually reads. Narrowed on
 * purpose: these fields change only at turn boundaries, so a caller can
 * subscribe to just them (e.g. via `useShallow`) and avoid the ~60/s re-render
 * a whole-session-object selector incurs during streaming. A full
 * `ConversationRuntimeSession` is still assignable here, so existing callers
 * that pass the whole session are unaffected.
 */
export type RuntimeSessionForDetails = Pick<
  ConversationRuntimeSession,
  "detail" | "sessionStats" | "localTurns"
>

/**
 * Pick the conversation's model from its turns. Only assistant turns carry a
 * `model`, and a conversation can switch models mid-session, so the most recent
 * turn with a model is the best "current model" signal. Returns `null` when no
 * turn records one (e.g. before the first assistant reply).
 *
 * This is the reliable source: `DbConversationSummary.model` is only populated
 * for imported conversations, staying `null` for sessions started live in-app.
 */
export function pickModelFromTurns(turns: MessageTurn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) {
    const model = turns[i]?.model
    if (model) return model
  }
  return null
}

/**
 * `summary` with the columns that change while a conversation is open taken
 * from where they are kept current. The loaded detail's summary is a snapshot
 * of when the transcript was fetched, and nothing refreshes it as turns start
 * and end (a completed turn deliberately never refetches), so its `status` —
 * and its `title`, once renamed or auto-titled — would stay what they were
 * when the conversation was opened. The workspace list and the tab follow the
 * backend's status/upsert events. Returns `summary` itself when nothing
 * differs, so a caller comparing by identity sees no change.
 */
function withLiveColumns(
  summary: DbConversationSummary | null,
  listed: DbConversationSummary | null,
  tabStatus: string | undefined
): DbConversationSummary | null {
  if (summary == null) return null
  const status = tabStatus ?? listed?.status ?? summary.status
  const title = listed?.title ?? summary.title
  if (status === summary.status && title === summary.title) return summary
  return { ...summary, status, title }
}

/**
 * Resolve the active conversation tab's summary + live token usage the same way
 * the tab view renders them.
 *
 * A brand-new conversation streams under its virtual `runtimeConversationId`,
 * not the persisted `conversationId`, and its live usage lives on the runtime
 * session's `sessionStats` (its `detail` lags or is absent until a cold load
 * runs). So we key the runtime lookup on `runtimeConversationId ?? conversationId`,
 * read stats from `sessionStats` (falling back to the loaded `detail`), and fall
 * back to the workspace summary so the Session Details dialog can still open
 * before `detail` has loaded. Its status and title are the live ones (see
 * `withLiveColumns`).
 */
export function resolveActiveSessionDetails(
  tab: ActiveSessionTabRef | null,
  getSession: (id: number) => RuntimeSessionForDetails | null,
  conversations: DbConversationSummary[]
): ActiveSessionDetails {
  const runtimeId = tab?.runtimeConversationId ?? tab?.conversationId ?? null
  const runtimeSession = runtimeId != null ? getSession(runtimeId) : null
  const listed =
    tab?.conversationId != null
      ? (conversations.find((c) => c.id === tab.conversationId) ?? null)
      : null
  const summary = withLiveColumns(
    runtimeSession?.detail?.summary ?? listed,
    listed,
    tab?.status
  )
  const stats =
    runtimeSession?.sessionStats ??
    runtimeSession?.detail?.session_stats ??
    null
  // `localTurns` holds the live session's freshest turns; `detail.turns` the
  // cold-loaded history. Prefer the live model, then history, then the (usually
  // empty) summary column.
  const model =
    pickModelFromTurns(runtimeSession?.localTurns ?? []) ??
    pickModelFromTurns(runtimeSession?.detail?.turns ?? []) ??
    runtimeSession?.detail?.summary?.model ??
    summary?.model ??
    null
  return { summary, stats, model }
}
