/**
 * Which `get_delegation_status` row of a transcript speaks for a task now.
 *
 * An agent waiting on a sub-agent polls it again and again, and anything it
 * says or does between two polls splits them into separate status cards — a
 * long wait leaves one task with a row in a dozen cards. Only the NEWEST of
 * those rows reaches the live sub-agent (`DelegationStatusRow`): it is the
 * wait still going on, or the last word on it, and it is where a decision the
 * sub-agent is parked on gets answered — once, not in every card. Each older
 * row is a check that has since been superseded, the same as the interim polls
 * a merged card folds into its latest one. (A decision the user has started
 * answering stays in its row until it is answered: `DelegationStatusRow`.)
 *
 * `MessageListView` builds the index over its whole thread and provides it
 * (`DelegationStatusIndexProvider`); the rows read it.
 */

import type {
  AdaptedContentPart,
  AdaptedToolCallPart,
} from "@/lib/adapters/ai-elements-adapter"
import { buildDelegationTaskRows } from "@/lib/delegation-status"
import { normalizeToolName } from "@/lib/tool-call-normalization"

/** One task row a transcript draws, as far as the index cares. */
export interface DelegationStatusTaskRef {
  taskId: string
  /** `DelegationTaskRow.latestPollId` of that row. */
  latestPollId: string
  /** `DelegationTaskRow.runningConfirmed` of that row. */
  runningConfirmed: boolean
}

export interface DelegationStatusTaskEntry {
  /** The latest poll of the transcript's newest row for the task. */
  latestPollId: string
  /**
   * The backend answered one of the task's polls in this transcript with a
   * `running` report, wherever that poll is drawn. It only does so for the
   * caller's own task, so the newest row may reach the sub-agent even when
   * its own polls have not been answered yet (a re-poll still in flight).
   */
  runningConfirmed: boolean
}

export type DelegationStatusIndex = ReadonlyMap<
  string,
  DelegationStatusTaskEntry
>

const EMPTY_REFS: readonly DelegationStatusTaskRef[] = []

// Per polls array, so a card that keeps its polls across streaming batches is
// parsed once — the same arrays the cards themselves are drawn from.
const refsByPolls = new WeakMap<
  readonly AdaptedToolCallPart[],
  readonly DelegationStatusTaskRef[]
>()
// The one-poll array a bare status call is read as, kept per call so the
// cache above can hold it.
const singlePollByCall = new WeakMap<
  AdaptedToolCallPart,
  readonly AdaptedToolCallPart[]
>()

function refsOfPolls(
  polls: readonly AdaptedToolCallPart[]
): readonly DelegationStatusTaskRef[] {
  let refs = refsByPolls.get(polls)
  if (!refs) {
    const out: DelegationStatusTaskRef[] = []
    for (const row of buildDelegationTaskRows(polls as AdaptedToolCallPart[])) {
      if (row.taskId == null) continue
      out.push({
        taskId: row.taskId,
        latestPollId: row.latestPollId,
        runningConfirmed: row.runningConfirmed,
      })
    }
    refs = out.length > 0 ? out : EMPTY_REFS
    refsByPolls.set(polls, refs)
  }
  return refs
}

/** A tool call the renderer draws as a status card (`ToolCallPart`). */
function isStatusCall(part: AdaptedToolCallPart): boolean {
  return (
    normalizeToolName(part.toolName).toLowerCase() === "get_delegation_status"
  )
}

function collect(
  parts: readonly AdaptedContentPart[],
  out: DelegationStatusTaskRef[]
): void {
  for (const part of parts) {
    if (part.type === "delegation-status-group") {
      out.push(...refsOfPolls(part.polls))
    } else if (part.type === "tool-call") {
      // A status call the grouper left bare is drawn as a one-poll card of
      // its own (`DelegationStatusCard`), named by its own call id.
      if (!isStatusCall(part)) continue
      let polls = singlePollByCall.get(part)
      if (!polls) {
        polls = [part]
        singlePollByCall.set(part, polls)
      }
      out.push(...refsOfPolls(polls))
    } else if (part.type === "tool-group" || part.type === "goal-run") {
      collect(part.items, out)
    }
  }
}

/**
 * The task rows a turn's adapted parts draw, in order: each
 * `delegation-status-group` card's rows, the one-poll card of a bare status
 * call, and whatever tool groups and goal runs hold. Rows with no task id are
 * left out — they never reach a sub-agent.
 */
export function collectDelegationStatusTasks(
  parts: readonly AdaptedContentPart[]
): readonly DelegationStatusTaskRef[] {
  const out: DelegationStatusTaskRef[] = []
  collect(parts, out)
  return out.length > 0 ? out : EMPTY_REFS
}

function sameIndex(a: DelegationStatusIndex, b: DelegationStatusIndex) {
  if (a.size !== b.size) return false
  for (const [taskId, entry] of a) {
    const other = b.get(taskId)
    if (
      !other ||
      other.latestPollId !== entry.latestPollId ||
      other.runningConfirmed !== entry.runningConfirmed
    ) {
      return false
    }
  }
  return true
}

/**
 * Fold the task rows of a transcript's turns, oldest first, into the index:
 * the last row of a task is its newest, and a `running` answer to any of its
 * polls vouches for the task. Returns `prev` when the result equals it.
 */
export function buildDelegationStatusIndex(
  turns: Iterable<readonly DelegationStatusTaskRef[]>,
  prev: DelegationStatusIndex | null = null
): DelegationStatusIndex {
  const next = new Map<string, DelegationStatusTaskEntry>()
  for (const refs of turns) {
    for (const ref of refs) {
      const seen = next.get(ref.taskId)
      next.set(ref.taskId, {
        latestPollId: ref.latestPollId,
        runningConfirmed:
          ref.runningConfirmed || (seen?.runningConfirmed ?? false),
      })
    }
  }
  return prev && sameIndex(prev, next) ? prev : next
}

/**
 * A per-transcript indexer: `buildDelegationStatusIndex` that remembers its
 * last result, so the reference changes only when a task's newest row or
 * confirmation does — a new index re-renders every status row on screen, and
 * the thread is rebuilt on every streaming batch.
 */
export function createDelegationStatusIndexer(): (
  turns: Iterable<readonly DelegationStatusTaskRef[]>
) => DelegationStatusIndex {
  let last: DelegationStatusIndex | null = null
  return (turns) => {
    last = buildDelegationStatusIndex(turns, last)
    return last
  }
}
