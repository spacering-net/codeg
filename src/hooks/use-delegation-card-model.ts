"use client"

/**
 * Resolves a unified "delegation card model" — agent type, task, status,
 * child ids — from a `delegate_to_agent` tool call, in priority order:
 *   live `DelegationContext` binding → persisted `meta["codeg.delegation"]`
 *   → parsed tool input/output. The same model drives both the inline
 *   `DelegatedSubThread` card and the top-right `SubAgentOverlay`, so the two
 *   never disagree on what a sub-agent is doing.
 *
 * Pure parsing lives in `@/lib/delegation-card`; this hook adds the two
 * React-state reads it can't do on its own: the live binding
 * (`useDelegatedSubSession`) and whether the child connection is parked on a
 * decision (so the card can badge "waiting").
 */

import { useCallback, useMemo, useSyncExternalStore } from "react"

import { type AgentType } from "@/lib/types"
import type { ToolCallState } from "@/lib/adapters/ai-elements-adapter"
import {
  useConnectionStore,
  type ConnectionState,
} from "@/contexts/acp-connections-context"
import { useDelegatedSubSession } from "@/hooks/use-delegated-sub-session"
import { blockingPrompts } from "@/lib/blocking-prompts"
import {
  isAffirmedResume,
  parseDelegateTaskId,
  parseDelegationMeta,
  parseInput,
  parseToolOutput,
  resolveDelegationStatus,
  type DelegationCardStatus,
  type ParsedToolOutput,
} from "@/lib/delegation-card"

/** The raw inputs a `delegate_to_agent` tool call carries — the props
 *  `DelegatedSubThread` already receives, and the shape `SubAgentOverlay`
 *  extracts from the last assistant turn's tool-call parts. */
export interface DelegationCardSource {
  parentToolUseId: string
  input?: string | null
  output?: string | null
  errorText?: string | null
  state?: ToolCallState
  meta?: Record<string, unknown> | null
  /**
   * A broker task id to resolve the live binding by when `parentToolUseId`
   * matches none. Set by `ResumedDelegationCard`: a resume re-binds the child
   * to the ORIGINAL `delegate_to_agent` call's tool_use_id, so the resume
   * call's own id is never a binding key — the task id in its arguments is.
   */
  taskIdHint?: string | null
}

/**
 * Who a delegation card shows as running the task: an assistant (with the
 * agent it ran on, when known) or a bare agent. Resolved once here and handed
 * whole to every surface that draws it (`DelegationIdentityAvatar` /
 * `DelegationIdentityName`), so none can fall back to the bare agent.
 */
export interface DelegationIdentity {
  /** The agent that runs (ran) the task. For an assistant, taken only from the
   *  backend's own evidence — never from the call's `agent_type` argument,
   *  which the backend ignores — so it stays null until that arrives. */
  agentType: AgentType | null
  assistantId: number | null
  /** The assistant's name when the delegation started: the fallback for a row
   *  the assistants store does not hold. */
  assistantName: string | null
}

export interface DelegationCardModel {
  agentType: AgentType | null
  identity: DelegationIdentity
  task: string | null
  taskId: string | null
  status: DelegationCardStatus
  errorCode: string | undefined
  childConversationId: number | null
  childConnectionId: string | null
  /** False when there's no live binding and the input parsed to neither an
   *  agent type nor a task — nothing useful to draw. Callers render null. */
  hasModel: boolean
}

/**
 * Subscribe to the child connection's `ConnectionState` (live message,
 * pending permission, etc.) from the shared connections store. Returns
 * `undefined` while no synthetic entry exists yet. Re-renders on every state
 * change via `useSyncExternalStore`.
 */
