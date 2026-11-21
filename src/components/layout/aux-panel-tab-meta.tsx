"use client"

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import {
  CircleDot,
  Folder,
  FolderPen,
  GitCommit,
  GitPullRequestArrow,
  ListTodo,
  ReceiptText,
  Zap,
  type LucideIcon,
} from "lucide-react"
import { useActiveProjectFolderId } from "@/hooks/use-active-project-folder"
import { useFolderForgeProvider } from "@/lib/forge-provider-cache"
import type { AuxPanelTab } from "@/lib/aux-panel-tab-order"

// The shared identity of the aux tabs — glyph, label, and which ones apply —
// lived in aux-panel.tsx beside the switchers; it now sits here so the panel's
// rail and the collapsed strip at the window's edge read from one source and
// can never drift.

// Icon for every aux tab. The desktop rail and the mobile tab row both map the
// stored order (see `aux-panel-tab-order.ts`) over these, so the two surfaces
// can never drift.
// The work tabs wear the left sidebar's own glyphs for the same pages
// (automations, to-dos) and the repository panel's state glyphs for an open
// issue and an open pull request.
export const TAB_ICONS: Record<AuxPanelTab, LucideIcon> = {
  session_details: ReceiptText,
  file_tree: Folder,
  changes: FolderPen,
  git_log: GitCommit,
  automations: Zap,
  tasks: ListTodo,
  issues: CircleDot,
  pull_requests: GitPullRequestArrow,
}

// The three folder-content tabs share one label namespace (Folder.auxPanel.tabs);
// session details resolves from its own (Folder.sessionDetails.menuLabel), and
// the work tabs are named exactly as the pages they mirror. The value type is
// the literal key union so next-intl's typed `t()` accepts it.
const FOLDER_TAB_LABEL_KEY: Record<
  "file_tree" | "changes" | "git_log",
  "files" | "changes" | "commits"
> = {
  file_tree: "files",
  changes: "changes",
  git_log: "commits",
}

/**
 * Decide which aux-panel tabs are available and which to actually show.
 *
 * The folder-scoped tabs (files/changes/commits, and the project's automations,
 * tasks, issues and pull requests) only make sense with a real folder
 * workspace open, so chat sessions and the folderless state collapse to just
 * the Session Details tab. `effectiveTab` keeps the rendered selection
 * valid even when the stored `activeTab` is a now-hidden folder tab, avoiding a
 * one-frame flash before the reconciling effect corrects the stored value.
 */
export function resolveAuxTabView(
  activeTab: AuxPanelTab,
  activeFolderId: number | null,
  isChatMode: boolean
): { showFolderTabs: boolean; effectiveTab: AuxPanelTab } {
  const showFolderTabs = activeFolderId != null && !isChatMode
  return {
    showFolderTabs,
    effectiveTab: showFolderTabs ? activeTab : "session_details",
  }
}

/**
 * Name every aux tab, for whichever switcher lists them.
 *
 * GitLab calls them merge requests, GitHub and Gitea pull requests: the tab
 * is named for the forge the project's remote is on, as the repository
 * panel's own switcher is. `active` gates that lookup — pass whether a switcher
 * this label feeds is actually rendered, so the fold and the chat-mode collapse
 * don't ask about a forge nobody is looking at.
 */
export function useAuxTabLabel(active: boolean): (tab: AuxPanelTab) => string {
  const t = useTranslations("Folder.auxPanel.tabs")
  const tDetails = useTranslations("Folder.sessionDetails")
  const tAutomations = useTranslations("Automations")
  const tTasks = useTranslations("Tasks")
  const tForge = useTranslations("Forge")
  const projectFolderId = useActiveProjectFolderId()
  const forgeProvider = useFolderForgeProvider(active ? projectFolderId : null)

  return useCallback(
    (tab: AuxPanelTab) => {
      switch (tab) {
        case "session_details":
          return tDetails("menuLabel")
        case "automations":
          return tAutomations("title")
        case "tasks":
          return tTasks("title")
        case "issues":
          return tForge("tabIssues")
        case "pull_requests":
          return tForge(
            forgeProvider === "gitlab" || forgeProvider === "cnb"
              ? "tabMrs"
              : "tabPrs"
          )
        default:
          return t(FOLDER_TAB_LABEL_KEY[tab])
      }
    },
    [t, tDetails, tAutomations, tTasks, tForge, forgeProvider]
  )
}
