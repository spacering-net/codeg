"use client"

import type { ComponentType } from "react"
import {
  useWorkbenchRoute,
  type WorkbenchRouteId,
} from "@/contexts/workbench-route-context"
import {
  AutomationsPage,
  AutomationsPageTitle,
} from "@/components/automations/automations-page"
import { CanvasPage, CanvasPageTitle } from "@/components/canvas/canvas-page"
import { ForgeChromeActions } from "@/components/forge/forge-chrome-actions"
import { ForgePage, ForgePageTitle } from "@/components/forge/forge-page"
import {
  PersonalAgentChromeActions,
  PersonalAgentPage,
  PersonalAgentPageTitle,
} from "@/components/personal-agent/personal-agent-page"
import { TasksChromeActions } from "@/components/tasks/tasks-chrome-actions"
import { TasksPage, TasksPageTitle } from "@/components/tasks/tasks-page"
import {
  TokenUsagePage,
  TokenUsagePageTitle,
} from "@/components/token-usage/token-usage-page"

/**
 * Registry of full-page routes that take over the main content region. The
 * `"conversations"` route is the default workspace and is intentionally absent
 * here — it is the fallback rendered underneath. To add a new left-sidebar
 * route: extend WorkbenchRouteId, add an entry below, and add a SidebarNavButton
 * that calls `setRoute("<id>")`.
 */
const WORKBENCH_ROUTES: Partial<Record<WorkbenchRouteId, ComponentType>> = {
  personalAgent: PersonalAgentPage,
  automations: AutomationsPage,
  tasks: TasksPage,
  forge: ForgePage,
  tokenUsage: TokenUsagePage,
  canvas: CanvasPage,
}

/** Optional per-route content for the window-chrome strip above the page
 *  (the h-10 band the fixed corner overlays sit on) — e.g. the page title. */
const WORKBENCH_ROUTE_STRIPS: Partial<Record<WorkbenchRouteId, ComponentType>> =
  {
    personalAgent: PersonalAgentPageTitle,
    automations: AutomationsPageTitle,
    tasks: TasksPageTitle,
    forge: ForgePageTitle,
    tokenUsage: TokenUsagePageTitle,
    canvas: CanvasPageTitle,
  }

/** Routes that draw the desktop's window-chrome band themselves, their title
 *  in it (see `WorkbenchBand`): the personal agent's page, whose side panel
 *  has its strip in that band. Their entry above still titles a narrow
 *  screen's bar. */
const WORKBENCH_ROUTES_DRAWING_BAND: ReadonlySet<WorkbenchRouteId> = new Set([
  "personalAgent",
])

/** What a chrome cluster hands its route's buttons: the host's own button
 *  metrics, so one component fits both the desktop overlay (`h-6`) and the
 *  mobile title bar (`h-8`) without knowing which it is in. */
export interface WorkbenchChromeActionsProps {
  buttonClassName: string
  iconClassName: string
}

/** Optional per-route buttons for the window's top-right chrome cluster, drawn
 *  to the LEFT of the settings gear. A full-page route hides the terminal and
 *  aux toggles (they act on the workspace it covers), so its own page-level
 *  controls take that space instead of crowding the page. */
const WORKBENCH_ROUTE_CHROME_ACTIONS: Partial<
  Record<WorkbenchRouteId, ComponentType<WorkbenchChromeActionsProps>>
> = {
  personalAgent: PersonalAgentChromeActions,
  forge: ForgeChromeActions,
  tasks: TasksChromeActions,
}

/**
 * Renders the active non-conversation route page, or nothing when the
 * conversation workspace is active. WorkspaceContent overlays this on top of the
 * (kept-mounted, hidden) conversation surface so live sessions survive the swap.
 */
export function WorkbenchRoutePage() {
  const { routeId } = useWorkbenchRoute()
  const Page = WORKBENCH_ROUTES[routeId]
  return Page ? <Page /> : null
}

/** The active route's strip content (page title), or nothing. */
export function WorkbenchRouteStrip() {
  const { routeId } = useWorkbenchRoute()
  const Strip = WORKBENCH_ROUTE_STRIPS[routeId]
  return Strip ? <Strip /> : null
}

/** The active route's chrome-cluster buttons, or nothing. Rendered by both
 *  chrome hosts (RightEdgeChrome on desktop, FolderTitleBar on mobile). */
export function WorkbenchRouteChromeActions(
  props: WorkbenchChromeActionsProps
) {
  const { routeId } = useWorkbenchRoute()
  const Actions = WORKBENCH_ROUTE_CHROME_ACTIONS[routeId]
  return Actions ? <Actions {...props} /> : null
}

/** Whether the active route contributes chrome-strip content — lets the host
 *  style the band (e.g. its bottom border) only when a title renders. */
export function useHasWorkbenchRouteStrip(): boolean {
  const { routeId } = useWorkbenchRoute()
  return WORKBENCH_ROUTE_STRIPS[routeId] != null
}

/** Whether the active route draws the desktop band itself: the desktop host
 *  then leaves the band out and hands the route its slots instead
 *  (`WorkbenchBandContext`). */
export function useWorkbenchRouteDrawsBand(): boolean {
  const { routeId } = useWorkbenchRoute()
  return WORKBENCH_ROUTES_DRAWING_BAND.has(routeId)
}
