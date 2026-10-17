import type { MessageNavEntry } from "@/components/message/conversation-message-nav"
import { extractSessionFilesGrouped } from "@/lib/session-files"
import type { MessageTurn } from "@/lib/types"

export interface MessageNavEntriesInput {
  /**
   * The history above the loaded window, `full[0..offset)` (the backend's
   * outline, already checked against the window), or null when it isn't
   * available: the window covers everything, the server predates the outline,
   * or it is still loading or failed.
   */
  earlierTurns: readonly MessageTurn[] | null
  /** User messages above the loaded window, listed or not. */
  earlierUserCount: number
  /** The loaded timeline's turns, in order. */
  loadedTurns: readonly MessageTurn[]
  /** Each loaded user turn's index among the rendered thread items. */
  threadIndexByTurnId: ReadonlyMap<string, number>
}

/**
 * One navigator entry per user message: every message of the conversation
 * when `earlierTurns` is given, otherwise the loaded ones, numbered on from
 * the `earlierUserCount` messages above them so a message keeps its number
 * whether or not the history above it is listed yet.
 *
 * The earlier and loaded turns are grouped as one transcript, so a round that
 * straddles the window start (its prompt above, part of its reply loaded)
 * still collects all of its files. An entry for a loaded message carries its
 * thread index; one above the window carries its global turn index, which is
 * what paging it in needs.
 *
 * A message is listed once even if both lists hold it: a background-activity
 * overlay turn stays in the timeline while its persisted twin is above the
 * window (the overlay can't be retired until the window covers the twin), and
 * the two share an id. It is listed where the history puts it, and jumps to
 * the copy that renders.
 */
export function buildMessageNavEntries({
  earlierTurns,
  earlierUserCount,
  loadedTurns,
  threadIndexByTurnId,
}: MessageNavEntriesInput): MessageNavEntry[] {
  const turns =
    earlierTurns && earlierTurns.length > 0
      ? [...earlierTurns, ...loadedTurns]
      : loadedTurns
  const groups = extractSessionFilesGrouped(turns, { includeEmpty: true })

  const earlierIndexById = new Map<string, number>()
  earlierTurns?.forEach((turn, index) => {
    if (turn.role === "user") earlierIndexById.set(turn.id, index)
  })

  const entries: MessageNavEntry[] = []
  const listed = new Set<string>()
  let ordinal = earlierTurns ? 0 : earlierUserCount
  for (const group of groups) {
    if (listed.has(group.userTurnId)) continue
    listed.add(group.userTurnId)
    const threadIndex = threadIndexByTurnId.get(group.userTurnId) ?? null
    const turnIndex =
      threadIndex == null
        ? (earlierIndexById.get(group.userTurnId) ?? null)
        : null
    if (threadIndex == null && turnIndex == null) continue
    let additions = 0
    let deletions = 0
    for (const file of group.files) {
      additions += file.additions
      deletions += file.deletions
    }
    ordinal += 1
    entries.push({
      threadIndex,
      turnIndex,
      turnId: group.userTurnId,
      ordinal,
      label: group.userMessage,
      additions,
      deletions,
      files: group.files,
      hasChanges: group.files.length > 0,
    })
  }
  return entries
}
