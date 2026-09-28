import type { DbConversationDetail } from "@/lib/types"

/** Prefer the live error, and retire only the persisted version that preceded
 * a prompt. A later detail fetch with a higher revision may surface a new
 * failure even when it came from another client. */
export function resolveVisibleConversationError(
  liveError: string | null,
  status: string | null,
  detail: DbConversationDetail | null,
  retiredRevision: number | null
): string | null {
  if (liveError) return liveError
  if (status === "prompting") return null
  if (!detail?.last_error) return null
  if (
    retiredRevision !== null &&
    (detail.last_error_revision ?? 0) <= retiredRevision
  ) {
    return null
  }
  return detail.last_error.message
}
