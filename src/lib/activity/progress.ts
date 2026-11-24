/**
 * How far a sub-agent or delegated agent has got, as its tool calls show: how
 * many it has finished, how the latest of them ended, and what it did last.
 * Drawn as the step bar under its row — one segment per finished step, never a
 * percentage, since nobody knows the total while it runs.
 *
 * Three sources, one shape: a delegation's status report (`progress`, filled
 * by the broker from the child's session), the live child connection's
 * message, and a sub-agent's own recorded tool calls.
 */

export type StepMark = "ok" | "failed"

export interface StepProgress {
  /** Steps finished so far. */
  steps: number
  /** How the latest finished steps ended, oldest first; at most
   *  `MAX_STEP_MARKS` (the rest are only counted). */
  marks: StepMark[]
  /** The latest step's title, finished or not. */
  lastStep: string | null
}

/** Segments the bar draws (Rust `MAX_STEP_MARKS`). */
export const MAX_STEP_MARKS = 12

/** One tool call as the tally sees it: how it ended (`null` while it runs),
 *  and its title. */
export interface TalliedStep {
  mark: StepMark | null
  title: string | null
}

/** Tally tool calls in the order they started. `null` when there are none. */
export function tallySteps(calls: Iterable<TalliedStep>): StepProgress | null {
  let steps = 0
  const marks: StepMark[] = []
  let lastStep: string | null = null
  let any = false
  for (const call of calls) {
    any = true
    lastStep = call.title
    if (!call.mark) continue
    steps += 1
    marks.push(call.mark)
    if (marks.length > MAX_STEP_MARKS) marks.shift()
  }
  return any ? { steps, marks, lastStep } : null
}

/** First line of a title, trimmed; `null` when empty. */
export function cleanTitle(title: string | null | undefined): string | null {
  const line = title?.split("\n")[0]?.trim()
  return line ? line : null
}

/** A status report's `progress` (`{steps, marks, last_step}`), if well-formed. */
export function progressFromReport(raw: unknown): StepProgress | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const steps = obj.steps
  if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 0) {
    return null
  }
  const marks = Array.isArray(obj.marks)
    ? obj.marks
        .filter((m): m is StepMark => m === "ok" || m === "failed")
        .slice(-MAX_STEP_MARKS)
    : []
  return {
    steps: Math.max(steps, marks.length),
    marks,
    lastStep: cleanTitle(
      typeof obj.last_step === "string" ? obj.last_step : null
    ),
  }
}

/** The tool-call blocks of a live connection's message, as the connections
 *  reducer keeps them. Structural, so this module needs no React context. */
interface LiveBlock {
  type: string
  info?: { status: string; title: string }
}

/** Progress of a live child connection's turn, from its message's tool calls
 *  in the order they started. */
export function progressFromLiveContent(
  content: readonly LiveBlock[]
): StepProgress | null {
  return tallySteps(
    (function* () {
      for (const block of content) {
        if (block.type !== "tool_call" || !block.info) continue
        const { status, title } = block.info
        yield {
          mark:
            status === "completed"
              ? ("ok" as const)
              : status === "failed"
                ? ("failed" as const)
                : null,
          title: cleanTitle(title),
        }
      }
    })()
  )
}

/** A string that changes exactly when the drawn progress does. */
export function progressKey(progress: StepProgress | null): string {
  return progress
    ? `${progress.steps}|${progress.marks.join(",")}|${progress.lastStep ?? ""}`
    : ""
}
