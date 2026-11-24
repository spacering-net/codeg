// Shared, pure display logic for the pet badge + session panel. Keeping the
// precedence in one place means the sprite badge, the panel sort, and the
// per-row status pill can't drift apart (and from the Rust `from_entries`
// counts they mirror). Precedence everywhere: error > waiting > running.

import type { PetSessionEntry, PetSessionsPayload } from "@/lib/pet/types"

export type PetBadgeKind = "error" | "waiting" | "running"
export type PetSessionStatusKind = "waiting" | "error" | "running"

/**
 * Pick the sprite badge bucket + count from the aggregate counts, or `null`
 * when nothing is active (idle → no badge). Uses the precomputed counts from
 * the backend payload rather than re-deriving per session.
 */
export function pickPetBadge(
  payload: PetSessionsPayload
): { kind: PetBadgeKind; count: number } | null {
  if (payload.errorCount > 0) {
    return { kind: "error", count: payload.errorCount }
  }
  if (payload.waitingCount > 0) {
    return { kind: "waiting", count: payload.waitingCount }
  }
  if (payload.runningCount > 0) {
    return { kind: "running", count: payload.runningCount }
  }
  return null
}

/** Per-session status bucket for the panel row's pill. */
export function sessionStatusKind(
  session: PetSessionEntry
): PetSessionStatusKind {
  // A question or a plan approval blocks the agent like a permission does.
  if (session.pending || session.ask) return "waiting"
  if (session.status === "error") return "error"
  return "running"
}

/** Sort rank for the panel list: the sessions that need the user come first. */
export function sessionSortRank(session: PetSessionEntry): number {
  const kind = sessionStatusKind(session)
  return kind === "waiting" ? 0 : kind === "error" ? 1 : 2
}
