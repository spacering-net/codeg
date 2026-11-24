"use client"

import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import type { FolderDetail } from "@/lib/types"

/**
 * The project a folder belongs to: the folder itself, or — for a worktree — the
 * root it was created under. `parent_id` is flattened (a worktree of a worktree
 * still points at the original root), so one hop always reaches it, even when
 * that root is no longer open in the sidebar.
 *
 * `null` for a chat folder: folderless chat conversations have no project.
 */
export function projectFolderIdOf(folder: FolderDetail | null): number | null {
  if (folder == null || folder.kind !== "regular") return null
  return folder.parent_id ?? folder.id
}

/**
 * The project folder the active conversation belongs to (see
 * `projectFolderIdOf`). Task boards, automations and the repository panel all
 * bind to project roots, which is why the aux panel's work tabs follow this
 * rather than the active folder: a conversation in a worktree still shows its
 * project's tasks, automations, issues and pull requests.
 *
 * A primitive out of the selector, so a re-render only follows a change of
 * project — not every folder-list update or a switch between two worktrees of
 * the same repository.
 */
export function useActiveProjectFolderId(): number | null {
  return useAppWorkspaceStore((s) => {
    if (s.activeFolderId == null) return null
    const folder = s.allFolders.find((f) => f.id === s.activeFolderId)
    return projectFolderIdOf(folder ?? null)
  })
}
