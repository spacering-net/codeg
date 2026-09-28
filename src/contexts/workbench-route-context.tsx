"use client"

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react"

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
  | "automations"
  | "tasks"
  | "forge"
  | "tokenUsage"
  | "canvas"

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
 * State is in-memory only: a reload lands back on the conversation workspace.
 * That is deliberate; static export rules out URL route segments, and the
 * established pattern here is in-memory context rather than query params.
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

export function WorkbenchRouteProvider({ children }: { children: ReactNode }) {
  const [routeId, setRouteId] = useState<WorkbenchRouteId>("conversations")

  const setRoute = useCallback((id: WorkbenchRouteId) => setRouteId(id), [])
  const openConversations = useCallback(() => setRouteId("conversations"), [])

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
