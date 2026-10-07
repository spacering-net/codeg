"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import { workTaskList } from "@/lib/api"
import { notifyDesktop } from "@/lib/desktop-notification"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import {
  loadTasksViewMode,
  saveTasksViewMode,
  type TasksViewMode,
} from "@/lib/tasks-board-filter-storage"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import type { WorkTask } from "@/lib/types"

const WORK_TASK_CHANGED_EVENT = "task://changed"

/** Statuses that need the user ("等你处理") — drives the sidebar badge. */
const ATTENTION_STATUSES = new Set(["awaiting_input", "review", "failed"])

interface TasksViewContextValue {
  tasks: WorkTask[]
  /** Count of tasks waiting on the user — the sidebar badge. */
  attentionCount: number
  /** True until the first fetch settles (success OR failure). Lets the board
   *  tell "still loading" from "genuinely empty" and show a skeleton instead of
   *  flashing the empty state. Never flips back on later refetches — those
   *  update an already-painted board. */
  loading: boolean
  refetch: () => Promise<void>
  /** Board ⇄ list. Lifted here rather than owned by TasksPage because the
   *  switch renders in the window-chrome strip (TasksPageTitle) — a different
   *  branch of the tree — while the layout it drives renders in the page. */
  viewMode: TasksViewMode
  setViewMode: (mode: TasksViewMode) => void
}

const TasksViewContext = createContext<TasksViewContextValue | null>(null)

/**
 * Data layer for the Tasks feature: the full task list + a realtime
 * subscription, kept always-mounted so the sidebar's attention badge stays
 * live. Single source for both the badge and the Tasks route page (the board
 * filters per folder client-side). Mirrors AutomationsViewProvider: the engine
 * runs headless, so `task://changed` nudges + refetch are the only way an open
 * board learns a task advanced.
 */
export function useTasksView() {
  const ctx = useContext(TasksViewContext)
  if (!ctx) {
    throw new Error("useTasksView must be used within TasksViewProvider")
  }
  return ctx
}

export function TasksViewProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("Tasks")
  // Latest-ref so `refetch` stays referentially stable across locale changes
  // (its identity re-subscribes the event channel). Synced in an effect —
  // writing during render trips react-hooks/refs.
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])
  const [tasks, setTasks] = useState<WorkTask[]>([])
  const [loading, setLoading] = useState(true)
  // Restored synchronously from localStorage: the Tasks route mounts only after
  // a client-side route switch (never prerendered), so there is no SSR markup to
  // mismatch — and the page paints in the remembered mode right away.
  const [viewMode, setViewMode] = useState<TasksViewMode>(loadTasksViewMode)
  useEffect(() => {
    saveTasksViewMode(viewMode)
  }, [viewMode])
  const reqRef = useRef(0)
  // Statuses as of the last successful fetch; null until then, so the first
  // load (pure history) never notifies.
  const prevStatusRef = useRef<Map<number, WorkTask["status"]> | null>(null)

  const refetch = useCallback(async () => {
    const id = ++reqRef.current
    try {
      const list = await workTaskList(null)
      // Drop stale responses; keep the previous list on transient error rather
      // than blanking the board (same idiom as automations-view-context).
      if (id !== reqRef.current) return
      notifyFlips(prevStatusRef.current, list, tRef.current)
      prevStatusRef.current = new Map(
        list.map((task) => [task.id, task.status])
      )
      setTasks(list)
      setLoading(false)
    } catch {
      // ignore — a later event/refetch recovers. A failed FIRST fetch still
      // ends the loading state (unless a newer one is already in flight): the
      // board falls back to its empty state rather than pulsing forever.
      if (id === reqRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Initial fetch + subscribe for backend-pushed nudges. Same
    // subscribe-then-setState idiom as automations-view-context.
    /* eslint-disable react-hooks/set-state-in-effect */
    void refetch()
    let unsub: (() => void) | undefined
    let cancelled = false
    void subscribe(WORK_TASK_CHANGED_EVENT, () => {
      void refetch()
    }).then((u: () => void) => {
      if (cancelled) u()
      else unsub = u
    })
    // Events fired while the WS was disconnected are dropped by the
    // broadcaster; refetch on reconnect so a task that settled during the gap
    // doesn't leave the board stale. No-op on desktop IPC.
    const offReconnect = onTransportReconnect(() => {
      void refetch()
    })
    return () => {
      cancelled = true
      unsub?.()
      offReconnect?.()
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [refetch])

  const attentionCount = useMemo(
    () =>
      tasks.filter(
        (t) => ATTENTION_STATUSES.has(t.status) && t.archived_at == null
      ).length,
    [tasks]
  )

  const value = useMemo<TasksViewContextValue>(
    () => ({ tasks, attentionCount, loading, refetch, viewMode, setViewMode }),
    [tasks, attentionCount, loading, refetch, viewMode]
  )

  return (
    <TasksViewContext.Provider value={value}>
      {children}
    </TasksViewContext.Provider>
  )
}

/**
 * System notification when a task flips into review (ready for acceptance) or
 * failed. The engine runs headless, so this fetch-to-fetch diff is the only
 * place that sees the transition; the window-state gate and the user's
 * per-event switch live inside `notifyDesktop`.
 */
function notifyFlips(
  prev: Map<number, WorkTask["status"]> | null,
  list: WorkTask[],
  t: (
    key:
      | "notifyReview"
      | "notifyFailed"
      | "notifyReviewRedacted"
      | "notifyFailedRedacted",
    values?: { title: string }
  ) => string
) {
  if (prev == null) return
  for (const task of list) {
    if (prev.get(task.id) === task.status) continue
    if (task.status !== "review" && task.status !== "failed") continue
    if (task.archived_at != null) continue
    const folder = useAppWorkspaceStore
      .getState()
      .folders.find((f) => f.id === task.folder_id)
    const folderName = folder ? (folder.alias ?? folder.name) : null
    const title = folderName ? `${folderName} - Codeg` : "Codeg"
    const review = task.status === "review"
    void notifyDesktop("work_task", {
      title,
      body: review
        ? t("notifyReview", { title: task.title })
        : t("notifyFailed", { title: task.title }),
      // The task title is user-authored prose that can name a customer, a
      // ticket or an incident — not something to leave sitting in an OS
      // notification centre when the user asked for contents to be hidden.
      redactedBody: review
        ? t("notifyReviewRedacted")
        : t("notifyFailedRedacted"),
    })
  }
}
