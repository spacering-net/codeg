"use client"

import { useCallback } from "react"

import { useSessionViewerHost } from "@/components/message/session-viewer-host-context"
import { useOptionalWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useWorkspaceActions } from "@/contexts/workspace-context"

interface OpenFileTargetOptions {
  line?: number | null
  folderId?: number
  /** Show this ready-made unified diff instead of the file's current bytes
   *  (the reply's "view diff" action). */
  diff?: { content: string; groupLabel: string }
}

/**
 * Where a file affordance clicked in a transcript should land.
 *
 * The default answer is the workspace file column — that is what
 * `openFilePreview` / `openSessionFileDiff` have always done, and where the
 * file stays open afterwards. But the column is only on screen on the
 * conversations route: a full-page workbench route (the task board, the
 * infinite canvas, automations, forge) covers the whole workspace, and a
 * transcript is perfectly readable from inside one — the task detail sheet's
 * session viewer and the canvas card both show messages there. A file badge
 * clicked in that situation used to open a tab in a column the user could not
 * see, so the click looked broken.
 *
 * So on those routes the file opens as a side panel next to the transcript
 * instead (`file-viewer-drawer.tsx`). For a plain file it is still the same
 * workspace file tab underneath — the panel is a view of it — so nothing is
 * lost by taking this branch, and "Open in workspace" leads back to the column.
 *
 * Both conditions are required. Without a viewer host there is nothing to
 * render the panel (a transcript rendered outside `MessageListView`, e.g. the
 * grok child transcript, has none) and the file column is still the better
 * answer of the two; outside the workspace layout altogether there is no route
 * to consult and no column to hide, so the default stands.
 *
 * ONE entry point for both a file and a diff on purpose: they sit side by side
 * in the same action row (`reply-artifacts.tsx`), and routing only one of them
 * is how the diff action was left silently failing on those very routes.
 */
export function useOpenFileTarget() {
  const { openFilePreview, openSessionFileDiff } = useWorkspaceActions()
  const route = useOptionalWorkbenchRoute()
  const viewerHost = useSessionViewerHost()
  const fileColumnVisible = route ? route.isConversations : true

  return useCallback(
    async (path: string, options?: OpenFileTargetOptions): Promise<void> => {
      if (!fileColumnVisible && viewerHost) {
        viewerHost.open({
          kind: "file",
          path,
          line: options?.line ?? null,
          folderId: options?.folderId,
          diff: options?.diff,
        })
        return
      }
      if (options?.diff) {
        openSessionFileDiff(
          path,
          options.diff.content,
          options.diff.groupLabel,
          { folderId: options.folderId }
        )
        return
      }
      await openFilePreview(path, {
        line: options?.line ?? undefined,
        folderId: options?.folderId,
      })
    },
    [fileColumnVisible, openFilePreview, openSessionFileDiff, viewerHost]
  )
}
