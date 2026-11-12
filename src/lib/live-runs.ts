/**
 * What a connection has running right now, beyond the turn itself — the list
 * behind the composer's "N running" chip (`LiveActivityBar`).
 *
 * Three kinds, each from the one source that can say it is still alive:
 *
 * - **Background tasks** — the AIR async-task table (`liveAsyncTasks`):
 *   Claude's background shells, workflows and monitors and the turns Claude
 *   starts on its own, codex's background terminals, Grok's workflows. The
 *   adapter reports their terminal edge, and can stop them.
 * - **Sub-agents** — the agent's own. A FOREGROUND one is an Agent / collab
 *   call of the reply now streaming that has not settled: it blocks its turn,
 *   so it never outlives it. A BACKGROUND one returns at once and works on
 *   after its turn; only its producer's outstanding set
 *   (`BackgroundOutstandingTask`, kind `agent`) knows it is still out — its
 *   launch card can't (a transcript can't tell a live task from one whose CLI
 *   died). Background shells there are left out: the task table lists them,
 *   with a stop.
 * - **Delegations** — codeg's `delegate_to_agent` children. WHICH still run is
 *   the parent's `delegatedChildren` (the backend's word, recovered by a
 *   snapshot); the `DelegationProvider` binding only supplies who and what.
 *   A child with a finished binding is on its way out and is not listed; one
 *   with none (its call never got a card) is listed bare.
 *
 * Kept dependency-free of React for unit testing.
 */

import type {
  AdaptedContentPart,
  AdaptedToolCallPart,
} from "@/lib/adapters/ai-elements-adapter"
import { toolStepKind } from "@/lib/activity/describe-tool-call"
import { liveAsyncTasks } from "@/lib/async-tasks"
import { isUnsettledToolCall } from "@/lib/tool-call-lifecycle"
import type {
  AgentType,
  AsyncTaskRecord,
  BackgroundOutstandingTask,
} from "@/lib/types"

/** The parts of a `DelegationProvider` binding the list reads. */
export interface LiveRunDelegationBinding {
  parentToolUseId: string
  childConnectionId: string
  agentType: AgentType
  status: "running" | "ok" | "err"
}

/** One of the agent's own sub-agents still running. */
export interface LiveSubAgentRun {
  /** Stable React key. */
  key: string
  /** Its launch card, when that is in the loaded thread. */
  part: AdaptedToolCallPart | null
  /** Outlives its turn (from the producer's outstanding set). */
  background: boolean
  /** The producer's description of it (background only), the fallback title
   *  when the launch card isn't loaded. */
  description: string | null
  /** When it started, Unix ms (background only). */
  startedAt: number | null
}

/** One codeg delegation still running. */
export interface LiveDelegationRun<
  B extends LiveRunDelegationBinding = LiveRunDelegationBinding,
> {
  childConnectionId: string
  /** `null` when no card's binding names this child. */
  binding: B | null
}

export interface LiveRuns<
  B extends LiveRunDelegationBinding = LiveRunDelegationBinding,
> {
  tasks: AsyncTaskRecord[]
  subagents: LiveSubAgentRun[]
  delegations: LiveDelegationRun<B>[]
  /** Rows in all three — what the chip says. */
  count: number
}

export interface LiveRunsInput<
  B extends LiveRunDelegationBinding = LiveRunDelegationBinding,
> {
  asyncTasks: readonly AsyncTaskRecord[]
  /** The streaming reply's unsettled sub-agent calls (`runningSubAgentCalls`);
   *  empty while no turn runs. */
  foregroundAgents: readonly AdaptedToolCallPart[]
  backgroundTasks: readonly BackgroundOutstandingTask[]
  /** A background sub-agent's launch card, by its tool call id. */
  findLaunchCard: (toolCallId: string) => AdaptedToolCallPart | null
  delegatedChildren: readonly string[]
  /** This connection's delegation bindings, finished ones included. */
  delegationBindings: readonly B[]
}

