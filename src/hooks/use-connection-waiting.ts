"use client"

import { useCallback, useSyncExternalStore } from "react"
import {
  useOptionalConnectionStore,
  type ConnectionState,
} from "@/contexts/acp-connections-context"

type WaitingConnection = Pick<
  ConnectionState,
  | "pendingPermission"
  | "pendingQuestion"
  | "pendingAskQuestion"
  | "pendingPlanApproval"
>

const NO_SUBSCRIPTION = () => () => {}
const NOT_WAITING = () => false

export function hasPendingUserInput(
  connection: WaitingConnection | null | undefined
): boolean {
  return Boolean(
    connection?.pendingPermission ||
    connection?.pendingQuestion ||
    connection?.pendingAskQuestion ||
    connection?.pendingPlanApproval
  )
}

export function useConnectionWaiting(contextKey: string): boolean {
  const store = useOptionalConnectionStore()
  const subscribe = useCallback(
    (notify: () => void) =>
      store ? store.subscribeKey(contextKey, notify) : NO_SUBSCRIPTION(),
    [contextKey, store]
  )
  const getSnapshot = useCallback(
    () => hasPendingUserInput(store?.getConnection(contextKey)),
    [contextKey, store]
  )

  // Sidebar and tab-strip snapshots may render before the connection store exists.
  return useSyncExternalStore(subscribe, getSnapshot, NOT_WAITING)
}