function useDelegationChildLive(
  childConnectionId: string | null
): ConnectionState | undefined {
  const store = useConnectionStore()
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!childConnectionId) return () => {}
      return store.subscribeKey(childConnectionId, cb)
    },
    [store, childConnectionId]
  )
  const getSnapshot = useCallback(
    () =>
      childConnectionId ? store.getConnection(childConnectionId) : undefined,
    [store, childConnectionId]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useDelegationCardModel(
  source: DelegationCardSource
): DelegationCardModel {
  const { parentToolUseId, input, output, errorText, state, meta, taskIdHint } =
    source

  const parsed = useMemo(() => parseInput(input), [input])
  const parsedMeta = useMemo(() => parseDelegationMeta(meta), [meta])
  const taskId = useMemo(
    () => parseDelegateTaskId(output, errorText),
    [output, errorText]
  )

  // `enabled: false` — the model never fetches the child's persisted detail; it
  // only needs the live `binding` (agent type, status, child ids). The child's
  // output is viewed via "查看会话" (SubAgentSessionDialog).
  const { binding: matchedBinding } = useDelegatedSubSession(parentToolUseId, {
    enabled: false,
    fallbackTaskId: taskIdHint,
  })

  // Parse the parent `delegate_to_agent` tool output once. Under async this is
  // a running *ack* (kind:"ack") while the child runs; a terminal kind:"outcome"
  // only for a fast-complete or a legacy synchronous result. Used purely to
  // derive the status badge and the child id for synthetic-id cards.
  const toolOutput = useMemo<ParsedToolOutput | null>(() => {
    if (errorText) {
      const parsedErr = parseToolOutput(errorText, true)
      if (parsedErr) return parsedErr
    }
    return parseToolOutput(output)
  }, [output, errorText])

  // A `taskIdHint` match must be CORROBORATED before it is trusted.
  //
  // `findByTaskId` scans the whole workspace's bindings — `DelegationProvider`
  // is mounted once in `app/workspace/layout.tsx`, above every conversation —
  // and a task id is just an argument the model wrote. Hand it another
  // conversation's id and the backend correctly refuses (`unknown_report`,
  // which names no agent and no child), but an unguarded lookup would still
  // find that conversation's binding and paint its agent, its task text and an
  // "open conversation" button into this one.
  //
  // So a task-id match is only an ENRICHMENT of a card this call's own
  // evidence already identifies. Two things can supply that evidence, and a
  // host that keeps the structured report gives the first:
  //   1. the report or the injected meta names the SAME child conversation
  //      (`broker.rs::resume_ack` carries `child_conversation_id`);
  //   2. failing that, the result AFFIRMS this resume in words. Hosts that
  //      drop `structuredContent` (OpenCode) leave only the message text, so
  //      requiring a child id would reject every binding forever and the live
  //      resumed card would never track its child. "Delegation resumed" still
  //      separates a real resume from `unknown_report`'s "Unknown task id",
  //      which is what a foreign id lands on.
  // A direct `parentToolUseId` hit needs none of this: that id is the binding
  // key itself, not a value the model chose.
  const binding = useMemo(() => {
    if (!matchedBinding) return undefined
    if (matchedBinding.parentToolUseId === parentToolUseId)
      return matchedBinding
    const named =
      toolOutput?.childConversationId ?? parsedMeta?.childConversationId
    if (named != null) {
      return named === matchedBinding.childConversationId
        ? matchedBinding
        : undefined
    }
    return isAffirmedResume(output, errorText) ? matchedBinding : undefined
  }, [
    matchedBinding,
    parentToolUseId,
    toolOutput,
    parsedMeta,
    output,
    errorText,
  ])

  // Resolution order: live binding → persisted snapshot meta → the broker's
  // ack output (the synthetic-id path that emits no binding/meta).
  const childConnectionId =
    binding?.childConnectionId ?? parsedMeta?.childConnectionId ?? null
  const childConversationId =
    binding?.childConversationId ??
    parsedMeta?.childConversationId ??
    toolOutput?.childConversationId ??
    null

  const childLive = useDelegationChildLive(childConnectionId)
  // Parked on ANY decision — a permission, a question, a plan approval — as
  // the backend's `blocked_on` and the `get_delegation_status` row count it.
  const childAwaitingUser = blockingPrompts(childLive) != null

  // The assistant the task runs as: the live binding → the call's own
  // `assistant_id` → the broker report → the historical meta. Its name comes
  // from the same places, bar the call (which carries none).
  const assistantId =
    binding?.assistantId ??
    parsed.assistantId ??
    toolOutput?.assistantId ??
    parsedMeta?.assistantId ??
    null
  const assistantName =
    binding?.assistantName ??
    toolOutput?.assistantName ??
    parsedMeta?.assistantName ??
    null

  // Live binding → the call's own `agent_type` argument → the broker report's
  // `agent_type` → the historical meta injected from the child's DB row. The
  // last two are what a `resume_delegation` card runs on: its arguments name a
  // task, never an agent. A call that names an assistant skips its own
  // `agent_type`: the backend ignores it (the assistant decides), so a host
  // that fills it in anyway must not paint the wrong agent.
  const agentType: AgentType | null =
    binding?.agentType ??
    (assistantId === null ? parsed.agentType : null) ??
    toolOutput?.agentType ??
    parsedMeta?.agentType ??
    null
  const identity = useMemo<DelegationIdentity>(
    () => ({ agentType, assistantId, assistantName }),
    [agentType, assistantId, assistantName]
  )
  const status = resolveDelegationStatus({
    binding,
    parsedMeta,
    toolOutput,
    state,
    errorText,
    childAwaitingUser,
  })
  // The report is the only source for a call refused before any delegation
  // started (`assistant_not_found`, the companion's local refusals): no
  // binding, no meta.
  const errorCode =
    binding?.errorCode ??
    parsedMeta?.errorCode ??
    toolOutput?.errorCode ??
    undefined

  return {
    agentType,
    identity,
    // Parsed raw_input first (full text on hosts that carry it), then the
    // live binding's preview, then the broker meta — the latter two are the
    // only sources on hosts whose announcements never carry arguments
    // (Cursor), covering live / refresh-mid-run / persisted respectively.
    task: parsed.task ?? binding?.task ?? parsedMeta?.task ?? null,
    taskId:
      taskId ?? taskIdHint ?? binding?.taskId ?? parsedMeta?.taskId ?? null,
    status,
    errorCode,
    childConversationId,
    childConnectionId,
    // Broker-stamped meta alone is proof enough of a delegation — the
    // persisted Cursor shape has empty raw_input and no live binding. So is a
    // report that named the child: a persisted `resume_delegation` result has
    // no binding and no meta until the DB injection runs, but its
    // `agent_type` / `child_conversation_id` already identify the sub-agent.
    hasModel: Boolean(
      binding ||
      parsed.agentType ||
      parsed.assistantId ||
      parsed.task ||
      parsedMeta ||
      toolOutput?.agentType ||
      toolOutput?.childConversationId != null
    ),
  }
}
