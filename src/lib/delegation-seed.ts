import type { ActiveDelegationState, EventEnvelope } from "@/lib/types"

/**
 * Build the `delegation_started` envelopes that re-seed `DelegationProvider`
 * bindings from a snapshot's `active_delegations`.
 *
 * `active_delegations` is the backend's RUNNING-only set (completed delegations
 * are removed and recovered elsewhere — the live binding, or the child's
 * persisted DB row via `inject_delegation_meta`), so every entry maps to a
 * `delegation_started`. The transient `DelegationStarted` event mutates no
 * persisted state and isn't replayed on the snapshot attach path, so without
 * this re-seed a web/server client that cold-attaches, re-attaches after a
 * broadcast lag, or refreshes mid-delegation never establishes the running
 * binding — the card shows a premature "completed" and no "查看会话" until the
 * child finishes. This reproduces the same envelope the broker emits live; the
 * caller fans it to the JS event subscribers (DelegationProvider), which
 * re-attaches the child's live stream. `connectionId` is the parent (the
 * snapshot's own connection_id); `eventSeq` is informational (DelegationProvider
 * ignores it).
 */
export function buildDelegationSeedEnvelopes(
  connectionId: string,
  activeDelegations: ActiveDelegationState[],
  eventSeq: number
): EventEnvelope[] {
  const out: EventEnvelope[] = []
  for (const d of activeDelegations) {
    out.push({
      seq: eventSeq,
      connection_id: connectionId,
      type: "delegation_started",
      parent_connection_id: connectionId,
      parent_tool_use_id: d.parent_tool_use_id,
      child_connection_id: d.child_connection_id,
      child_conversation_id: d.child_conversation_id,
      agent_type: d.agent_type,
      task_preview: d.task_preview ?? null,
      task_id: d.task_id ?? null,
      assistant_id: d.assistant_id ?? null,
      assistant_name: d.assistant_name ?? null,
    })
  }
  return out
}
