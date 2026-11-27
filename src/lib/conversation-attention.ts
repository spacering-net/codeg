import {
  BLOCKING_PRIORITY,
  blockingPromptKind,
  type BlockingPromptKind,
  type BlockingPrompts,
} from "@/lib/blocking-prompts"

/**
 * Which conversations are parked on the user, by persisted conversation id.
 *
 * A conversation's `status` cannot say this. The DB status is a lifecycle
 * (`in_progress` / `pending_review` / `completed` / `cancelled`) shared by every
 * client and written by whichever process owns the row, while "the agent is
 * holding a question card open" is a fact about a LIVE connection — transient,
 * possibly owned by another window, and gone the moment the user answers (or
 * the process dies). Writing it into the status column would persist a state no
 * sweeper could ever clear.
 *
 * So it is derived instead, on the client, from the connections this window
 * holds: `blockingPrompts` already says "this connection waits on nobody or on
 * one of three prompts", and `blockingPromptKind` collapses that to the one
 * mark a row has room for.
 *
 * THE POINT of the index is what a naive per-tab lookup misses: a connection
 * outlives its tab. Close a tab whose agent is still busy and the connection
 * (and its question card) keeps running under a context key no tab owns any
 * more — the exact "it has been waiting in the background and I never saw it"
 * case this exists for. Its conversation id therefore comes from the connect
 * identity, remembered past the surface, not from the open tab.
 */
export type AttentionIndex = ReadonlyMap<number, BlockingPromptKind>

/** The empty index. Shared, so "nothing waits on me" keeps one identity. */
export const EMPTY_ATTENTION_INDEX: AttentionIndex = new Map()

/** One connection's contribution: which conversation it serves, and whether it
 *  is parked. `conversationId` is `null`/absent for a connection that serves no
 *  persisted row yet (a draft's first turn, a delegated sub-agent), and such a
 *  connection can never raise attention — there is no row to mark. */
export interface AttentionCandidate {
  conversationId: number | null | undefined
  prompts: BlockingPrompts | null
}

const RANK = new Map<BlockingPromptKind, number>(
  BLOCKING_PRIORITY.map((kind, index) => [kind, index])
)

/**
 * Fold every connection's blocking state into one index.
 *
 * Two connections can serve the same conversation (an owner in one window and a
 * viewer in another, or a stale entry the idle sweep has not reclaimed yet), so
 * the strongest block wins: a permission dialog is harder to miss than a plan
 * approval, and reporting the strongest one is never wrong — all three mean "the
 * agent cannot move until you act".
 *
 * Returns {@link EMPTY_ATTENTION_INDEX} rather than a fresh empty map when
 * nothing is parked, so the common case allocates nothing and keeps a stable
 * identity for `useSyncExternalStore`.
 */
export function buildAttentionIndex(
  candidates: Iterable<AttentionCandidate>
): AttentionIndex {
  let out: Map<number, BlockingPromptKind> | null = null
  for (const candidate of candidates) {
    const conversationId = candidate.conversationId
    // A non-positive id is a client-side draft key, not a row the sidebar lists.
    if (conversationId == null || conversationId <= 0) continue
    const kind = blockingPromptKind(candidate.prompts)
    if (!kind) continue
    if (!out) out = new Map()
    const existing = out.get(conversationId)
    if (existing === undefined || RANK.get(kind)! < RANK.get(existing)!) {
      out.set(conversationId, kind)
    }
  }
  return out ?? EMPTY_ATTENTION_INDEX
}

/** Whether two indexes mark the same conversations the same way. Lets the store
 *  skip a notification (and every subscriber's re-render) on a change that nets
 *  out to the same marks — a re-hydrated snapshot carrying the same question. */
export function sameAttentionIndex(
  a: AttentionIndex,
  b: AttentionIndex
): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [conversationId, kind] of a) {
    if (b.get(conversationId) !== kind) return false
  }
  return true
}
