/**
 * AIR async-task projection helpers.
 *
 * The wire (`async_task` events / the snapshot's `async_tasks` table) carries
 * PARTIAL deltas keyed by task id — see `AsyncTaskDelta` in `lib/types`. These
 * helpers implement the client half, shared by the connections reducer (live
 * events + snapshot hydrate) so it matches the backend's
 * `SessionState::apply_event`:
 *
 * - only a `spawned` delta may CREATE a row. A delta naming an unknown task
 *   means its announcement — the one frame carrying name, type and stop
 *   affordance — was missed, and a placeholder row is worse than none.
 * - every other field is optional and ABSENT MEANS UNCHANGED. A progress tick
 *   carries only what moved, so treating absence as "clear it" would blank a
 *   task's name on its first update.
 *
 * Rows are RETAINED after they settle rather than dropped on the terminal
 * state, because the adapter keeps revising a finished task: it attaches a late
 * `outputFilePath`, and corrects a best-effort `stopped` (inferred from its
 * liveness level) into the real `completed`/`failed` when the authoritative
 * edge arrives. An evicted row would be re-created by its own correction — and
 * since `spawned` is what carries identity, it would come back nameless.
 * Presentation decides what to SHOW (see `liveAsyncTasks`); this table decides
 * what is true. Kept dependency-free for unit testing without the context
 * harness.
 */

import type { AsyncTaskDelta, AsyncTaskRecord } from "@/lib/types"

/** States the adapter never revises away from. */
const TERMINAL_STATES = new Set(["completed", "failed", "stopped"])

export function isAsyncTaskTerminal(task: AsyncTaskRecord): boolean {
  return TERMINAL_STATES.has(task.state)
}

/** Build the row a `spawned` delta creates. The defaults exist because the
 *  wire fields are individually optional, not because a half-announced task is
 *  expected. */
function recordFromDelta(delta: AsyncTaskDelta): AsyncTaskRecord {
  return {
    task_id: delta.task_id,
    name: delta.name ?? "Background task",
    task_type: delta.task_type ?? "task",
    description: delta.description ?? "",
    show_in_transcript: delta.show_in_transcript ?? true,
    can_stop: delta.can_stop ?? false,
    state: delta.state ?? "running",
    summary: delta.summary ?? null,
    last_tool_name: delta.last_tool_name ?? null,
    usage: delta.usage ?? null,
    output_file_path: delta.output_file_path ?? null,
    tool_call_id: delta.tool_call_id ?? null,
    phase: delta.phase ?? null,
    current_agent: delta.current_agent ?? null,
  }
}

/** Apply a delta's PRESENT fields onto a stored row, returning a new object. */
function applyDelta(
  stored: AsyncTaskRecord,
  delta: AsyncTaskDelta
): AsyncTaskRecord {
  const next = { ...stored }
  if (delta.name != null) next.name = delta.name
  if (delta.task_type != null) next.task_type = delta.task_type
  if (delta.description != null) next.description = delta.description
  if (delta.show_in_transcript != null)
    next.show_in_transcript = delta.show_in_transcript
  if (delta.can_stop != null) next.can_stop = delta.can_stop
  if (delta.state != null) next.state = delta.state
  if (delta.summary != null) next.summary = delta.summary
  if (delta.last_tool_name != null) next.last_tool_name = delta.last_tool_name
  if (delta.usage != null) next.usage = delta.usage
  if (delta.output_file_path != null)
    next.output_file_path = delta.output_file_path
  if (delta.tool_call_id != null) next.tool_call_id = delta.tool_call_id
  if (delta.phase != null) next.phase = delta.phase
  if (delta.current_agent != null) next.current_agent = delta.current_agent
  return next
}

/**
 * Merge one live delta into the current table. Returns the SAME array
 * reference when nothing changed, so reducer consumers can cheaply detect
 * no-ops.
 */
export function upsertAsyncTask(
  current: AsyncTaskRecord[],
  delta: AsyncTaskDelta
): AsyncTaskRecord[] {
  if (!delta?.task_id) return current
  const index = current.findIndex((t) => t.task_id === delta.task_id)
  if (index < 0) {
    if (!delta.spawned) return current
    return [...current, recordFromDelta(delta)]
  }
  const next = [...current]
  next[index] = applyDelta(current[index], delta)
  return next
}

/**
 * Seed from a snapshot's merged table (hydrate). Whole rows, not deltas — the
 * backend already merged them — so this REPLACES by id rather than patching,
 * and appends ids the client hasn't seen.
 *
 * ONLY for a snapshot newer than everything this client has applied. The rows
 * carry no revision, so "replace by id" is only sound while the snapshot is
 * known to be the fresher of the two; for a snapshot the client has already
 * overtaken use [`adoptUnknownAsyncTasks`].
 *
 * Returns the same array reference when nothing changed.
 */
export function mergeAsyncTasks(
  current: AsyncTaskRecord[],
  incoming: AsyncTaskRecord[] | null | undefined
): AsyncTaskRecord[] {
  if (!incoming || incoming.length === 0) return current
  let next: AsyncTaskRecord[] | null = null
  for (const record of incoming) {
    if (!record?.task_id) continue
    const target = next ?? current
    const index = target.findIndex((t) => t.task_id === record.task_id)
    if (index >= 0) {
      next ??= [...current]
      next[index] = record
    } else {
      next ??= [...current]
      next.push(record)
    }
  }
  return next ?? current
}

/**
 * Fold a STALE snapshot in without letting it overwrite anything.
 *
 * A snapshot whose `eventSeq` the client has already passed was generated
 * BEFORE deltas this client applied, so its rows can be older — replacing by id
 * would walk a task the client already saw finish back to `running`, and the
 * live terminal event is not replayed to correct it (its seq is already below
 * the applied watermark). Rows are unversioned, so there is no per-row way to
 * tell which of the two is newer.
 *
 * Adding is still safe and still worth doing: a client that attached mid-episode
 * never saw the announcement of work already running, and the snapshot is its
 * only way to learn about it. So take the ids we don't have and leave the ones
 * we do alone — the "can only add, never clobber" rule the failure-record merge
 * gets from its revision counter, enforced structurally here instead.
 *
 * Returns the same array reference when nothing changed.
 */
export function adoptUnknownAsyncTasks(
  current: AsyncTaskRecord[],
  incoming: AsyncTaskRecord[] | null | undefined
): AsyncTaskRecord[] {
  if (!incoming || incoming.length === 0) return current
  let next: AsyncTaskRecord[] | null = null
  for (const record of incoming) {
    if (!record?.task_id) continue
    const target = next ?? current
    if (target.some((t) => t.task_id === record.task_id)) continue
    next ??= [...current]
    next.push(record)
  }
  return next ?? current
}

/**
 * What the strip renders: tasks still running or paused.
 *
 * Settled tasks drop off immediately. They are not lost — a task that owned a
 * tool call is still drawn in the transcript, and the agent narrates the
 * outcome — and a permanent list of finished background jobs docked under the
 * composer would grow without bound across a long session. This mirrors AIR's
 * own panel, which a stopped task "leaves at once".
 */
export function liveAsyncTasks(tasks: AsyncTaskRecord[]): AsyncTaskRecord[] {
  return tasks.filter((t) => !isAsyncTaskTerminal(t))
}
