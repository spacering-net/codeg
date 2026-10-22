import type { MessageNavEntry } from "@/components/message/conversation-message-nav"
import type { DelegationCardSource } from "@/hooks/use-delegation-card-model"
import {
  isDelegateToAgentToolName,
  parseDelegationMeta,
} from "@/lib/delegation-card"
import { normalizeSlashPath } from "@/lib/file-path-display"
import {
  extractSessionFilesGrouped,
  type FileChangeStat,
} from "@/lib/session-files"
import { normalizeToolName } from "@/lib/tool-call-normalization"
import type { MessageTurn } from "@/lib/types"

/**
 * The sub-agents of the loaded messages, read off the rendered thread (see
 * `extractMessageDelegationSources`): the same sources its delegation cards
 * draw, so a row and its card never disagree.
 */
export interface LoadedMessageSubAgents {
  /** Per loaded user message, by its turn id. */
  byUserTurnId: ReadonlyMap<string, readonly DelegationCardSource[]>
  /** Those of the replies loaded ahead of the first loaded user message: the
   *  tail of a round whose prompt sits above the loaded window. */
  leading: readonly DelegationCardSource[]
}

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
  /** The loaded messages' sub-agents. Omitted: none are listed. */
  loadedSubAgents?: LoadedMessageSubAgents
}

const NO_SUB_AGENTS: readonly DelegationCardSource[] = []

/**
 * A round's file changes, one per file: an agent that edits a file five times
 * changed one file, not five. Line counts add up and the diffs follow one
 * another in order, the way the reply's own "Files changed" card puts them.
 * Each file keeps the id of its first change, which later edits don't move.
 */
export function mergeFileChangesByPath(
  files: FileChangeStat[]
): FileChangeStat[] {
  if (files.length < 2) return files
  const merged = new Map<
    string,
    {
      first: FileChangeStat
      additions: number
      deletions: number
      diffs: string[]
    }
  >()
  for (const file of files) {
    const key = normalizeSlashPath(file.path)
    let acc = merged.get(key)
    if (!acc) {
      acc = { first: file, additions: 0, deletions: 0, diffs: [] }
      merged.set(key, acc)
    }
    acc.additions += file.additions
    acc.deletions += file.deletions
    if (file.diff) acc.diffs.push(file.diff)
  }
  if (merged.size === files.length) return files
  return Array.from(merged.values(), ({ first, additions, deletions, diffs }) =>
    // One change to this file: keep its object.
    first.additions === additions &&
    first.deletions === deletions &&
    (diffs.length === 0
      ? first.diff === null
      : diffs.join("\n\n") === first.diff)
      ? first
      : {
          id: first.id,
          path: first.path,
          additions,
          deletions,
          diff: diffs.length > 0 ? diffs.join("\n\n") : null,
        }
  )
}

/**
 * Per-turn memo of `outlineTurnSubAgents`, keyed by identity: a turn is never
 * edited in place, and the outline is refetched as a whole.
 */
const outlineSubAgentsCache = new WeakMap<
  MessageTurn,
  readonly DelegationCardSource[]
>()

/**
 * The sub-agents a turn of the outline (the history above the loaded window)
 * started. The outline keeps every tool call, with the delegation snapshot the
 * backend stamps on it, but drops their results — so only a call that carries
 * that snapshot is listed: it is the proof a sub-agent ran (a refused call
 * has none), and it says how that run ended. A `resume_delegation` is left
 * out: whether it was refused is in the result the outline no longer has, and
 * the run it resumed is listed under the message that started it.
 */
function outlineTurnSubAgents(
  turn: MessageTurn
): readonly DelegationCardSource[] {
  const cached = outlineSubAgentsCache.get(turn)
  if (cached) return cached
  const sources: DelegationCardSource[] = []
  for (const block of turn.blocks) {
    if (block.type !== "tool_use" || !block.tool_use_id) continue
    if (!isDelegateToAgentToolName(normalizeToolName(block.tool_name))) continue
    if (parseDelegationMeta(block.meta) == null) continue
    sources.push({
      parentToolUseId: block.tool_use_id,
      input: block.input_preview,
      output: null,
      errorText: null,
      // History: the call returned long ago, whatever its result said.
      state: "output-available",
      meta: block.meta ?? null,
    })
  }
  const result = sources.length > 0 ? sources : NO_SUB_AGENTS
  outlineSubAgentsCache.set(turn, result)
  return result
}

