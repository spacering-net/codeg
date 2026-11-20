"use client"

import { useEffect } from "react"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabActions } from "@/contexts/tab-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { subscribe } from "@/lib/platform"
import { FOLDER_OPEN_IN_WORKSPACE_EVENT } from "@/lib/api"
import type { FolderDetail } from "@/lib/types"

/**
 * Surfaces folders opened from the project launcher (a separate window/tab).
 * The launcher scaffolds a project; the backend upserts the folder and emits
 * `folder://open-in-workspace`. Here we add it to this workspace and open a
 * draft conversation tab so it lands focused.
 *
 * Routing is handled by the transport: `subscribe()` binds to this window's
 * own backend (the local Tauri bus, or the server's WebSocket for web/remote),
 * so only windows talking to the backend that opened the folder react — no
 * manual connection filtering needed. The detail rides on the event, so no
 * extra round-trip is required to apply it.
 */
export function WorkspaceOpenFolderListener() {
  const { openNewConversationTab } = useTabActions()
  const { openConversations } = useWorkbenchRoute()

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void (async () => {
      const dispose = await subscribe<FolderDetail>(
        FOLDER_OPEN_IN_WORKSPACE_EVENT,
        (detail) => {
          const store = useAppWorkspaceStore.getState()
          store.upsertFolder(detail)
          store.setBranch(detail.id, detail.git_branch ?? null)
          // Return to the conversation workspace if a route (e.g. Automations)
          // was covering the content region, else the new tab opens unseen.
          openConversations()
          openNewConversationTab(detail.id, detail.path, {
            reuseBlankDraft: true,
          })
          void store.refreshConversations()
        }
      )
      // The effect may have torn down while the async subscribe was in
      // flight; dispose immediately so we don't leak a subscription.
      if (disposed) dispose()
      else unlisten = dispose
    })()

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [openNewConversationTab, openConversations])

  return null
}
