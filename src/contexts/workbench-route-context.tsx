"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import { getActiveRemoteConnectionId } from "@/lib/transport"
import { useWorkbenchRouteStore } from "@/stores/workbench-route-store"

/**
 * The view occupying the main content region. `"conversations"` is the default
 * workspace (folder/conversation tabs); every other id is a full-page "route"
 * rendered in place of it (see WORKBENCH_ROUTES in workbench-content.tsx).
 *
 * To add a future left-sidebar route: extend this union, register a page
 * component in WORKBENCH_ROUTES, and add a SidebarNavButton that calls
 * `setRoute("<id>")`. Nothing else needs to change.
 */
export type WorkbenchRouteId =
  | "conversations"
  | "personalAgent"
  | "automations"
  | "tasks"
  | "forge"
  | "tokenUsage"
  | "canvas"
  | "harness"

interface WorkbenchRouteContextValue {
  routeId: WorkbenchRouteId
  /** Convenience for the common branch — `routeId === "conversations"`. */
  isConversations: boolean
  setRoute: (id: WorkbenchRouteId) => void
  /** Sugar for returning to the conversation workspace. */
  openConversations: () => void
}

const WorkbenchRouteContext = createContext<WorkbenchRouteContextValue | null>(
  null
)

/**
 * Drives which view fills the main content region. This mirrors the codebase's
 * lifted-state idiom (search-dialog-context): the trigger lives in the sidebar
 * (which unmounts when collapsed) while the content swap is owned by
 * WorkspaceContent — both read this single source of truth.
 *
 * State is in-memory, but for one thing kept for next time: which of the two
 * home views — the conversations or the assistants page — was shown last,
 * which the window opens on again (a reload included). Every other route is
 * a place visited from one of them and is not kept. Static export rules out
 * URL route segments, and the established pattern here is in-memory context
 * rather than query params.
 */
export function useWorkbenchRoute() {
  const ctx = useOptionalWorkbenchRoute()
  if (!ctx) {
    throw new Error(
      "useWorkbenchRoute must be used within WorkbenchRouteProvider"
    )
  }
  return ctx
}

/**
 * The route, or `null` outside the workspace layout.
 *
 * Null is a supported answer, not a failure: transcript surfaces also render
 * in windows that have no workbench at all (the pet panel, the standalone
 * commit / merge windows), and asking "is the file column reachable from
 * here?" has to be answerable there too — see `use-open-file-target.ts`.
 */
export function useOptionalWorkbenchRoute(): WorkbenchRouteContextValue | null {
  return useContext(WorkbenchRouteContext)
}

/** The home views: the one shown last is opened on next time. */
const HOME_ROUTES: ReadonlySet<WorkbenchRouteId> = new Set([
  "conversations",
  "personalAgent",
])

/** Per backend: a remote workspace's window keeps its own. */
function lastViewKey(): string {
  const remoteId = getActiveRemoteConnectionId()
  return `workspace:last-view:${remoteId ? `remote-${remoteId}` : "local"}`
}

/** The home view shown last here, or the conversations. */
export function lastHomeRoute(): WorkbenchRouteId {
  try {
    const kept = window.localStorage.getItem(lastViewKey())
    return kept === "personalAgent" ? kept : "conversations"
  } catch {
    return "conversations"
  }
}

function keepHomeRoute(id: WorkbenchRouteId) {
  if (!HOME_ROUTES.has(id)) return
  try {
    window.localStorage.setItem(lastViewKey(), id)
  } catch {
    // Not kept; this window shows it all the same.
  }
}

export function WorkbenchRouteProvider({ children }: { children: ReactNode }) {
  const [routeId, setRouteId] = useState<WorkbenchRouteId>(() =>
    typeof window === "undefined" ? "conversations" : lastHomeRoute()
  )
  useEffect(() => keepHomeRoute(routeId), [routeId])

  const setRoute = useCallback((id: WorkbenchRouteId) => setRouteId(id), [])
  const openConversations = useCallback(() => setRouteId("conversations"), [])
  // Told outside React too: the presence heartbeat reports the session in
  // front only while the conversations are what this window shows.
  useEffect(() => {
    useWorkbenchRouteStore.setState({ route: routeId })
    return () => useWorkbenchRouteStore.setState({ route: null })
  }, [routeId])

  const value = useMemo<WorkbenchRouteContextValue>(
    () => ({
      routeId,
      isConversations: routeId === "conversations",
      setRoute,
      openConversations,
    }),
    [routeId, setRoute, openConversations]
  )

  return (
    <WorkbenchRouteContext.Provider value={value}>
      {children}
    </WorkbenchRouteContext.Provider>
  )
}