/** What `buildMessageNavEntries` reads off the outline, once per outline. */
interface OutlineIndex {
  /** Each user message's global turn index. */
  turnIndexById: ReadonlyMap<string, number>
  /** The sub-agents of each user message, by its turn id. */
  subAgentsByUserTurnId: ReadonlyMap<string, readonly DelegationCardSource[]>
  /** The last user message: the round still open at the outline's end, which
   *  the loaded window continues. */
  lastUserTurnId: string | null
}

/**
 * Per-outline memo of `indexOutline`, keyed by the array: the outline is
 * fetched as a whole and kept while it covers the window, so every streaming
 * batch would otherwise index the same history again.
 */
const outlineIndexCache = new WeakMap<readonly MessageTurn[], OutlineIndex>()

function indexOutline(turns: readonly MessageTurn[]): OutlineIndex {
  const cached = outlineIndexCache.get(turns)
  if (cached) return cached
  const turnIndexById = new Map<string, number>()
  const subAgentsByUserTurnId = new Map<string, DelegationCardSource[]>()
  let current: string | null = null
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]
    if (turn.role === "user") {
      turnIndexById.set(turn.id, i)
      current = turn.id
      continue
    }
    if (turn.role !== "assistant" || current == null) continue
    const sources = outlineTurnSubAgents(turn)
    if (sources.length === 0) continue
    let list = subAgentsByUserTurnId.get(current)
    if (!list) {
      list = []
      subAgentsByUserTurnId.set(current, list)
    }
    list.push(...sources)
  }
  const index: OutlineIndex = {
    turnIndexById,
    subAgentsByUserTurnId,
    lastUserTurnId: current,
  }
  outlineIndexCache.set(turns, index)
  return index
}

const EMPTY_OUTLINE_INDEX: OutlineIndex = {
  turnIndexById: new Map(),
  subAgentsByUserTurnId: new Map(),
  lastUserTurnId: null,
}

/** What a message's round changed: what its row shows besides its place. */
interface RoundChanges {
  /** The turns of the round after the message, which this was read off. */
  replies: readonly MessageTurn[]
  label: string
  files: readonly FileChangeStat[]
  additions: number
  deletions: number
  /** The entry last built on it, handed out again while the message keeps
   *  its place, number and sub-agents. */
  entry: MessageNavEntry | null
}

/**
 * Per-message memo of a round's changes, keyed by the message's turn and valid
 * while the round's other turns are the same objects — a turn is never edited
 * in place (see `turnFileChanges`). The navigator's entries are rebuilt for
 * the whole conversation on every streaming batch, while only the round being
 * answered changes: every other message keeps its entry, object and all, so a
 * batch costs a walk over the turns rather than a regrouping of every file —
 * and the store, comparing by identity first, finds nothing else to compare.
 */
const roundChangesCache = new WeakMap<MessageTurn, RoundChanges>()

/** `turns[start]` is the message; its round runs to `end`. */
function roundChanges(
  turns: readonly MessageTurn[],
  start: number,
  end: number
): RoundChanges {
  const message = turns[start]
  const cached = roundChangesCache.get(message)
  if (cached && cached.replies.length === end - start - 1) {
    let same = true
    for (let i = start + 1; i < end && same; i++) {
      same = cached.replies[i - start - 1] === turns[i]
    }
    if (same) return cached
  }
  const round = turns.slice(start, end)
  // One message, so one group.
  const [group] = extractSessionFilesGrouped(round, { includeEmpty: true })
  let additions = 0
  let deletions = 0
  for (const file of group.files) {
    additions += file.additions
    deletions += file.deletions
  }
  const changes: RoundChanges = {
    replies: round.slice(1),
    label: group.userMessage,
    files: mergeFileChangesByPath(group.files),
    additions,
    deletions,
    entry: null,
  }
  roundChangesCache.set(message, changes)
  return changes
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return (
    a === b || (a.length === b.length && a.every((item, i) => item === b[i]))
  )
}

/**
 * The sub-agents of a round the loaded window starts inside: those of its
 * replies above the window (`above`, from the outline), then those of the
 * replies loaded ahead of the first loaded message (`below`). Joined by the
 * rule a fully loaded round follows: one row per call — the loaded copy when
 * both hold it — and no row for a resume of a task the round already started,
 * since the resume re-binds that task's child to the original call and its row
 * tracks the resumed run.
 */
