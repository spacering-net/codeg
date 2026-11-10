"use client"

import { useCallback, useState } from "react"
import { ForgePage } from "@/components/forge/forge-page"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useActiveProjectFolderId } from "@/hooks/use-active-project-folder"
import { useAuxTabActive } from "@/hooks/use-aux-tab-active"
import type { AuxPanelTab } from "@/lib/aux-panel-tab-order"
import { saveForgeFolderId, saveForgeTab } from "@/lib/forge-list-prefs"
import type { ForgeTab } from "@/lib/types"
import { AuxPanelNoFolderEmpty } from "./aux-panel-no-folder-empty"

/**
 * The aux panel's Issues and Pull requests tabs: the repository panel's own
 * list (`ForgePage`, embedded), locked to the project the active conversation
 * belongs to and to one kind of item.
 *
 * The list follows the active project ONLY while the tab is on screen. Tab
 * bodies stay mounted once opened, and the active folder changes with every
 * conversation-tab switch — so a list that followed behind a hidden tab would
 * re-mount, re-resolve the remote and re-read the labels on each switch, and
 * spend the forge's search quota (thirty calls a minute on GitHub) on pages
 * nobody looks at. While hidden the page also asks for nothing itself (its
 * `active` flag); shown again, it catches up — on the new project if the
 * conversation moved, and otherwise with one reload of the page it holds.
 */
export function ForgeAuxTab({
  auxTab,
  forgeTab,
}: {
  auxTab: Extract<AuxPanelTab, "issues" | "pull_requests">
  forgeTab: ForgeTab
}) {
  const active = useAuxTabActive(auxTab)
  const projectFolderId = useActiveProjectFolderId()
  const { setRoute } = useWorkbenchRoute()

  // The project the list is showing. Adjusted during render rather than in an
  // effect, so the list never paints a frame on the project it is leaving.
  const [folderId, setFolderId] = useState(projectFolderId)
  if (active && folderId !== projectFolderId) setFolderId(projectFolderId)

  const openFullPage = useCallback(() => {
    // The panel reads both back on mount: it opens on this project, on this
    // half of the switcher.
    if (folderId != null) saveForgeFolderId(folderId)
    saveForgeTab(forgeTab)
    setRoute("forge")
  }, [folderId, forgeTab, setRoute])

  if (folderId == null) return <AuxPanelNoFolderEmpty />

  return (
    // Keyed by project: another repository is another list, not a page of
    // this one, so everything held about the old one — page number, filters,
    // the rows noted from writes — starts over with it.
    <ForgePage
      key={folderId}
      embed={{
        folderId,
        tab: forgeTab,
        active,
        onOpenFullPage: openFullPage,
      }}
    />
  )
}
