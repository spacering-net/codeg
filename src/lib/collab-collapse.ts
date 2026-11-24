/**
 * Live collab-capsule collapse (codex sub-agents).
 *
 * codex emits each collab op (spawn / wait / close) as its own ACP `tool_call`,
 * so a single sub-agent interaction streams as several capsules. This pure pass,
 * run at the top of `buildStreamingTurnsFromLiveMessage`, consolidates them to
 * match the history (Rust) reconstruction and the user's mental model:
 *
 *   - spawn  → the EXECUTION capsule. Its per-agent status is aggregated across
 *     all ops so it no longer freezes at the spawn-time "pendingInit"; the full
 *     result text is NOT shown here (it lives in the wait capsule).
 *   - wait   → kept verbatim, one capsule per wait. codex returns each agent's
 *     result in exactly one wait, so wait capsules never overlap.
 *   - close  → dropped (folded into the execution capsule's terminal status),
 *     unless it targets an agent with no spawn in this message (orphan — kept so
 *     nothing is lost).
 *
 * Non-collab blocks (and every block when there are no collab calls) pass
 * through untouched, so non-codex agents are entirely unaffected.
 */

import type { LiveContentBlock } from "@/contexts/acp-connections-context"
import {
  isCodexCollabInput,
  parseCollabToolInput,
  classifyCollabOp,
  classifyCollabStatus,
  isErrorCollabStatusKind,
  mergeCollabAgentStatus,
} from "./collab-tool"

type CollabAgg = {
  /** Raw status strings across every op that referenced this agent, in order. */
  statuses: (string | null)[]
  /** Latest non-empty progress/result message seen for this agent. */
  lastMessage: string | null
  /** Whether some `wait` reported this agent (→ result shown in a wait capsule). */
  hasWait: boolean
}

type CollabToolCallBlock = Extract<LiveContentBlock, { type: "tool_call" }>

/** Whether each call's input is a collab op, by the call's info: asked of
 *  every call on every streaming batch, and an info is replaced rather than
 *  changed when its call updates. */
const collabByInfo = new WeakMap<CollabToolCallBlock["info"], boolean>()

function isCollabBlock(block: LiveContentBlock): block is CollabToolCallBlock {
  if (block.type !== "tool_call") return false
  let collab = collabByInfo.get(block.info)
  if (collab === undefined) {
    collab = isCodexCollabInput(block.info.raw_input)
    collabByInfo.set(block.info, collab)
  }
  return collab
}

/** Rewrite a spawn block into the execution capsule: aggregated per-agent status,
 *  result message dropped (unless the agent was never waited on), and an ACP
 *  status that reflects the agent lifecycle so the capsule shimmers while running
 *  and settles when done. */
function rewriteExecutionBlock(
  block: CollabToolCallBlock,
  agg: Map<string, CollabAgg>
): LiveContentBlock {
  const raw = block.info.raw_input
  if (!raw) return block
  let parsed: Record<string, unknown>
  try {
    const p: unknown = JSON.parse(raw)
    if (!p || typeof p !== "object" || Array.isArray(p)) return block
    parsed = p as Record<string, unknown>
  } catch {
    return block
  }
  const states = parsed.agentsStates
  if (!states || typeof states !== "object" || Array.isArray(states)) {
    return block
  }

  const newStates: Record<string, unknown> = {}
  let anyError = false
  let anyActive = false
  let anyTerminal = false
  for (const [agentId, value] of Object.entries(
    states as Record<string, unknown>
  )) {
    const entry = agg.get(agentId)
    if (!entry) {
      newStates[agentId] = value
      continue
    }
    const merged = mergeCollabAgentStatus(entry.statuses)
    const kind = classifyCollabStatus(merged)
    newStates[agentId] = {
      status: merged,
      message: entry.hasWait ? null : entry.lastMessage,
    }
    if (isErrorCollabStatusKind(kind)) anyError = true
    else if (kind === "completed" || kind === "closed") anyTerminal = true
    else if (kind === "running" || kind === "pending") anyActive = true
  }

  const newRawInput = JSON.stringify({ ...parsed, agentsStates: newStates })
  const status = anyError
    ? "failed"
    : anyActive
      ? "in_progress"
      : anyTerminal
        ? "completed"
        : block.info.status

  return {
    type: "tool_call",
    info: { ...block.info, raw_input: newRawInput, status },
  }
}

export function collapseLiveCollabBlocks(
  content: LiveContentBlock[]
): LiveContentBlock[] {
  if (!content.some(isCollabBlock)) return content

  // Pass 1 — aggregate each agent's status/message across all collab ops.
  const agg = new Map<string, CollabAgg>()
  const spawnAgentIds = new Set<string>()
  for (const block of content) {
    if (!isCollabBlock(block)) continue
    const op = classifyCollabOp(block.info.title)
    const info = parseCollabToolInput(block.info.raw_input)
    if (!info) continue
    for (const a of info.agents) {
      const entry = agg.get(a.threadId) ?? {
        statuses: [],
        lastMessage: null,
        hasWait: false,
      }
      entry.statuses.push(a.status)
      if (a.message) entry.lastMessage = a.message
      if (op === "wait") entry.hasWait = true
      agg.set(a.threadId, entry)
      if (op === "spawn") spawnAgentIds.add(a.threadId)
    }
  }

  // Pass 2 — rebuild: drop close, rewrite spawn, keep wait + everything else.
  const result: LiveContentBlock[] = []
  for (const block of content) {
    if (!isCollabBlock(block)) {
      result.push(block)
      continue
    }
    const op = classifyCollabOp(block.info.title)
    if (op === "close") {
      const ids =
        parseCollabToolInput(block.info.raw_input)?.agents.map(
          (a) => a.threadId
        ) ?? []
      // Drop only when every targeted agent has a spawn capsule to absorb it.
      if (ids.length > 0 && ids.every((id) => spawnAgentIds.has(id))) continue
      result.push(block)
      continue
    }
    if (op === "spawn") {
      result.push(rewriteExecutionBlock(block, agg))
      continue
    }
    result.push(block)
  }
  return result
}
