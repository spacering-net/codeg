/**
 * The workbench's route, for code outside React (the presence heartbeat):
 * which view fills this window's main region, or `null` in a window with no
 * workbench. `WorkbenchRouteProvider` keeps it; nothing else writes it.
 */

import { create } from "zustand"

import type { WorkbenchRouteId } from "@/contexts/workbench-route-context"

interface WorkbenchRouteState {
  route: WorkbenchRouteId | null
}

export const useWorkbenchRouteStore = create<WorkbenchRouteState>()(() => ({
  route: null,
}))
