"use client"

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import type { DelegationStatusIndex } from "@/lib/delegation-status-index"

/**
 * A row the user has started answering a task's decision in: it keeps the
 * decision while one it was taken on is still pending, rather than the
 * decision moving to the task's newest row under the user's hands when the
 * agent polls again — the question and plan cards keep their unsent answers
 * in their own state, and a move would drop them along with the focus.
 */
export interface DelegationDecisionHold {
  /** The holding row's own id (`useId`), stable while it stays mounted. */
  token: string
  /** The decisions (`BlockingPrompts.ids`) showing when it was taken. */
  ids: readonly string[]
}

interface DelegationStatusContextValue {
  index: DelegationStatusIndex
  held: ReadonlyMap<string, DelegationDecisionHold>
  hold: (taskId: string, token: string, ids: readonly string[]) => void
  release: (taskId: string, token: string) => void
}

/**
 * The transcript's `get_delegation_status` index (see
 * `@/lib/delegation-status-index`): for each task, which status row is its
 * newest — and the row, if any, the user is answering its decision in.
 * Provided once per transcript (`MessageListView`, the sub-agent session
 * viewer) and read by `DelegationStatusRow`, so only one row reaches the live
 * sub-agent and carries the decision it is parked on.
 *
 * A context rather than a prop for the same reason as `ModelLabelContext`: the
 * memoized message groups between the two never read it themselves.
 */
const DelegationStatusContext =
  createContext<DelegationStatusContextValue | null>(null)

const NO_HOLDS: ReadonlyMap<string, DelegationDecisionHold> = new Map()

export function DelegationStatusIndexProvider({
  value,
  children,
}: {
  value: DelegationStatusIndex
  children: ReactNode
}) {
  // State of the provider itself: a hold re-renders the rows that read it,
  // not the thread passed in as `children`.
  const [held, setHeld] = useState(NO_HOLDS)
  const hold = useCallback(
    (taskId: string, token: string, ids: readonly string[]) =>
      setHeld((prev) => {
        const current = prev.get(taskId)
        if (
          current?.token === token &&
          current.ids.length === ids.length &&
          current.ids.every((id, i) => id === ids[i])
        ) {
          return prev
        }
        const next = new Map(prev)
        next.set(taskId, { token, ids })
        return next
      }),
    []
  )
  const release = useCallback(
    (taskId: string, token: string) =>
      setHeld((prev) => {
        if (prev.get(taskId)?.token !== token) return prev
        const next = new Map(prev)
        next.delete(taskId)
        return next
      }),
    []
  )
  const context = useMemo(
    () => ({ index: value, held, hold, release }),
    [value, held, hold, release]
  )
  return (
    <DelegationStatusContext.Provider value={context}>
      {children}
    </DelegationStatusContext.Provider>
  )
}

/** `null` outside a transcript that indexes its polls — then every row is its
 *  own newest, as a lone card is, and nothing is held. */
export function useDelegationStatusContext(): DelegationStatusContextValue | null {
  return useContext(DelegationStatusContext)
}