function joinRoundSubAgents(
  above: readonly DelegationCardSource[],
  below: readonly DelegationCardSource[]
): readonly DelegationCardSource[] {
  if (above.length === 0) return below
  if (below.length === 0) return above
  const belowCalls = new Set(below.map((source) => source.parentToolUseId))
  const startedTasks = new Set<string>()
  for (const source of above) {
    const taskId = parseDelegationMeta(source.meta)?.taskId
    if (taskId) startedTasks.add(taskId)
  }
  return [
    ...above.filter((source) => !belowCalls.has(source.parentToolUseId)),
    ...below.filter(
      (source) =>
        source.taskIdHint == null || !startedTasks.has(source.taskIdHint)
    ),
  ]
}

/**
 * One navigator entry per user message: every message of the conversation
 * when `earlierTurns` is given, otherwise the loaded ones, numbered on from
 * the `earlierUserCount` messages above them so a message keeps its number
 * whether or not the history above it is listed yet.
 *
 * The earlier and loaded turns are grouped as one transcript, so a round that
 * straddles the window start (its prompt above, part of its reply loaded)
 * still collects all of its files and sub-agents. An entry for a loaded
 * message carries its thread index; one above the window carries its global
 * turn index, which is what paging it in needs.
 *
 * A message is listed once even if both lists hold it: a background-activity
 * overlay turn stays in the timeline while its persisted twin is above the
 * window (the overlay can't be retired until the window covers the twin), and
 * the two share an id. It is listed where the history puts it, and jumps to
 * the copy that renders.
 *
 * A message whose round, place, number and sub-agents are what they were the
 * last time keeps its entry object (see `roundChangesCache`).
 */
export function buildMessageNavEntries({
  earlierTurns,
  earlierUserCount,
  loadedTurns,
  threadIndexByTurnId,
  loadedSubAgents,
}: MessageNavEntriesInput): MessageNavEntry[] {
  const hasEarlier = earlierTurns != null && earlierTurns.length > 0
  const turns = hasEarlier ? [...earlierTurns, ...loadedTurns] : loadedTurns
  const outline = hasEarlier ? indexOutline(earlierTurns) : EMPTY_OUTLINE_INDEX

  const entries: MessageNavEntry[] = []
  const listed = new Set<string>()
  let ordinal = earlierTurns ? 0 : earlierUserCount
  // Replies ahead of the first message belong to none.
  let start = 0
  while (start < turns.length && turns[start].role !== "user") start++
  while (start < turns.length) {
    let end = start + 1
    while (end < turns.length && turns[end].role !== "user") end++
    const turnId = turns[start].id
    const roundStart = start
    start = end
    if (listed.has(turnId)) continue
    listed.add(turnId)
    const threadIndex = threadIndexByTurnId.get(turnId) ?? null
    const outlineIndex = outline.turnIndexById.get(turnId)
    const turnIndex = threadIndex == null ? (outlineIndex ?? null) : null
    if (threadIndex == null && turnIndex == null) continue
    // The sub-agents of the same copy of the round its files come from: the
    // history's when the outline lists the message — a rendered overlay twin
    // included, as for the files — and otherwise the loaded thread's.
    let subAgents: readonly DelegationCardSource[]
    if (outlineIndex != null) {
      subAgents = outline.subAgentsByUserTurnId.get(turnId) ?? NO_SUB_AGENTS
      // The round the loaded window starts in the middle of: the rest of its
      // sub-agents are in the loaded replies ahead of the first loaded
      // message.
      if (turnId === outline.lastUserTurnId && loadedSubAgents) {
        subAgents = joinRoundSubAgents(subAgents, loadedSubAgents.leading)
      }
    } else {
      subAgents = loadedSubAgents?.byUserTurnId.get(turnId) ?? NO_SUB_AGENTS
    }
    ordinal += 1
    const changes = roundChanges(turns, roundStart, end)
    const previous = changes.entry
    const entry =
      previous != null &&
      previous.threadIndex === threadIndex &&
      previous.turnIndex === turnIndex &&
      previous.ordinal === ordinal &&
      sameItems(previous.subAgents, subAgents)
        ? previous
        : {
            threadIndex,
            turnIndex,
            turnId,
            ordinal,
            label: changes.label,
            additions: changes.additions,
            deletions: changes.deletions,
            files: changes.files,
            subAgents,
            hasChanges: changes.files.length > 0,
          }
    changes.entry = entry
    entries.push(entry)
  }
  return entries
}
