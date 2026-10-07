"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react"
import type { FixActionKind } from "@/lib/types"

export type AlertLevel = "error" | "warning"

/**
 * A button on an alert: either a preflight fix (`kind` + JSON `payload`, run
 * by the status-bar list itself) or a plain callback for alerts raised in
 * code that already knows what the button does.
 */
export type AlertAction =
  | { label: string; kind: FixActionKind; payload: string }
  | { label: string; run: () => void }

export interface Alert {
  id: string
  /** Identity of the message, when it has one: an alert recorded again under
   *  the same key replaces the earlier one instead of stacking a duplicate. */
  key?: string
  level: AlertLevel
  message: string
  detail?: string
  actions?: AlertAction[]
  /** Raw diagnostic evidence backing the alert (e.g. a command's stderr
   *  tail). Kept out of `detail`, which is always visible: evidence is
   *  multi-line machine output, so the alert list renders it behind a collapsed
   *  disclosure instead of dumping it inline. */
  evidence?: string
  timestamp: number
}

/** What a caller records; the store stamps the id and the time. */
export type AlertInput = Omit<Alert, "id" | "timestamp">

interface AlertContextValue {
  alerts: Alert[]
  hasAlerts: boolean
  pushAlert: (
    level: AlertLevel,
    message: string,
    detail?: string,
    actions?: AlertAction[],
    evidence?: string
  ) => string
  dismissAlert: (id: string) => void
  clearAll: () => void
}

type Action =
  | { type: "push"; alert: Alert }
  | { type: "dismiss"; id: string }
  | { type: "clear_all" }

let seq = 0
const MAX_ALERTS = 50

function reducer(state: Alert[], action: Action): Alert[] {
  switch (action.type) {
    case "push": {
      const { alert } = action
      // A keyed alert replaces its predecessor and moves to the newest slot —
      // the list reads oldest to newest, and this is the latest occurrence.
      // The predecessor's id is kept, so the row updates instead of remounting.
      const at =
        alert.key === undefined
          ? -1
          : state.findIndex((a) => a.key === alert.key)
      const next =
        at < 0
          ? [...state, alert]
          : [
              ...state.slice(0, at),
              ...state.slice(at + 1),
              { ...alert, id: state[at].id },
            ]
      return next.length > MAX_ALERTS ? next.slice(-MAX_ALERTS) : next
    }
    case "dismiss":
      return state.filter((a) => a.id !== action.id)
    case "clear_all":
      return []
  }
}

// The mounted provider's writer (see `recordAlert`).
let alertSink: ((input: AlertInput) => void) | null = null

/**
 * Record an alert from anywhere — including code with no React context of its
 * own, like the ACP event pump or a toast button's callback. The mounted
 * `AlertProvider` is the store; with none mounted (another window, a test) it
 * is a no-op, the way `toast()` is without a `<Toaster>`.
 */
export function recordAlert(input: AlertInput): void {
  alertSink?.(input)
}

const AlertContext = createContext<AlertContextValue | null>(null)

export function useAlertContext() {
  const ctx = useContext(AlertContext)
  if (!ctx) {
    throw new Error("useAlertContext must be used within AlertProvider")
  }
  return ctx
}

export function AlertProvider({ children }: { children: ReactNode }) {
  const [alerts, dispatch] = useReducer(reducer, [])

  const record = useCallback((input: AlertInput) => {
    const id = `alert-${++seq}-${Date.now()}`
    dispatch({
      type: "push",
      alert: { ...input, id, timestamp: Date.now() },
    })
    return id
  }, [])

  useEffect(() => {
    alertSink = record
    return () => {
      if (alertSink === record) alertSink = null
    }
  }, [record])

  const pushAlert = useCallback(
    (
      level: AlertLevel,
      message: string,
      detail?: string,
      actions?: AlertAction[],
      evidence?: string
    ) => record({ level, message, detail, actions, evidence }),
    [record]
  )

  const dismissAlert = useCallback((id: string) => {
    dispatch({ type: "dismiss", id })
  }, [])

  const clearAll = useCallback(() => {
    dispatch({ type: "clear_all" })
  }, [])

  const hasAlerts = alerts.length > 0

  const value = useMemo(
    () => ({ alerts, hasAlerts, pushAlert, dismissAlert, clearAll }),
    [alerts, hasAlerts, pushAlert, dismissAlert, clearAll]
  )

  return <AlertContext.Provider value={value}>{children}</AlertContext.Provider>
}
