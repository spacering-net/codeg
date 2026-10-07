/**
 * Round matching for work-task transcripts.
 *
 * The engine records a `round` event every time it dispatches a prompt to the
 * task's session: `{ kind: "work" | "retry" | "return" | "merge", intent,
 * run_seq, prompt_head }` with the head of the prompt's first text block. The
 * transcript viewer labels each user turn with its phase by matching the turn's
 * text against those heads. A pre-prompt compaction contributes a `compact`
 * round from its own event (see [`extractRounds`]).
 *
 * `intent` is set on `return` rounds only — every follow-up scenario shares the
 * `return` kind (the folder's per-stage prompt settings key off it), so the
 * intent is what tells "rework" apart from "answer my question" in the divider.
 *
 * Matching is PURE per text (first round whose head prefixes the text), not a
 * consuming sequence: the message thread is virtualized, so turns render in
 * arbitrary order and multiplicity. Distinct phases have structurally distinct
 * prompts (retry/return/merge are engine-composed), so first-match is stable;
 * two rounds of the same kind with the same text yield the same — correct —
 * label. Tasks predating the `round` event simply match nothing.
 */

import type { WorkTaskEvent } from "@/lib/types"

export interface TaskRound {
  kind: string
  /** Follow-up scenario of a `return` round; absent on rounds recorded before
   *  scenarios existed, and on every other kind. */
  intent?: string
  promptHead: string
}

/** Ordered `round` markers of a task's event log.
 *
 * A pre-prompt context compaction is folded in as a round of its own
 * (`kind: "compact"`), because on the transcript it IS one: the engine sends
 * the agent's compact command as an ordinary prompt, so the viewer shows a
 * user turn nobody typed sitting between two labelled phases. Its head is the
 * command itself, taken from the `started` half of the pair — the outcome half
 * does not carry a turn. */
export function extractRounds(events: WorkTaskEvent[]): TaskRound[] {
  const rounds: TaskRound[] = []
  for (const event of events) {
    const payload = event.payload
    if (event.kind === "context_compact") {
      if (payload?.status !== "started") continue
      const command =
        typeof payload?.command === "string" ? payload.command : ""
      if (command.trim()) rounds.push({ kind: "compact", promptHead: command })
      continue
    }
    if (event.kind !== "round") continue
    const kind = typeof payload?.kind === "string" ? payload.kind : null
    const head =
      typeof payload?.prompt_head === "string" ? payload.prompt_head : ""
    if (!kind || !head.trim()) continue
    const intent =
      typeof payload?.intent === "string" ? payload.intent : undefined
    rounds.push({ kind, intent, promptHead: head })
  }
  return rounds
}

/** Whitespace-insensitive comparison form (prompts re-wrap across surfaces). */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/** The round a user turn's text belongs to, or null when none matches. */
export function matchRound(
  rounds: TaskRound[],
  text: string
): TaskRound | null {
  const normalized = normalize(text)
  if (!normalized) return null
  for (const round of rounds) {
    const head = normalize(round.promptHead)
    if (head && normalized.startsWith(head)) return round
  }
  return null
}

/** The phase kind of a user turn's text, or null when no round matches. */
export function matchRoundKind(
  rounds: TaskRound[],
  text: string
): string | null {
  return matchRound(rounds, text)?.kind ?? null
}

/** First text part of an adapted message group (structural, adapter-agnostic). */
export function firstTextOfParts(
  parts: ReadonlyArray<{ type: string; text?: unknown }>
): string {
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") return part.text
  }
  return ""
}
