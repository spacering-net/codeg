"use client"

/**
 * The live sub-agent behind a `get_delegation_status` row: whether this window
 * holds its connection, and what it is parked on right now.
 *
 * A status poll returns a SNAPSHOT — "running, awaiting your decision" at the
 * moment of the check — while the decision itself lives on the sub-agent's own
 * connection. Reading that connection is what lets the row offer the prompt
 * where it says "awaiting approval" (#973), and drop the claim once the prompt
 * is answered instead of repeating a stale poll until the next one.
 *
 * The task id is resolved through `DelegationProvider`'s workspace-wide
 * bindings, so it is only looked up once the backend has vouched for it
 * (`DelegationTaskRow.runningConfirmed`): a poll's `task_ids` are arguments the
 * model wrote, and another conversation's id must not pull that conversation's
 * sub-agent into this one.
 *
 * Tolerates rendering outside the providers — then there is no live state and
 * the row is exactly what the poll said.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react"

import {
  useOptionalConnectionStore,
  type ConnectionState,
} from "@/contexts/acp-connections-context"
import { useOptionalDelegation } from "@/contexts/delegation-context"
import { blockingPrompts, type BlockingPrompts } from "@/lib/blocking-prompts"
import type { AgentType } from "@/lib/types"

export interface DelegationTaskLive {
  /** The sub-agent's connection — what every answer is routed through. */
  childConnectionId: string | null
  agentType: AgentType | null
  /** What the running sub-agent is parked on right now, if anything. */
  prompts: BlockingPrompts | null
  /** This window KNOWS the sub-agent is not waiting on the user: it holds the
   *  running sub-agent's state and that has no prompt, or the delegation has
   *  ended. `false` also when nothing is known — then only the polls speak. */
  notWaiting: boolean
}

const NO_SUBSCRIPTION = () => () => {}

export function useDelegationTaskLive(
  taskId: string | null,
  runningConfirmed: boolean
): DelegationTaskLive {
  const delegation = useOptionalDelegation()
  const binding =
    taskId && runningConfirmed ? delegation?.findByTaskId(taskId) : undefined
  const childConnectionId = binding?.childConnectionId ?? null

  const store = useOptionalConnectionStore()
  const subscribe = useCallback(
    (cb: () => void) =>
      store && childConnectionId
        ? store.subscribeKey(childConnectionId, cb)
        : NO_SUBSCRIPTION(),
    [store, childConnectionId]
  )
  const getSnapshot = useCallback(
    (): ConnectionState | undefined =>
      store && childConnectionId
        ? store.getConnection(childConnectionId)
        : undefined,
    [store, childConnectionId]
  )
  const conn = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // Only a running delegation asks anything: once it has ended, whatever its
  // connection still holds in the moments before it is released is moot.
  // Kept while the pending prompts are the same objects, as the store keeps
  // them across the connection's other updates: a new value re-renders the
  // prompt cards the row hands it to.
  const running = binding?.status === "running"
  const pendingPermission = conn?.pendingPermission ?? null
  const pendingAskQuestion = conn?.pendingAskQuestion ?? null
  const pendingPlanApproval = conn?.pendingPlanApproval ?? null
  const prompts = useMemo(
    () =>
      running
        ? blockingPrompts({
            pendingPermission,
            pendingAskQuestion,
            pendingPlanApproval,
          })
        : null,
    [running, pendingPermission, pendingAskQuestion, pendingPlanApproval]
  )
  return {
    childConnectionId,
    agentType: conn?.agentType ?? binding?.agentType ?? null,
    prompts,
    notWaiting:
      binding != null && (!running || (conn != null && prompts == null)),
  }
}