export function collectLiveRuns<B extends LiveRunDelegationBinding>(
  input: LiveRunsInput<B>
): LiveRuns<B> {
  const tasks = liveAsyncTasks(input.asyncTasks as AsyncTaskRecord[])

  const subagents: LiveSubAgentRun[] = []
  const seenCalls = new Set<string>()
  for (const part of input.foregroundAgents) {
    if (seenCalls.has(part.toolCallId)) continue
    seenCalls.add(part.toolCallId)
    subagents.push({
      key: `call:${part.toolCallId}`,
      part,
      background: false,
      description: null,
      startedAt: null,
    })
  }
  for (const task of input.backgroundTasks) {
    if (task.kind !== "agent") continue
    const callId = task.tool_use_id ?? null
    // Already listed as the streaming reply's own call.
    if (callId && seenCalls.has(callId)) continue
    if (callId) seenCalls.add(callId)
    subagents.push({
      key: `bg:${task.task_id}`,
      part: callId ? input.findLaunchCard(callId) : null,
      background: true,
      description: task.description ?? null,
      startedAt: task.started_at_ms > 0 ? task.started_at_ms : null,
    })
  }

  // A child can be bound more than once (a resume re-binds it); the running
  // binding is the one that speaks for it.
  const bindingByChild = new Map<string, B>()
  for (const binding of input.delegationBindings) {
    const current = bindingByChild.get(binding.childConnectionId)
    if (!current || binding.status === "running") {
      bindingByChild.set(binding.childConnectionId, binding)
    }
  }
  const delegations: LiveDelegationRun<B>[] = []
  const seenChildren = new Set<string>()
  for (const child of input.delegatedChildren) {
    if (seenChildren.has(child)) continue
    seenChildren.add(child)
    const binding = bindingByChild.get(child) ?? null
    // Its completion is already in: it leaves with the backend's next word.
    if (binding && binding.status !== "running") continue
    delegations.push({ childConnectionId: child, binding })
  }

  return {
    tasks,
    subagents,
    delegations,
    count: tasks.length + subagents.length + delegations.length,
  }
}

/** Whether a tool call starts one of the agent's own sub-agents. */
function isSubAgentCall(part: AdaptedToolCallPart): boolean {
  const kind = toolStepKind(part)
  return kind === "agent" || kind === "collab-agent"
}

/**
 * The sub-agent calls in a reply's parts that have not settled — the reply's
 * foreground sub-agents still at work. Recurses into goal runs, as the
 * timeline draws them.
 */
export function runningSubAgentCalls(
  parts: readonly AdaptedContentPart[]
): AdaptedToolCallPart[] {
  const out: AdaptedToolCallPart[] = []
  collectRunningSubAgentCalls(parts, out)
  return out
}

function collectRunningSubAgentCalls(
  parts: readonly AdaptedContentPart[],
  out: AdaptedToolCallPart[]
): void {
  for (const part of parts) {
    if (part.type === "tool-call") {
      if (part.toolCallId && isUnsettledToolCall(part) && isSubAgentCall(part))
        out.push(part)
    } else if (part.type === "goal-run") {
      collectRunningSubAgentCalls(part.items, out)
    }
  }
}

// Per parts array: a historical group keeps its parts' identity across
// streaming batches, so a lookup re-scans only the reply that changed.
const subAgentCallsByParts = new WeakMap<
  readonly AdaptedContentPart[],
  ReadonlyMap<string, AdaptedToolCallPart>
>()

/** A reply's sub-agent calls by tool call id, settled or not. */
export function subAgentCallsById(
  parts: readonly AdaptedContentPart[]
): ReadonlyMap<string, AdaptedToolCallPart> {
  let index = subAgentCallsByParts.get(parts)
  if (!index) {
    const map = new Map<string, AdaptedToolCallPart>()
    indexSubAgentCalls(parts, map)
    index = map
    subAgentCallsByParts.set(parts, index)
  }
  return index
}

function indexSubAgentCalls(
  parts: readonly AdaptedContentPart[],
  out: Map<string, AdaptedToolCallPart>
): void {
  for (const part of parts) {
    if (part.type === "tool-call") {
      if (part.toolCallId && isSubAgentCall(part))
        out.set(part.toolCallId, part)
    } else if (part.type === "goal-run") {
      indexSubAgentCalls(part.items, out)
    }
  }
}
