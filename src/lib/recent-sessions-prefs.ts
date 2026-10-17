/**
 * "Recent sessions" LRU queue + switch-depth preference, backing the floating
 * ball's cycle-recent-sessions gesture.
 *
 * The queue lives in localStorage (shared across windows of the same origin)
 * and stores conversationIds only; consumers must filter to conversations
 * their own window can actually open. Depth is 2-4 (default 2): with depth 2
 * the gesture toggles between the two most recently opened conversations.
 */
const STORAGE_KEY_RECENT_CONVERSATIONS = "codeg:recent-conversations"
const STORAGE_KEY_RECENT_SESSION_DEPTH = "codeg:recent-session-depth"

/** Queue holds more than the max depth so switching survives a bit of drift. */
const QUEUE_CAPACITY = 8
export const MIN_RECENT_SESSION_DEPTH = 2
export const MAX_RECENT_SESSION_DEPTH = 4
export const DEFAULT_RECENT_SESSION_DEPTH = 2

export type RecentSessionDepth = 2 | 3 | 4

function readQueue(): number[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_RECENT_CONVERSATIONS)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (id): id is number => typeof id === "number" && Number.isFinite(id)
    )
  } catch {
    return []
  }
}

function writeQueue(queue: number[]): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(
      STORAGE_KEY_RECENT_CONVERSATIONS,
      JSON.stringify(queue.slice(0, QUEUE_CAPACITY))
    )
  } catch {
    // Storage full or unavailable: cycling just becomes a no-op, acceptable.
  }
}

/** Push a conversation as "just opened", deduped, most-recent first. */
export function rememberRecentConversation(id: number): void {
  const next = [id, ...readQueue().filter((v) => v !== id)]
  writeQueue(next)
}

/** Drop a deleted conversation so cycling never lands on it. */
export function forgetRecentConversation(id: number): void {
  const next = readQueue().filter((v) => v !== id)
  if (next.length !== readQueue().length) writeQueue(next)
}

/**
 * Pick the next conversation to switch to: the most recent entry that isn't
 * the active one, within the configured depth window. Returns null when there
 * is nothing to switch to. Moving the picked id to the front is what makes
 * repeated gestures toggle between two sessions at depth 2.
 */
export function nextRecentConversation(
  activeId: number | null,
  depth: number,
  isAvailable: (id: number) => boolean
): number | null {
  const candidates = readQueue()
    .filter((id) => id !== activeId && isAvailable(id))
    .slice(0, Math.max(0, depth - 1))
  return candidates.length > 0 ? candidates[0] : null
}

export function readRecentSessionDepth(): RecentSessionDepth {
  if (typeof window === "undefined") return DEFAULT_RECENT_SESSION_DEPTH
  const raw = window.localStorage.getItem(STORAGE_KEY_RECENT_SESSION_DEPTH)
  return raw === "3" || raw === "4"
    ? (Number(raw) as RecentSessionDepth)
    : DEFAULT_RECENT_SESSION_DEPTH
}

export function writeRecentSessionDepth(depth: RecentSessionDepth): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY_RECENT_SESSION_DEPTH, String(depth))
  } catch {
    // Unavailable storage: the selector will read the default back.
  }
}
