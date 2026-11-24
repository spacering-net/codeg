"use client"

import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useOptionalWorkbenchRoute } from "@/contexts/workbench-route-context"
import type { AuxPanelTab } from "@/lib/aux-panel-tab-order"

/**
 * Whether an aux-panel tab is on screen right now: the panel is open, the tab
 * is the selected one, and no full-page workbench route has collapsed the
 * panel out of view.
 *
 * Tab bodies stay mounted once opened (`forceMount`), and the panel stays
 * mounted — at zero width — while a workbench route covers the workspace, so
 * "mounted" says nothing about "seen". A tab whose work costs something per
 * change (a forge request on every folder switch, say) asks this before doing
 * it.
 */
export function useAuxTabActive(tab: AuxPanelTab): boolean {
  const { isOpen, activeTab } = useAuxPanelContext()
  const route = useOptionalWorkbenchRoute()
  return isOpen && activeTab === tab && (route?.isConversations ?? true)
}
