"use client"

/**
 * DelegationContext — tracks live parent ↔ child delegation bindings
 * indexed by `parent_tool_use_id`.
 *
 * The parent's `delegate_to_agent` ToolCallBlock needs to render the child
 * sub-session inline. Both wire events (`delegation_started` /
 * `delegation_completed`) are emitted on the *parent*'s connection stream by
 * the broker, so this context subscribes via the provider's `useAcpEvent`
 * fanout — which is fed by the Tauri firehose AND the per-connection attach
 * streams, so it behaves identically in desktop and web/server runtimes. It
 * filters the two delegation variants and exposes a tool-use-id-keyed lookup
 * so ToolCallBlock can resolve the binding by the field it already has in hand.
 *
 * State stays in-memory; persistence across reloads relies on the
 * parent_tool_use_id stored on the child's DB row (Phase 7).
 *
 * On the child's blocking prompts: attaching the child (below) is what makes
 * them visible at all. The permission store stays per-connection — a child's
 * `permission_request` is never re-keyed onto the parent's ToolCallBlock — but
 * because the child IS a connection in the store, `useDelegationCardModel`
 * reads its `pendingPermission` directly and badges the delegation card
 * "waiting", and `SubAgentSessionDialog` answers through the child's own
 * connection id. Surfaces OUTSIDE this transcript (the pet badge/panel, the
 * work-task row, `get_delegation_status`) are handled in the backend, not here
 * — see `pet_list_active_sessions_core` and the broker's `blocked_on` (#447).
 */

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import type { AgentType, EventEnvelope } from "@/lib/types"
import { useAcpActions, useAcpEvent } from "@/contexts/acp-connections-context"

export type DelegationStatus = "running" | "ok" | "err"

export interface DelegationBinding {
  parentConnectionId: string
  parentToolUseId: string
  childConnectionId: string
  childConversationId: number
  agentType: AgentType
  status: DelegationStatus
  errorCode?: string
  /** Bounded task text from `delegation_started`. The card's fallback when
   *  the tool call's `raw_input` never carried the arguments (Cursor's
   *  identity-less announcements). */
  task: string | null
  /** Broker-minted task id from `delegation_started`. */
  taskId: string | null
  /** The assistant the child runs as (then `agentType` is ITS agent), and its
   *  name when the delegation started; null for a plain agent delegation. */
  assistantId: number | null
  assistantName: string | null
}

interface DelegationContextValue {
  findByParentToolUseId(id: string): DelegationBinding | undefined
  findByChildConversationId(id: number): DelegationBinding | undefined
  /**
   * Resolve a binding by the broker-minted task id rather than the parent's
   * tool_use_id. `resume_delegation` needs this: it re-binds the child to the
   * ORIGINAL `delegate_to_agent` call's id, so the resume card's own
   * tool_call_id matches no binding — the task id is the only handle it holds.
   */
  findByTaskId(taskId: string): DelegationBinding | undefined
}

const DelegationContext = createContext<DelegationContextValue | null>(null)

export function useDelegation(): DelegationContextValue {
  const ctx = useContext(DelegationContext)
  if (!ctx) {
    throw new Error("useDelegation must be used within DelegationProvider")
  }
  return ctx
}

/** Grace period after `delegation_completed` before tearing down the
 *  synthetic child ConnectionState. Long enough for the parent UI to
 *  finish rendering the child's final assistant text from live state
 *  before falling through to the DB-persisted view. */
const CHILD_DETACH_GRACE_MS = 2_000

