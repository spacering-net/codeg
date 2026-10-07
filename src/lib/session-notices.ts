/**
 * ACP Session Notice presentation (`session_notice` events).
 *
 * A notice is fire-and-forget advisory text: no id, no lifecycle, no position
 * in the history. It is a NOTIFICATION — a toast, kept in the status-bar alert
 * list when it is a warning or an error (see `lib/notify`) — and never also a
 * strip under the composer, because the same sentence on the screen twice at
 * once reads as two problems. The composer dock is kept for what is in
 * progress (an upstream the adapter is reconnecting to).
 *
 * Kept dependency-free so the routing rules are unit-testable without the
 * connections provider.
 */

import type { SessionNotice } from "@/lib/types"

export type NoticeToastLevel = "error" | "warning" | "info"

export interface NoticeToast {
  level: NoticeToastLevel
  /** The adapter's title, first line only (the toast's bold line). */
  title: string
  /** Everything else the adapter said: the rest of a multi-line title, then
   *  the notice's own description. `undefined` when there is nothing more. */
  description?: string
  /**
   * The notification's key — its toast id and its alert-list key. Same
   * connection + level + title map to ONE notification, so a repeated advisory
   * refreshes the toast on screen and the entry in the list instead of
   * stacking a copy per occurrence.
   */
  id: string
}

/**
 * codex's post-compaction advisory: core emits "Heads up: Long threads and
 * multiple compactions can cause the model to be less accurate…" as a plain
 * `Warning` right after EVERY compaction (`core/src/compact.rs`), and
 * codex-acp forwards warnings as notices. Older releases said "conversations"
 * instead of "threads", so match the one phrase both share.
 */
const COMPACTION_ADVISORY = /\bmultiple compactions\b/i

/**
 * Whether a notice only restates a context compaction.
 *
 * Compaction already has its own surface: the transcript's compaction card
 * (running / done with the token delta / failed with the reason), which codeg
 * renders for every adapter it advertises `session.compaction` to — and
 * notices are only advertised together with it. Raising a toast as well turned
 * every compaction into a card plus a warning, so these are dropped:
 *
 * - codex's advisory above, which carries nothing the card lacks except advice
 *   that repeats on every single compaction;
 * - codex-acp's legacy "Context compacted" notice, sent in place of the
 *   compaction frames to a client WITHOUT the capability. codeg always has it,
 *   so this is defensive — but if it ever arrives, the card (or its absence) is
 *   still the honest place to say so.
 */
export function isCompactionEchoNotice(notice: SessionNotice): boolean {
  const text = `${notice.title}\n${notice.description ?? ""}`
  if (COMPACTION_ADVISORY.test(text)) return true
  return (
    notice.severity === "info" &&
    notice.title.trim().toLowerCase() === "context compacted"
  )
}

/** A level codeg cannot grade renders as `info`, the gentlest one. */
function noticeLevel(severity: string): NoticeToastLevel {
  return severity === "error" || severity === "warning" ? severity : "info"
}

/**
 * Split adapter text into a one-line headline and the rest.
 *
 * Adapter titles are "plain text that stands alone" per the RFD, but codex
 * passes some upstream errors through whole — a transport fallback's notice,
 * or a failure record's title, carries a multi-line JSON body. Only the first
 * non-empty line is a headline; the rest goes ahead of `more` (the adapter's
 * own description / details) into the second line, which a toast renders
 * smaller and clamps. `null` when there is no text at all.
 */
export function splitHeadline(
  text: string,
  more?: string | null
): { title: string; description?: string } | null {
  const lines = text.split(/\r?\n/)
  const firstIndex = lines.findIndex((line) => line.trim().length > 0)
  if (firstIndex < 0) return null
  const title = lines[firstIndex].trim()
  const rest = lines
    .slice(firstIndex + 1)
    .join("\n")
    .trim()
  const description = [rest, more?.trim() ?? ""]
    .filter((part) => part.length > 0)
    .join("\n")
  return { title, ...(description ? { description } : {}) }
}

/**
 * Shape a notice into its toast, or `null` when it should not be shown at all
 * (see [`isCompactionEchoNotice`]) or says nothing.
 */
export function presentSessionNotice(
  connectionId: string,
  notice: SessionNotice
): NoticeToast | null {
  if (isCompactionEchoNotice(notice)) return null
  const headline = splitHeadline(notice.title, notice.description)
  if (!headline) return null
  const level = noticeLevel(notice.severity)
  return {
    level,
    ...headline,
    id: `acp-notice:${connectionId}:${level}:${headline.title}`,
  }
}
