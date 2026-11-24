import { toErrorMessage } from "@/lib/app-error"

/**
 * The resurrection guard's refusal, as it reaches the wire.
 *
 * Minted by `duplicate_active_source_error` in
 * `src-tauri/src/db/service/work_task_service.rs` and carried inside a plain
 * validation error (the guard has no error code of its own), so the match is
 * on this marker rather than on `AppCommandError.code`. Both roads back into
 * the active set raise it: `retry` (failed → queued) and `requeue`
 * (canceled → todo).
 */
const MARKER = "duplicate_active_source:"

/** The OTHER task that already holds this work item. */
export interface DuplicateActiveSource {
  /** `null` when the backend reworded the detail out from under the pattern. */
  id: number | null
  title: string | null
}

/**
 * Greedy title capture with an anchored suffix — an issue title may itself end
 * in `)`, and a lazy match would stop at the first one and truncate.
 */
const PATTERN =
  /duplicate_active_source: task #(\d+) \(([\s\S]*)\) is already active/

/**
 * Recognize the guard's refusal so the restart can offer the override the
 * backend already accepts (`allowDuplicateSource`). Without it a failed forge
 * task is a dead end: the guard refuses EVERY restart of that card for as long
 * as a replacement task lives, and the raw marker in a toast tells the user
 * nothing they can act on.
 *
 * Returns `null` for every other failure — those stay toasts.
 */
export function duplicateActiveSource(
  error: unknown
): DuplicateActiveSource | null {
  const text = toErrorMessage(error)
  if (!text.includes(MARKER)) return null
  const match = PATTERN.exec(text)
  // The marker is the contract; the id and title are decoration. A detail
  // string that drifted must still get the override affordance, so a failed
  // parse degrades to a nameless duplicate rather than to "not a duplicate".
  if (!match) return { id: null, title: null }
  const id = Number.parseInt(match[1], 10)
  const title = match[2].trim()
  return {
    id: Number.isFinite(id) ? id : null,
    title: title || null,
  }
}

/**
 * How the other task is named in the warning. `anonymous` is the caller's
 * localized stand-in for the degraded parse — the sentence still has to read
 * as a sentence when there is no `#id` to point at.
 */
export function duplicateActiveSourceLabel(
  duplicate: DuplicateActiveSource,
  anonymous: string
): string {
  if (duplicate.id == null) return anonymous
  return duplicate.title
    ? `#${duplicate.id} (${duplicate.title})`
    : `#${duplicate.id}`
}