export function DelegationProvider({ children }: { children: ReactNode }) {
  const { attachDelegationChild, detachDelegationChild } = useAcpActions()
  const [byToolUseId, setByToolUseId] = useState<
    Map<string, DelegationBinding>
  >(() => new Map())

  // Stable refs so the event-subscription effect doesn't tear down on
  // every action identity change (the actions object is memoized but
  // its members are stable callbacks; still, defensive ref-pinning
  // keeps the subscription stable across React's StrictMode double-effect).
  const attachRef = useRef(attachDelegationChild)
  const detachRef = useRef(detachDelegationChild)
  useEffect(() => {
    attachRef.current = attachDelegationChild
  }, [attachDelegationChild])
  useEffect(() => {
    detachRef.current = detachDelegationChild
  }, [detachDelegationChild])

  // Pending detach timers — one per parent_tool_use_id. Started on
  // `delegation_completed`, cleared if a fresh `delegation_started`
  // arrives for the same parent_tool_use_id before the timer fires.
  const detachTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>()
  )

  const cancelDetachTimer = useCallback((parentToolUseId: string) => {
    const timers = detachTimersRef.current
    const t = timers.get(parentToolUseId)
    if (t) {
      clearTimeout(t)
      timers.delete(parentToolUseId)
    }
  }, [])

  const handleEnvelope = useCallback(
    (envelope: EventEnvelope) => {
      if (envelope.type === "delegation_started") {
        const next: DelegationBinding = {
          parentConnectionId: envelope.parent_connection_id,
          parentToolUseId: envelope.parent_tool_use_id,
          childConnectionId: envelope.child_connection_id,
          childConversationId: envelope.child_conversation_id,
          agentType: envelope.agent_type,
          status: "running",
          task: envelope.task_preview ?? null,
          taskId: envelope.task_id ?? null,
          assistantId: envelope.assistant_id ?? null,
          assistantName: envelope.assistant_name ?? null,
        }
        setByToolUseId((prev) => {
          const m = new Map(prev)
          m.set(envelope.parent_tool_use_id, next)
          return m
        })
        // Cancel any pending detach for this parent_tool_use_id —
        // delegation_started can be replayed after a partial flow
        // (e.g. reconnect), and an in-flight detach would tear the
        // child state down right as it returns.
        cancelDetachTimer(envelope.parent_tool_use_id)
        // Pull the child connection into the reducer so its
        // streaming text / tool calls / pendingPermission reach
        // the parent's DelegatedSubThread inline.
        attachRef.current({
          connectionId: envelope.child_connection_id,
          parentConnectionId: envelope.parent_connection_id,
          parentToolUseId: envelope.parent_tool_use_id,
          agentType: envelope.agent_type,
        })
        return
      }
      if (envelope.type === "delegation_completed") {
        setByToolUseId((prev) => {
          const existing = prev.get(envelope.parent_tool_use_id)
          // If we missed the start event (e.g. context mounted mid-flight,
          // reconnect, or snapshot replay that only re-delivered the
          // completion), synthesize a minimal binding so the parent UI still
          // shows the result — with the real agent_type the event now carries,
          // so the card renders the correct agent icon/label.
          const base: DelegationBinding = existing ?? {
            parentConnectionId: envelope.parent_connection_id,
            parentToolUseId: envelope.parent_tool_use_id,
            childConnectionId: envelope.child_connection_id,
            childConversationId: envelope.child_conversation_id,
            agentType: envelope.agent_type,
            status: "running",
            // Missed-start synthesis: the completion event carries no task
            // label; the card recovers it from the terminal meta instead.
            task: null,
            taskId: null,
            assistantId: envelope.assistant_id ?? null,
            assistantName: envelope.assistant_name ?? null,
          }
          const updated: DelegationBinding =
            envelope.result.kind === "ok"
              ? {
                  ...base,
                  status: "ok",
                }
              : {
                  ...base,
                  status: "err",
                  errorCode: envelope.result.error_code,
                }
          const m = new Map(prev)
          m.set(envelope.parent_tool_use_id, updated)
          return m
        })

        // Schedule detach of the synthetic child entry. We keep it
        // around briefly so the final assistant text rendered from
        // live state survives long enough for the user to read it
        // before the parent UI falls back to the DB-persisted view.
        const parentToolUseId = envelope.parent_tool_use_id
        const childConnectionId = envelope.child_connection_id
        cancelDetachTimer(parentToolUseId)
        const timer = setTimeout(() => {
          detachTimersRef.current.delete(parentToolUseId)
          detachRef.current(childConnectionId)
        }, CHILD_DETACH_GRACE_MS)
        detachTimersRef.current.set(parentToolUseId, timer)
      }
    },
    [cancelDetachTimer]
  )

  // Single subscription via the provider's fanout. `useAcpEvent` fires for
  // every mapped envelope on both the Tauri firehose and the per-connection
  // attach streams, so the parent-stream delegation events reach us in both
  // desktop and web/server runtimes; non-delegation types are ignored above.
  useAcpEvent(handleEnvelope)

  // Clear any pending detach timers on unmount. The synthetic children are
  // also cleaned up by the connections context's own teardown.
  useEffect(() => {
    const timers = detachTimersRef.current
    return () => {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }, [])

  const findByParentToolUseId = useCallback(
    (id: string): DelegationBinding | undefined => byToolUseId.get(id),
    [byToolUseId]
  )

  const findByChildConversationId = useCallback(
    (id: number): DelegationBinding | undefined => {
      for (const b of byToolUseId.values()) {
        if (b.childConversationId === id) return b
      }
      return undefined
    },
    [byToolUseId]
  )

  const findByTaskId = useCallback(
    (taskId: string): DelegationBinding | undefined => {
      if (!taskId) return undefined
      for (const b of byToolUseId.values()) {
        if (b.taskId === taskId) return b
      }
      return undefined
    },
    [byToolUseId]
  )

  const value = useMemo(
    () => ({ findByParentToolUseId, findByChildConversationId, findByTaskId }),
    [findByParentToolUseId, findByChildConversationId, findByTaskId]
  )

  return (
    <DelegationContext.Provider value={value}>
      {children}
    </DelegationContext.Provider>
  )
}
