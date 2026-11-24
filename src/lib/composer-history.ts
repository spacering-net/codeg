import type { ContentBlock, MessageTurn } from "@/lib/types"

/** Text of one turn's text blocks — empty (image-only) turns read as `""`. */
function textOf(turn: MessageTurn): string {
  return turn.blocks
    .filter(
      (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text"
    )
    .map((b) => b.text)
    .join("\n")
    .trim()
}

/**
 * Every user prompt of a session, oldest first — what the composer's Up/Down
 * history cycles.
 *
 * Derived from the session's own turns rather than persisted separately, which
 * is exactly the behaviour the issue asks for: a new session has no turns and
 * therefore no history, while a resumed one gets its real prompts back. Empty
 * (image-only) turns are skipped, and consecutive duplicates collapse — sending
 * the same text twice is one entry to step through, not two.
 */
export function userPromptHistory(
  turns: readonly MessageTurn[] | undefined
): string[] {
  if (!turns) return []
  const out: string[] = []
  for (const turn of turns) {
    if (turn.role !== "user") continue
    const text = textOf(turn)
    if (!text) continue
    if (out[out.length - 1] === text) continue
    out.push(text)
  }
  return out
}

export type HistoryDirection = "older" | "newer"

export interface HistoryStep {
  /** What the composer should do with the editor. */
  action: "show" | "restore" | "none"
  /** The entry to show when `action === "show"`. */
  text?: string
  /** The index to keep; `null` means "not navigating". */
  index: number | null
  /** True when this step ENTERS navigation — the caller must stash the draft. */
  enters: boolean
}

/**
 * One ArrowUp ("older") / ArrowDown ("newer") step. Pure, so the transition
 * rules are unit-tested without driving a ProseMirror view.
 *
 * `index === null` means "not navigating". An "older" step enters at the newest
 * entry and asks the caller to stash what is currently in the box; a "newer"
 * step with `index === null` does nothing (there is nothing to move forward to,
 * so the key must fall through to normal caret movement). Stepping newer past
 * the newest returns "restore": put the stashed draft back and leave navigation.
 *
 * The caller owns the draft and the editor; this only decides the transition.
 */
export function stepComposerHistory(
  history: readonly string[],
  index: number | null,
  direction: HistoryDirection
): HistoryStep {
  const last = history.length - 1
  // A history that emptied out (the session was reset mid-navigation) is not
  // navigable either way: leave navigation and let the key fall through.
  if (last < 0) return { action: "none", index: null, enters: false }
  if (direction === "older") {
    if (index === null) {
      return { action: "show", text: history[last], index: last, enters: true }
    }
    if (index > 0) {
      return {
        action: "show",
        text: history[index - 1],
        index: index - 1,
        enters: false,
      }
    }
    return { action: "none", index, enters: false }
  }
  if (index === null) return { action: "none", index: null, enters: false }
  if (index < last) {
    return {
      action: "show",
      text: history[index + 1],
      index: index + 1,
      enters: false,
    }
  }
  return { action: "restore", index: null, enters: false }
}
