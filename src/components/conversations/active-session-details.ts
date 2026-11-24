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
 * Inputs read while projecting metadata. Do not subscribe to this shape:
 * `detail` and `localTurns` still own the transcript, including in a persistent
 * consumer's previous React hook snapshot.
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
 * Project before subscribing, so a metadata consumer's current and previous
 * snapshots contain only the values it displays, never a session or turn array.
 */
export function projectRuntimeSessionDetails(
  session: RuntimeSessionForDetails | null | undefined
): ActiveSessionDetails {
  return {
    summary: session?.detail?.summary ?? null,
    stats: session?.sessionStats ?? session?.detail?.session_stats ?? null,
    model:
      pickModelFromTurns(session?.localTurns ?? []) ??
      pickModelFromTurns(session?.detail?.turns ?? []) ??
      session?.detail?.summary?.model ??
      null,
  }
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
  return resolveActiveSessionDetailsFromSnapshot(
    tab,
    projectRuntimeSessionDetails(runtimeSession),
    conversations
  )
}

/** Apply live workspace/tab columns after the store's metadata projection. */
export function resolveActiveSessionDetailsFromSnapshot(
  tab: ActiveSessionTabRef | null,
  snapshot: ActiveSessionDetails,
  conversations: DbConversationSummary[]
): ActiveSessionDetails {
  const listed =
    tab?.conversationId != null
      ? (conversations.find((c) => c.id === tab.conversationId) ?? null)
      : null
  const summary = withLiveColumns(
    snapshot.summary ?? listed,
    listed,
    tab?.status
  )
  return {
    summary,
    stats: snapshot.stats,
    model: snapshot.model ?? summary?.model ?? null,
  }
}
